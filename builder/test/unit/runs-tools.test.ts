/**
 * The runs tools through callTool, with a stand-in for pi: start and wait, read and list, stop (and what may not be
 * stopped), a wait that times out, E8 and the interactive rule for agent callers, config_resolve within the caller's
 * tools, and workspace_reset.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { RunRecord, RunResult } from "../../runtime/types.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const tmp = tempDir("builder-runs-tools");
after(() => tmp.remove());
const runsDir = join(tmp.dir, "runs");
const pi = fakePi(
  tmp.dir,
  "pi",
  `const msg = process.argv[process.argv.length - 1];
if (msg === "sleep") setTimeout(() => {}, 120_000);
else console.log("said: " + msg);
`,
);
const agentics = writeTree(join(tmp.dir, "agentics"), {
  "agents/echo/agent.yml": "description: echoes\nmode: headless\ntools: { enable: [read, observe] }\n",
  "agents/lab/agent.yml": "description: a lab\nmode: interactive\ntools: { enable: [read, runs] }\nruns: { may_start: [agent:echo] }\n",
  "agents/tui/agent.yml": "description: a terminal agent\nmode: interactive\n",
});
const none = join(tmp.dir, "absent.yml");
const configFile = join(writeTree(join(tmp.dir, "config"), { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` }), "c.yml");
const config = loadConfig({ packaged: none, userConfig: none, env: {}, configPath: configFile });
const runtime = createRuntime({ runsDir, piCommand: pi, agenticsDir: agentics, limit: config.limit });
const cli = cliContext(config, runtime);

const call = async <T = Record<string, any>>(name: string, args: unknown, ctx: ToolContext = cli) => (await callTool(name, args, ctx)) as T;

/** A run record written by hand (a run "in progress" for the agent-caller cases). */
function fakeRun(id: string, over: Partial<RunRecord>): RunRecord {
  const rec: RunRecord = { id, parent: null, kind: "agent", spec: { agent: "lab" }, state: "running", pid: process.pid, startedAt: new Date().toISOString(), ...over };
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify(rec));
  return rec;
}

const agentCtx = (rec: RunRecord): ToolContext => ({ ...cli, runtime: createRuntime({ runsDir, piCommand: pi, agenticsDir: agentics, limit: config.limit, self: rec.id }), caller: { kind: "agent", runId: rec.id, agent: rec.spec.agent, allowed: new Set(cli.caller.allowed) } });

describe("runs tools", { concurrency: true }, () => {
  it("run_start, run_wait, run_get and run_list: a headless agent run from start to its result", async () => {
    const started = await call("run_start", { agent: "echo", input: { message: "hello" }, workspace: "none" });
    assert.equal(started.mode, "headless");
    assert.deepEqual(started.tools, ["read", "instance_get", "job_get", "journal_query", "journal_tail", "context_get", "data_list", "job_artifacts", "session_entries", "run_stories", "run_story", "run_log", "metrics"]);
    const waited = await call<{ state: string; result: RunResult }>("run_wait", { run: started.runId });
    assert.equal(waited.state, "done");
    assert.equal((waited.result as { data: { output: string } }).data.output, "said: hello");
    const got = await call("run_get", { run: started.runId });
    assert.equal(got.id, started.runId);
    assert.equal(got.alive, false);
    assert.equal(got.dir, join(runsDir, started.runId));
    assert.deepEqual(got.children, []);
    const listed = await call<{ runs: { id: string; target: string; state: string; outcome: string }[] }>("run_list", { target: "agent:ech*", state: "done" });
    assert.ok(listed.runs.some((r) => r.id === started.runId && r.target === "agent:echo" && r.outcome === "done"));
    assert.equal((await call<{ runs: unknown[] }>("run_list", { state: "live", target: "agent:echo" })).runs.filter((r) => (r as { id: string }).id === started.runId).length, 0);
  });

  it("run_wait gives up after its timeout and says so; run_stop stops the run with the reason", async () => {
    const started = await call("run_start", { agent: "echo", input: { message: "sleep" }, workspace: "none" });
    await waitFor("the run to be running", () => (runtime.get(started.runId)?.state === "running" ? true : undefined), 10_000, 50);
    const waited = await call("run_wait", { run: started.runId, timeoutSeconds: 1 });
    assert.equal(waited.timedOut, true);
    assert.equal(waited.state, "running");
    const stopped = await call("run_stop", { run: started.runId, reason: "enough" });
    assert.deepEqual([stopped.state, stopped.result], ["stopped", { outcome: "failed", reason: "enough" }]);
    assert.equal((await call("run_stop", { run: started.runId })).already, true);
  });

  it("run_stop refuses a server job's runs (control_send cancel tells the gaffer why) and an agent's own run", async () => {
    const job = fakeRun("20261118-110000-000001", { kind: "workflow", spec: { workflow: "supabase-api" }, job: { jobId: "j-stop", callback: "http://x/jobs/j-stop" } });
    const step = fakeRun("20261118-110000-000002", { parent: job.id, spec: { agent: "echo" } });
    for (const run of [job.id, step.id]) {
      await assert.rejects(callTool("run_stop", { run }, cli), (e) => isToolError(e) && e.code === "refused" && /belongs to server job j-stop: cancel it with control_send/.test(e.message));
    }
    const me = fakeRun("20261118-110000-000003", { spec: { agent: "lab" } });
    await assert.rejects(callTool("run_stop", { run: me.id }, agentCtx(me)), /is your own run or one above it/);
  });

  it("an agent's run_start: its child (E8 decides what it may start), never an interactive run", async () => {
    const lab = fakeRun("20261118-110000-000004", { spec: { agent: "lab" }, resolved: { mode: "interactive", cwd: tmp.dir, workspace: "none", tools: ["read", "run_start", "run_wait"], resources: [], argv: [], env: {}, areas: {}, mayStart: ["agent:echo"] }, ceiling: ["read", "run_start", "run_wait"] });
    const ctx = agentCtx(lab);
    const child = await call("run_start", { agent: "echo", input: { message: "from the lab" }, workspace: "none" }, ctx);
    assert.equal(runtime.get(child.runId)?.parent, lab.id);
    assert.deepEqual(child.tools, ["read"], "a child gets at most its parent's tools");
    await call("run_wait", { run: child.runId }, ctx);
    await assert.rejects(callTool("run_start", { agent: "lab", mode: "headless", input: { message: "x" } }, ctx), (e) => isToolError(e) && e.code === "refused" && /may not start agent:lab/.test(e.message));
    await assert.rejects(callTool("run_start", { agent: "tui" }, ctx), (e) => isToolError(e) && e.code === "invalid" && /an interactive run needs a terminal/.test(e.message));
    await assert.rejects(callTool("run_start", { agent: "echo", mode: "interactive" }, ctx), /an interactive run needs a terminal/);
  });

  it("config_resolve: what a spec loads, within the caller's own tools, secrets hidden", async () => {
    const r = await call("config_resolve", { agent: "echo", input: { message: "x" }, workspace: "none" });
    assert.equal(r.mode, "headless");
    assert.ok(r.tools.includes("metrics"));
    const lab = fakeRun("20261118-110000-000005", { spec: { agent: "lab" }, resolved: { mode: "interactive", cwd: tmp.dir, workspace: "none", tools: ["read"], resources: [], argv: [], env: {}, areas: {}, mayStart: ["agent:echo"] }, ceiling: ["read"] });
    const narrowed = await call("config_resolve", { agent: "echo", input: { message: "x" }, workspace: "none" }, agentCtx(lab));
    assert.deepEqual(narrowed.tools, ["read"]);
    await assert.rejects(callTool("config_resolve", { agent: "nobody" }, cli), /no agent nobody/);
  });

  it("workspace_reset: an ended snapshot run's workspace is copied again; live runs and dir workspaces are refused", async () => {
    const src = writeTree(join(tmp.dir, "app"), { "a.txt": "original\n" });
    const started = await call("run_start", { agent: "echo", input: { message: "hi" }, workspace: { snapshot: { from: src } } });
    await call("run_wait", { run: started.runId });
    const ws = join(runsDir, started.runId, "workspace");
    writeFileSync(join(ws, "a.txt"), "changed by the agent\n");
    writeFileSync(join(ws, "new.txt"), "new\n");
    const r = await call("workspace_reset", { run: started.runId });
    assert.deepEqual(r, { runId: started.runId, workspace: ws, from: src });
    assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "original\n");
    assert.equal(existsSync(join(ws, "new.txt")), false);
    const live = fakeRun("20261118-110000-000006", { resolved: { mode: "headless", cwd: tmp.dir, workspace: "empty", tools: [], resources: [], argv: [], env: {}, areas: {}, mayStart: [] } });
    await assert.rejects(callTool("workspace_reset", { run: live.id }, cli), /is running: stop it first/);
    const inPlace = fakeRun("20261118-110000-000007", { state: "done", resolved: { mode: "headless", cwd: src, workspace: { dir: { path: src } }, tools: [], resources: [], argv: [], env: {}, areas: {}, mayStart: [] } });
    await assert.rejects(callTool("workspace_reset", { run: inPlace.id }, cli), /worked in place/);
  });
});
