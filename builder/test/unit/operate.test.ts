/**
 * The operate tools through callTool. control_send writes the server's inbox and waits for the outbox (an in-process
 * poller plays the server); with no answer it withdraws its message. config_reload re-reads the layers: a good layer
 * reaches every live run (runs/<id>/config.json, which narrows an agent's tools and the limit of the runs it starts);
 * a broken one changes nothing (E22) and both land in the machine feed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { AgentTools, allowedNow, cliContext } from "../../ops/core/context.ts";
import { callTool, isToolError } from "../../ops/core/tool.ts";
import { readFeed } from "../../runtime/feed.ts";
import { createRuntime, liveLimit, RUN_CONFIG_FILE, type RunConfig } from "../../runtime/run.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { controlDir, startInboxPoller, writeControl, readOutbox } from "../../server/control.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-operate");
after(() => tmp.remove());
const none = join(tmp.dir, "absent.yml");
let n = 0;

/** A CLI context on its own runs directory, with a --config layer we can edit. */
function setup(layer = "builder:\n  limit: { tools: { enable: ['*'] } }\n") {
  const root = join(tmp.dir, `o-${++n}`);
  const runsDir = join(root, "runs");
  const file = join(writeTree(root, { "c.yml": layer.replace("builder:\n", `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n`) }), "c.yml");
  const config = loadConfig({ packaged: none, userConfig: none, env: {}, configPath: file });
  return { root, runsDir, file, ctx: cliContext(config, createRuntime({ runsDir, piCommand: "/bin/false", limit: config.limit })) };
}

function fakeRun(runsDir: string, id: string, over: Partial<RunRecord> = {}): RunRecord {
  const rec: RunRecord = { id, parent: null, kind: "agent", spec: { agent: "lab" }, state: "running", pid: process.pid, startedAt: new Date().toISOString(), ...over };
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify(rec));
  return rec;
}

describe("control_send", { concurrency: true }, () => {
  it("writes the inbox and returns the server's answer from the outbox", async () => {
    const { root, runsDir, ctx } = setup();
    const dir = controlDir(runsDir);
    assert.equal(dir, join(root, "control"), "control/ is beside the runs directory");
    const seen: unknown[] = [];
    const poller = startInboxPoller(dir, async (msg) => {
      seen.push(msg);
      return { ok: true, state: "draining" };
    }, 50);
    try {
      const r = (await callTool("control_send", { action: "drain" }, ctx)) as Record<string, unknown>;
      assert.equal(r.action, "drain");
      assert.match(String(r.by), /^cli \(/);
      assert.deepEqual(r.result, { ok: true, state: "draining" });
      assert.ok(r.receivedAt && r.appliedAt);
      assert.deepEqual(readdirSync(join(dir, "inbox")), [], "the inbox is empty once handled");
      assert.equal((seen[0] as { action: string }).action, "drain");
    } finally {
      poller.stop();
    }
  });

  it("with no server to answer it withdraws the message, so a server started later never applies it; waitSeconds 0 queues it", async () => {
    const { runsDir, ctx } = setup();
    const e = await callTool("control_send", { action: "cancel", jobId: "j1", waitSeconds: 1 }, ctx).catch((err) => err);
    assert.ok(isToolError(e) && e.code === "failed");
    assert.match(e.message, /no build server took the cancel within 1 s .*: the message was withdrawn/);
    assert.deepEqual(readdirSync(join(controlDir(runsDir), "inbox")), []);
    const q = (await callTool("control_send", { action: "resume", waitSeconds: 0 }, ctx)) as { id: string; queued: boolean; inbox: string };
    assert.equal(q.queued, true);
    assert.ok(existsSync(q.inbox));
  });

  it("the poller answers a message that does not parse with ok: false, and claims each message once", async () => {
    const { runsDir } = setup();
    const dir = controlDir(runsDir);
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "inbox", "20261118T000000000Z-bad.json"), '{"action":"explode"}');
    const { id } = writeControl(dir, { action: "resume", by: "test" });
    let calls = 0;
    const a = startInboxPoller(dir, async () => ({ ok: true, state: "idle" }), 10_000);
    const b = startInboxPoller(dir, async () => {
      calls++;
      return { ok: true, state: "idle" };
    }, 10_000);
    try {
      await Promise.all([a.poll(), b.poll(), a.poll()]);
      assert.deepEqual(readOutbox(dir, "20261118T000000000Z-bad")?.result, { ok: false, error: "action must be one of drain, resume, cancel" });
      assert.equal(readOutbox(dir, id)?.result.ok, true);
      assert.ok(calls <= 1);
    } finally {
      a.stop();
      b.stop();
    }
  });
});

describe("config_reload", { concurrency: true }, () => {
  it("a good layer: every live run is told its new limit, the feed records it, and this process uses it", async () => {
    const { runsDir, file, ctx } = setup();
    const live = fakeRun(runsDir, "20261118-120000-000001", { resolved: { mode: "headless", cwd: "/", workspace: "none", tools: ["read", "run_list", "journal_query", "context_get"], resources: [], argv: [], env: {}, areas: {}, mayStart: [] } });
    const ended = fakeRun(runsDir, "20261118-120000-000002", { state: "done" });
    writeFileSync(file, `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'], disable: [journal_query, runs] } }\n`);
    const r = (await callTool("config_reload", {}, ctx)) as { loaded: boolean; runs: string[]; limit: RunConfig["limit"] };
    assert.equal(r.loaded, true);
    assert.deepEqual(r.runs, [live.id]);
    assert.deepEqual(r.limit, { enable: ["*"], disable: ["journal_query", "runs"] });
    const told = JSON.parse(readFileSync(join(runsDir, live.id, RUN_CONFIG_FILE), "utf8")) as RunConfig;
    assert.deepEqual(told.limit, r.limit);
    assert.equal(existsSync(join(runsDir, ended.id, RUN_CONFIG_FILE)), false, "an ended run is not told");
    assert.deepEqual(ctx.config.limit, r.limit, "the process that served the tool uses the new config");
    const feed = readFeed(runsDir, { kind: "config.loaded" });
    assert.equal(feed.length, 1);
    assert.equal(feed[0].data.ok, true);
    assert.deepEqual(feed[0].data.runs, [live.id]);

    // The live run: its tools narrow to what it resolved within the new limit, and so does what it starts.
    assert.deepEqual([...allowedNow(live.resolved!.tools, join(runsDir, live.id), { enable: ["*"], disable: [] })], ["read", "context_get"]);
    assert.deepEqual(liveLimit(join(runsDir, live.id), { enable: ["*"], disable: [] }), r.limit);
    const tools = AgentTools.fromEnv({ BUILDER_RUN_DIR: join(runsDir, live.id), BUILDER_RUNS_DIR: runsDir, BUILDER_PI_COMMAND: "/bin/false", BUILDER_LIMIT: JSON.stringify({ enable: ["*"], disable: [] }) });
    assert.ok(tools);
    assert.deepEqual([...tools!.allowed()], ["read", "context_get"]);
    assert.notEqual(tools!.stamp(), "");
    assert.deepEqual([...tools!.context().caller.allowed], ["read", "context_get"]);
  });

  it("a broken layer changes nothing: the error names the layer and the key, and the feed records it (E22)", async () => {
    const { runsDir, file, ctx } = setup();
    const live = fakeRun(runsDir, "20261118-120000-000003");
    const before = { ...ctx.config.limit };
    writeFileSync(file, "builder:\n  limit: { tools: { enable: [files, fils] } }\n");
    const e = await callTool("config_reload", {}, ctx).catch((err) => err);
    assert.ok(isToolError(e) && e.code === "failed");
    assert.match(e.message, /^config --config .*c\.yml: builder\.limit\.tools\.enable: unknown tool or group "fils" \(nothing changed: the previous config stays in force\)$/);
    assert.equal(existsSync(join(runsDir, live.id, RUN_CONFIG_FILE)), false);
    assert.deepEqual(ctx.config.limit, before);
    const feed = readFeed(runsDir, { kind: "config.loaded" });
    assert.equal(feed[0].data.ok, false);
    assert.match(String(feed[0].data.error), /unknown tool or group "fils"/);
    // Fixed, it loads.
    writeFileSync(file, `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: [observe] } }\n`);
    await waitFor("the reload", async () => ((await callTool("config_reload", {}, ctx)) ? true : undefined), 2000);
    assert.deepEqual(ctx.config.limit, { enable: ["observe"], disable: [] });
  });
});
