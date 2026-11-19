/**
 * notify_operator and notifications_list through callTool (ops/core/notify.ts, E21), and the notify sinks in the
 * machine config. A notification is recorded in control/notifications.jsonl and the machine feed with no sink at all;
 * with sinks it goes to each (tsf: a local HTTP server stands in for the TSF; file; command), and a failing sink is
 * named in the result while the others still get it. Secrets are redacted everywhere.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig, publicConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { notificationsPath } from "../../ops/core/notify.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { readFeed } from "../../runtime/feed.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { freePort, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-notify");
after(() => tmp.remove());
const none = join(tmp.dir, "absent.yml");
let n = 0;

/** A CLI context on its own runs directory, with `notify` as the --config layer's sinks. */
function setup(notify = "", env: NodeJS.ProcessEnv = {}) {
  const root = join(tmp.dir, `n-${++n}`);
  const runsDir = join(root, "runs");
  const layer = `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n${notify}`;
  const file = join(writeTree(root, { "c.yml": layer }), "c.yml");
  const config = loadConfig({ packaged: none, userConfig: none, env, configPath: file });
  return { root, runsDir, config, ctx: cliContext(config, createRuntime({ runsDir, piCommand: "/bin/false", limit: config.limit })) };
}

function fakeRun(runsDir: string, id: string, over: Partial<RunRecord> = {}): RunRecord {
  const rec: RunRecord = { id, parent: null, kind: "workflow", spec: { workflow: "supabase-api" }, state: "failed", pid: null, startedAt: new Date().toISOString(), ...over };
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify(rec));
  return rec;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString("utf8")));
    req.on("end", () => resolve(s));
  });

describe("notify_operator", { concurrency: true }, () => {
  it("with no sink it is still recorded: control/notifications.jsonl and a notification event in the feed (E21)", async () => {
    const { root, runsDir, ctx } = setup();
    fakeRun(runsDir, "20261118-100000-aaaaaa", { job: { jobId: "job-77", callback: "http://x/jobs/job-77" } });
    const r = (await callTool("notify_operator", { severity: "error", summary: "  createclient-new failed: the route is not modeled  ", runId: "latest", link: "branch ops/fix-route" }, ctx)) as {
      notification: Record<string, unknown>;
      recorded: string;
      sinks: unknown[];
    };
    assert.equal(r.recorded, join(root, "control", "notifications.jsonl"));
    assert.equal(r.recorded, notificationsPath(runsDir));
    assert.deepEqual(r.sinks, []);
    const n0 = r.notification;
    assert.match(String(n0.id), /^n-/);
    assert.deepEqual(
      { severity: n0.severity, summary: n0.summary, runId: n0.runId, jobId: n0.jobId, link: n0.link, from: n0.from },
      { severity: "error", summary: "createclient-new failed: the route is not modeled", runId: "20261118-100000-aaaaaa", jobId: "job-77", link: "branch ops/fix-route", from: "cli" },
      "latest resolves to the run, and its job is named",
    );
    const lines = readFileSync(r.recorded, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), n0);
    const feed = readFeed(runsDir, { kind: "notification" });
    assert.equal(feed.length, 1);
    assert.equal(feed[0].runId, "20261118-100000-aaaaaa");
    assert.equal(feed[0].jobId, "job-77");
    assert.deepEqual({ id: feed[0].data.id, severity: feed[0].data.severity, summary: feed[0].data.summary }, { id: n0.id, severity: "error", summary: n0.summary });
  });

  it("a run that is not found is kept as written; an agent caller is named; the arguments are checked", async () => {
    const { ctx } = setup();
    const agent: ToolContext = { ...ctx, caller: { kind: "agent", agent: "ops", runId: "r-ops", allowed: ctx.caller.allowed } };
    const r = (await callTool("notify_operator", { severity: "info", summary: "daily review: 3 jobs, all done", runId: "no-such-run" }, agent)) as { notification: Record<string, unknown> };
    assert.equal(r.notification.runId, "no-such-run");
    assert.equal(r.notification.from, "agent ops (run r-ops)");
    for (const bad of [{ severity: "fatal", summary: "x" }, { severity: "info", summary: "" }, { severity: "info" }, { severity: "info", summary: "x", extra: 1 }]) {
      const e = await callTool("notify_operator", bad, ctx).catch((err) => err);
      assert.ok(isToolError(e) && e.code === "invalid", JSON.stringify(bad));
    }
  });

  it("goes to every sink: tsf (POST to its builder layer, with the token), file and command; a failing sink is named and the others still get it", async () => {
    const got: { url?: string; type?: string; auth?: string; body: unknown }[] = [];
    const tsf = createServer((req, res) => {
      void readBody(req).then((text) => {
        got.push({ url: req.url, type: req.headers["content-type"], auth: req.headers.authorization, body: JSON.parse(text) });
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => tsf.listen(port, "127.0.0.1", r));
    const dead = await freePort();
    try {
      const sinks = [
        `  notify:`,
        `    - { sink: tsf, url: "http://127.0.0.1:${port}/", token: env:NOTIFY_TEST_TOKEN }`,
        `    - { sink: file, path: notes/notifications.jsonl }`,
        `    - { sink: command, command: "cat > piped.json" }`,
        `    - { sink: command, command: "echo nope >&2; exit 3" }`,
        `    - { sink: tsf, url: "http://127.0.0.1:${dead}" }`,
        ``,
      ].join("\n");
      process.env.NOTIFY_TEST_TOKEN = "tok-123";
      const { root, ctx, config } = setup(sinks, process.env);
      assert.equal(config.notify[1].path, join(root, "notes", "notifications.jsonl"), "a relative path is the layer file's");
      assert.equal(publicConfig(config).notify[0].token, "env:NOTIFY_TEST_TOKEN");
      const r = (await callTool("notify_operator", { severity: "warn", summary: "fixed the route on branch ops/route; verified by run 2026" }, ctx)) as { notification: Record<string, unknown>; sinks: { sink: string; ok: boolean; error?: string }[] };
      assert.deepEqual(
        r.sinks.map((s) => [s.sink, s.ok]),
        [
          ["tsf", true],
          ["file", true],
          ["command", true],
          ["command", false],
          ["tsf", false],
        ],
      );
      assert.match(r.sinks[3].error ?? "", /exit 3: nope/);
      assert.match(r.sinks[4].error ?? "", /fetch failed|ECONNREFUSED|POST/);
      assert.equal(got.length, 1);
      assert.equal(got[0].url, "/api/layers/builder/action/notification");
      assert.equal(got[0].type, "application/json");
      assert.equal(got[0].auth, "Bearer tok-123");
      assert.deepEqual(got[0].body, { input: r.notification });
      assert.deepEqual(JSON.parse(readFileSync(join(root, "notes", "notifications.jsonl"), "utf8")), r.notification);
      // The command runs in builder/'s place: beside the runs directory.
      assert.deepEqual(JSON.parse(readFileSync(join(root, "piped.json"), "utf8")), r.notification);
    } finally {
      delete process.env.NOTIFY_TEST_TOKEN;
      tsf.close();
    }
  });

  it("redacts secrets before anything is recorded or sent", async () => {
    process.env.NOTIFY_SECRET_KEY = "sk-notify-0123456789";
    try {
      const { runsDir, ctx } = setup();
      await callTool("notify_operator", { severity: "error", summary: "the key sk-notify-0123456789 leaked; Authorization: Bearer abc.def" }, ctx);
      const text = readFileSync(notificationsPath(runsDir), "utf8") + JSON.stringify(readFeed(runsDir));
      assert.doesNotMatch(text, /sk-notify-0123456789|abc\.def/);
      assert.match(text, /\[redacted/);
    } finally {
      delete process.env.NOTIFY_SECRET_KEY;
    }
  });
});

describe("notifications_list", () => {
  it("newest first with seqs; since a seq, a time or a duration; limit; a bad since is invalid", async () => {
    const { ctx } = setup();
    assert.deepEqual(await callTool("notifications_list", {}, ctx), { file: notificationsPath(ctx.runtime.options.runsDir), count: 0, notifications: [] }, "none yet");
    for (const s of ["one", "two", "three"]) await callTool("notify_operator", { severity: "info", summary: s }, ctx);
    const all = (await callTool("notifications_list", {}, ctx)) as { count: number; notifications: { seq: number; summary: string }[] };
    assert.deepEqual(
      all.notifications.map((x) => [x.seq, x.summary]),
      [
        [3, "three"],
        [2, "two"],
        [1, "one"],
      ],
    );
    const after1 = (await callTool("notifications_list", { since: "1" }, ctx)) as { notifications: { summary: string }[] };
    assert.deepEqual(
      after1.notifications.map((x) => x.summary),
      ["three", "two"],
    );
    const recent = (await callTool("notifications_list", { since: "1h", limit: 1 }, ctx)) as { count: number; notifications: { summary: string }[] };
    assert.deepEqual(
      recent.notifications.map((x) => x.summary),
      ["three"],
    );
    const future = (await callTool("notifications_list", { since: "2099-01-01T00:00:00Z" }, ctx)) as { count: number };
    assert.equal(future.count, 0);
    const e = await callTool("notifications_list", { since: "yesterday-ish" }, ctx).catch((err) => err);
    assert.ok(isToolError(e) && e.code === "invalid");
  });
});

describe("notify sinks in the machine config", () => {
  it("an unknown sink, a sink without what it needs, or a literal token stops the config from loading (E22)", () => {
    const load = (notify: string) => () => setup(`  notify:\n${notify}\n`);
    assert.throws(load("    - { sink: slack, url: x }"), /notify\[0\]\.sink: must be one of tsf, file, command/);
    assert.throws(load("    - { sink: tsf }"), /notify\[0\]: a tsf sink needs url/);
    assert.throws(load("    - { sink: file }"), /a file sink needs path/);
    assert.throws(load("    - { sink: command }"), /a command sink needs command/);
    assert.throws(load("    - { sink: tsf, url: 'http://x', token: hunter2 }"), /notify\[0\]\.token: must be an env:NAME reference/);
    assert.throws(load("    - { sink: file, path: x, colour: red }"), /unknown key builder\.notify\[0\]\.colour/);
    assert.equal(setup("  notify:\n    - { sink: command, command: 'logger -t builder' }\n").config.notify[0].command, "logger -t builder");
  });
});
