/**
 * The builder TSF layer (tsf/layers/builder/lib.ts) as a client of the builder CLI: status from the machine feed it
 * follows with `builder events --json -f`, CLI errors as CliError, and the model picker as agent_get then agent_update
 * of the agent's settings.json. The CLI is the real one, on a --config-free machine whose config is $GAFFER_CONFIG
 * with a temp runs directory. Imported by path: builder/ never imports the TSF (and its typecheck excludes tsf/).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFeed } from "../../runtime/feed.ts";
import { piSettings } from "../../runtime/pi.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-tsf-layer");
after(() => tmp.remove());
const runsDir = join(tmp.dir, "runs");
writeTree(tmp.dir, { "machine.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` });
// The CLI the layer spawns inherits this environment.
process.env.HOME = join(tmp.dir, "home");
process.env.GAFFER_CONFIG = join(tmp.dir, "machine.yml");
delete process.env.GAFFER_INSTANCE;

type Json = unknown;
interface FeedEvent {
  seq: number;
  ts: string;
  kind: string;
  runId?: string;
  jobId?: string;
  step?: string;
  data: Record<string, unknown>;
}
interface Layer {
  cli(args: string[], o?: { lines?: boolean }): Promise<Json>;
  tool(name: string, args?: Record<string, unknown>): Promise<Json>;
  follow(): () => void;
  status(): Record<string, any>;
  events(limit?: number, kind?: string): { kind: string; msg: string; seq: number }[];
  model(agent?: string): Promise<Json>;
  setModel(input: { agent?: string; provider?: string; model?: string; thinking?: string }): Promise<Json>;
}
const lib = (await import(pathToFileURL(join(BUILDER, "tsf", "layers", "builder", "lib.ts")).href)) as {
  BuilderLayer: new (ctx: unknown) => Layer;
  CliError: new (code: string, message: string) => Error & { code: string; cliCode: string };
  describe(e: FeedEvent): string;
  MODEL_AGENT: string;
};

const published: unknown[] = [];
const ctx = { paths: { projectRoot: BUILDER }, bus: { publish: (e: unknown) => published.push(e) } };
const feed = (kind: Parameters<typeof appendFeed>[1]["kind"], data: Record<string, unknown>, ids: { jobId?: string; runId?: string } = {}) => appendFeed(runsDir, { kind, ...ids, data });

/** A process that is gone: its pid is free. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((r) => child.once("exit", r));
  return pid;
}

describe("the builder TSF layer, a client of the builder CLI", () => {
  it("describes feed events in a few words", () => {
    const e = (kind: string, data: Record<string, unknown>): FeedEvent => ({ seq: 1, ts: "2026-11-18T10:00:00.000Z", kind, data });
    assert.equal(lib.describe(e("server.start", { host: "127.0.0.1", port: 8788, pid: 42, builder: "supabase-api" })), "build server on http://127.0.0.1:8788 (pid 42), builder supabase-api");
    assert.equal(lib.describe(e("server.state", { state: "busy", name: "rustic-dolphin", step: "implement" })), "busy: rustic-dolphin at implement");
    assert.equal(lib.describe(e("job.result", { outcome: "failed", reason: "the agent halted" })), "failed: the agent halted");
    assert.equal(lib.describe(e("step.end", { status: "done", ms: 61_000 })), "done in 61s");
  });

  it("runs CLI commands with --json; a CLI error is a CliError with the CLI's code", async () => {
    const layer = new lib.BuilderLayer(ctx);
    const runs = (await layer.cli(["runs"])) as { runsDir: string; runs: unknown[] };
    assert.equal(runs.runsDir, runsDir, "the CLI reads the same machine config as an operator's terminal");
    await assert.rejects(layer.tool("no_such_tool"), (err: Error & { code?: string; cliCode?: string }) => err instanceof lib.CliError && err.cliCode === "unknown" && /unknown tool "no_such_tool"/.test(err.message));
    await assert.rejects(layer.tool("run_get", { run: "no-such-run" }), (err: Error & { code?: string }) => err.name === "ServiceError" && err.code === "upstream", "a ServiceError to the app: the screens show its message");
    const config = (await layer.cli(["config"])) as { layers: string[] };
    assert.ok(config.layers.some((l) => l.startsWith("GAFFER_CONFIG ")));
  });

  it("status follows the machine feed: the server's start, state and stop, its job, the last job; a dead pid reads as stopped", async () => {
    feed("server.start", { pid: process.pid, host: "127.0.0.1", port: 9911, builder: "supabase-api", runsDir });
    feed("server.state", { state: "idle" });
    const layer = new lib.BuilderLayer(ctx);
    const stop = layer.follow();
    try {
      await waitFor("idle", () => (layer.status().state === "idle" ? true : undefined), 15_000);
      assert.equal(layer.status().url, "http://127.0.0.1:9911");
      feed("job.accepted", { jobId: "job-1", name: "rustic-dolphin", slice: "Billing/CreateClient", attempt: 2, builder: "supabase-api" }, { jobId: "job-1", runId: "run-1" });
      feed("server.state", { state: "busy", jobId: "job-1", name: "rustic-dolphin", runId: "run-1", step: "implement" }, { jobId: "job-1", runId: "run-1" });
      const busy = await waitFor("busy", () => (layer.status().state === "busy" ? layer.status() : undefined), 15_000);
      assert.deepEqual({ ...busy.job, startedAt: typeof busy.job.startedAt }, { jobId: "job-1", name: "rustic-dolphin", runId: "run-1", step: "implement", slice: "Billing/CreateClient", attempt: 2, startedAt: "string" });
      assert.match(busy.summary, /^Builder busy: rustic-dolphin at implement/);
      feed("job.result", { outcome: "done" }, { jobId: "job-1", runId: "run-1" });
      feed("server.state", { state: "idle" });
      const idle = await waitFor("idle again", () => (layer.status().state === "idle" && layer.status().lastJob ? layer.status() : undefined), 15_000);
      assert.deepEqual({ name: idle.lastJob.name, outcome: idle.lastJob.outcome, slice: idle.lastJob.slice }, { name: "rustic-dolphin", outcome: "done", slice: "Billing/CreateClient" });
      assert.deepEqual(
        layer.events(3).map((e) => e.kind),
        ["server.state", "job.result", "server.state"],
        "newest first",
      );
      feed("server.stop", { signal: "SIGTERM", pid: process.pid });
      await waitFor("stopped", () => (layer.status().state === "stopped" ? true : undefined), 15_000);
      feed("server.start", { pid: await deadPid(), host: "127.0.0.1", port: 9912, builder: "supabase-api" });
      await waitFor("a server.start whose pid is gone", () => (layer.events(1)[0]?.kind === "server.start" ? true : undefined), 15_000);
      assert.equal(layer.status().running, false);
      assert.equal(layer.status().state, "stopped");
      assert.ok(published.length > 0, "new feed events tell the screens (layer.changed)");
    } finally {
      stop();
    }
  });

  it("the model picker reads an agent's model with builder resolve, and changes it with agent_get then agent_update", async () => {
    const layer = new lib.BuilderLayer(ctx);
    const live = piSettings(join(BUILDER, "agentics", "agents", lib.MODEL_AGENT));
    const m = (await layer.model()) as { agent: string; provider: string; model: string; thinking: string };
    assert.deepEqual({ agent: m.agent, provider: m.provider, model: m.model, thinking: m.thinking }, { agent: lib.MODEL_AGENT, ...live });
    // agent_update writes the real agent tree: the layer's tool calls are recorded instead.
    const calls: [string, Record<string, unknown>][] = [];
    const current = { defaultProvider: "openrouter", defaultModel: "old/model", defaultThinkingLevel: "medium", defaultTools: ["read"] };
    layer.tool = async (name, args = {}) => {
      calls.push([name, args]);
      return name === "agent_get" ? { version: "v1", file: "settings.json", content: JSON.stringify(current) } : { version: "v2", affects: [] };
    };
    await layer.setModel({ model: "some/model", thinking: "" });
    assert.deepEqual(calls[0], ["agent_get", { id: lib.MODEL_AGENT, file: "settings.json" }]);
    const [name, args] = calls[1];
    assert.equal(name, "agent_update");
    assert.equal(args.id, lib.MODEL_AGENT);
    assert.equal(args.expectedVersion, "v1", "the version it read: a stale one is refused (E15)");
    const settings = JSON.parse((args.files as Record<string, string>)["settings.json"]) as Record<string, unknown>;
    assert.deepEqual(settings, { defaultProvider: "openrouter", defaultModel: "some/model", defaultTools: ["read"] }, "only the picked keys change; an empty thinking level goes back to pi's default");
  });
});
