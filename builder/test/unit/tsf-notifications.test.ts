/**
 * The builder TSF layer's notifications (tsf/layers/builder): its `notifications` query reads this machine's
 * notifications through the real CLI (`builder tool notifications_list`) and adds the ones a builder's tsf notify sink
 * posted to its `notification` action. Here the sink's POST reaches the layer's handler through a small HTTP server
 * standing in for the TSF's layer route (POST /api/layers/:layer/action/:name with { input }). Imported by path:
 * builder/ never imports the TSF.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool } from "../../ops/core/tool.ts";
import { createRuntime } from "../../runtime/run.ts";
import { freePort, tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-tsf-notifications");
after(() => tmp.remove());
const runsDir = join(tmp.dir, "runs");
writeTree(tmp.dir, { "machine.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` });
// The CLI the layer spawns inherits this environment.
process.env.HOME = join(tmp.dir, "home");
process.env.GAFFER_CONFIG = join(tmp.dir, "machine.yml");
delete process.env.GAFFER_INSTANCE;

interface Notification {
  id: string;
  ts: string;
  severity: string;
  summary: string;
  from?: string;
}
type Handlers = {
  queries: Record<string, (input: unknown) => Promise<unknown>>;
  actions: Record<string, { run: (input: unknown) => Promise<unknown> }>;
};
const ext = (await import(pathToFileURL(join(BUILDER, "tsf", "layers", "builder", "extension.ts")).href)) as { createHandlers(ctx: unknown): Handlers };
const published: unknown[] = [];
const ctx = { paths: { projectRoot: BUILDER }, bus: { publish: (e: unknown) => published.push(e) } };
// The handlers start the layer, which follows the feed (`builder events -f`): stop it, or the test never ends.
after(() => (globalThis as unknown as { __builderLayer?: { stop(): void } }).__builderLayer?.stop());

describe("the builder TSF layer's notifications", () => {
  it("lists this machine's notifications and those a tsf sink posted, newest first, once each", async () => {
    const h = ext.createHandlers(ctx);
    const empty = (await h.queries.notifications({})) as { count: number; error: string | null; notifications: Notification[] };
    assert.deepEqual(empty, { count: 0, error: null, notifications: [] });

    // This machine: an agent's notification, recorded in its runs directory's control/notifications.jsonl.
    const local = loadConfig({ packaged: join(tmp.dir, "none.yml"), userConfig: join(tmp.dir, "none.yml"), env: process.env });
    await callTool("notify_operator", { severity: "warn", summary: "local: the job failed, fix on branch ops/x" }, cliContext(local, createRuntime({ runsDir, piCommand: "/bin/false" })));

    // Another builder, with a tsf sink pointed at this TSF: the stand-in route hands the body's input to the action.
    const port = await freePort();
    const tsf = createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString("utf8")));
      req.on("end", () => {
        const m = /^\/api\/layers\/builder\/action\/(\w+)$/.exec(req.url ?? "");
        const action = m ? h.actions[m[1]] : undefined;
        if (!action || req.headers["content-type"] !== "application/json") return void res.writeHead(404).end();
        action.run((JSON.parse(body) as { input: unknown }).input).then(
          (out) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out)),
          (err: Error) => res.writeHead(400).end(err.message),
        );
      });
    });
    await new Promise<void>((r) => tsf.listen(port, "127.0.0.1", r));
    try {
      const remoteRoot = join(tmp.dir, "remote");
      writeTree(remoteRoot, { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(join(remoteRoot, "runs"))} }\n  notify: [{ sink: tsf, url: "http://127.0.0.1:${port}" }]\n` });
      const remote = loadConfig({ packaged: join(tmp.dir, "none.yml"), userConfig: join(tmp.dir, "none.yml"), env: {}, configPath: join(remoteRoot, "c.yml") });
      const remoteCtx = cliContext(remote, createRuntime({ runsDir: join(remoteRoot, "runs"), piCommand: "/bin/false" }));
      await new Promise((r) => setTimeout(r, 5));
      const sent = (await callTool("notify_operator", { severity: "error", summary: "remote: the server is draining" }, remoteCtx)) as { notification: Notification; sinks: { ok: boolean; error?: string }[] };
      assert.deepEqual(sent.sinks, [{ sink: "tsf", ok: true }]);
      // A sink that posts the same notification again (a retry) is shown once.
      await h.actions.notification.run(sent.notification);

      const all = (await h.queries.notifications({ limit: 10 })) as { count: number; error: string | null; notifications: Notification[] };
      assert.equal(all.error, null);
      assert.deepEqual(
        all.notifications.map((x) => x.summary),
        ["remote: the server is draining", "local: the job failed, fix on branch ops/x"],
      );
      assert.equal(all.notifications[0].id, sent.notification.id);
      await waitFor("a posted notification tells the screens (layer.changed)", () => (published.length > 0 ? true : undefined), 5000, 50);
      await assert.rejects(h.actions.notification.run({ summary: "no id" }), /not a notification/);
    } finally {
      tsf.close();
    }
  });
});
