/**
 * The observe tools, through callTool, on a runs directory written by hand: a job (a workflow run with a server job
 * and an agent step), a direct agent run without a journal, and an agent tree with data/ folders at three levels.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { jobName } from "../../engine/job-name.ts";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { JournalWriter, type JournalEvent } from "../../runtime/journal.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-observe");
after(() => tmp.remove());
const runsDir = join(tmp.dir, "runs");
const agentics = join(tmp.dir, "agentics");
const W = "20261118-100000-aaaaaa";
const A = "20261118-100001-bbbbbb";
const B = "20261118-100002-cccccc";
const JOB = "job-observe-1";
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function record(r: Partial<RunRecord> & Pick<RunRecord, "id" | "kind" | "spec">): void {
  mkdirSync(join(runsDir, r.id), { recursive: true });
  writeFileSync(join(runsDir, r.id, "run.json"), JSON.stringify({ parent: null, state: "done", pid: null, startedAt: iso(60_000), endedAt: iso(1000), ...r }, null, 2));
}

let ctx: ToolContext;
let configFile: string;

before(() => {
  writeTree(agentics, {
    "agents/dev/lab/agent.yml": "description: lab\n",
    "agents/dev/lab/data/dispatches/a.json": "{}",
    "agents/dev/data/dispatches/a.json": "{}",
    "agents/dev/data/notes.md": "notes",
    "shared/data/dispatches/b.json": "{}",
    "shared/data/local/dispatches/b.json": "{}",
  });
  configFile = join(writeTree(join(tmp.dir, "config"), { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)}, port: 9123 }\n  limit: { tools: { enable: ['*'] } }\n` }), "c.yml");
  const config = loadConfig({ packaged: join(tmp.dir, "absent.yml"), userConfig: join(tmp.dir, "absent.yml"), env: {}, configPath: configFile });
  ctx = cliContext(config, createRuntime({ runsDir, piCommand: "/bin/false", agenticsDir: agentics }));

  // The job: a workflow run with a server job, and its agent step's run.
  record({ id: W, kind: "workflow", spec: { workflow: "supabase-api" }, step: "commit", job: { jobId: JOB, callback: "http://x/jobs/" + JOB, callbackDone: true }, result: { outcome: "done", patches: { app: "From abc\npatch body\n" } } });
  writeTree(join(runsDir, W, "context"), {
    "job.json": JSON.stringify({ runId: W, jobId: JOB, dispatch: { task: { context: "Billing", title: "CreateThing", attempt: 2 }, repo: { base: "abc1234" } }, builder: { name: "supabase-api", version: "v1" } }),
    "outputs/classify.json": JSON.stringify({ kind: "state-change", verdict: "NEW" }),
  });
  mkdirSync(join(runsDir, W, "workspace"), { recursive: true });
  writeFileSync(join(runsDir, W, "workspace", "big.txt"), "not an artifact");
  const wj = new JournalWriter(join(runsDir, W), { runId: W });
  wj.append({ kind: "run.start", data: { kind: "workflow" } });
  wj.append({ kind: "step.start", step: "clone", span: "s-1", data: { stepKind: "code" } });
  wj.append({ kind: "step.end", step: "clone", span: "s-1", data: { status: "ok", ms: 100 } });
  wj.append({ kind: "step.start", step: "implement", span: "s-2", data: { stepKind: "agent", childRunId: A } });
  wj.append({ kind: "step.end", step: "implement", span: "s-2", data: { status: "ok", ms: 2000, childRunId: A } });
  wj.append({ kind: "run.end", data: { state: "done" } });

  record({ id: A, kind: "agent", parent: W, spec: { agent: "supabase-api", step: "implement" }, resolved: { mode: "headless", cwd: "/w", workspace: "none", tools: [], resources: [], argv: ["--session-dir", join(runsDir, A, "sessions")], env: {}, areas: {}, mayStart: [] } });
  const aj = new JournalWriter(join(runsDir, A), { runId: A, agent: "supabase-api", step: "implement" });
  aj.append({ kind: "run.start", parent: W, data: {} });
  aj.append({ kind: "tool.start", span: "t-1", data: { tool: "read", input: { path: "src/a.ts" } } });
  aj.append({ kind: "tool.end", span: "t-1", data: { tool: "read", isError: false, ms: 5, output: "x".repeat(9000) } });
  aj.append({ kind: "tool.start", span: "t-2", data: { tool: "npm", input: { args: ["test"] } } });
  aj.append({ kind: "tool.end", span: "t-2", data: { tool: "npm", isError: true, ms: 100, output: "1 failing" } });
  aj.append({ kind: "turn.end", data: { turn: 0, toolCalls: 2 } });
  aj.append({ kind: "model.usage", data: { model: "fake/m", input: 1000, output: 50, cacheRead: 200, cost: 0.01 } });
  aj.append({ kind: "turn.end", data: { turn: 1, toolCalls: 0 } });
  aj.append({ kind: "run.end", data: { state: "done" } });
  writeTree(join(runsDir, A, "sessions"), {
    "2026-11-18T10-00-01-000Z_s1.jsonl": [
      { type: "session", version: 3, cwd: "/w", timestamp: iso(50_000) },
      { type: "message", timestamp: iso(49_000), message: { role: "user", content: [{ type: "text", text: "build the slice" }] } },
      { type: "message", timestamp: iso(48_000), message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }], usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.001 } } } },
      { type: "message", timestamp: iso(47_000), message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  });

  // A direct agent run without a journal: only its log.
  record({ id: B, kind: "agent", spec: { agent: "dev/lab" }, state: "running", startedAt: iso(30_000) });
  writeFileSync(join(runsDir, B, "log"), "line 1\nline 2\nline 3\n");
});

async function call<T = Record<string, unknown>>(name: string, args: unknown, c: ToolContext = ctx): Promise<T> {
  return (await callTool(name, args, c)) as T;
}

describe("observe", () => {
  it("instance_get: the merged config, secrets hidden, and the layer each value came from", async () => {
    const r = await call<{ layers: string[]; config: { server: { port: number }; limit: { tools: { enable: string[] } } }; sources: Record<string, string>; runsDir: string; version: string | null }>("instance_get", {});
    assert.deepEqual(r.layers, ["built-in", `--config ${configFile}`]);
    assert.equal(r.config.server.port, 9123);
    assert.deepEqual(r.config.limit.tools.enable, ["*"]);
    assert.equal(r.sources["server.port"], `--config ${configFile}`);
    assert.equal(r.sources["server.jobTimeoutMinutes"], "built-in");
    assert.equal(r.sources["limit.tools.enable"], `--config ${configFile}`);
    assert.equal(r.runsDir, runsDir);
  });

  it("job_get: by job id, job name or any run inside it: slice, result, callback, steps, children", async () => {
    const byId = await call<Record<string, any>>("job_get", { job: JOB });
    assert.equal(byId.runId, W);
    assert.equal(byId.name, jobName(JOB));
    assert.equal(byId.slice, "Billing/CreateThing");
    assert.equal(byId.attempt, 2);
    assert.deepEqual(byId.result, { outcome: "done", patches: { app: { bytes: 20 } } });
    assert.deepEqual(byId.callback, { done: true });
    assert.deepEqual(byId.steps, [
      { step: "clone", status: "ok", ms: 100 },
      { step: "implement", status: "ok", ms: 2000, childRunId: A },
    ]);
    assert.deepEqual(byId.children.map((c: { id: string; target: string }) => [c.id, c.target]), [[A, "agent:supabase-api"]]);
    assert.equal((await call("job_get", { job: jobName(JOB) })).runId, W);
    assert.equal((await call("job_get", { job: A })).runId, W, "a run inside the job names the job");
    await assert.rejects(callTool("job_get", { job: B }, ctx), /is not a job: it is a direct run of agent dev\/lab/);
  });

  it("journal_query: kind prefixes, tool, text, pages, and blobs read back in full on request", async () => {
    const tools = await call<{ events: JournalEvent[]; next: number | null }>("journal_query", { run: A, kind: "tool.*" });
    assert.equal(tools.events.length, 4);
    assert.equal(tools.next, null);
    const page = await call<{ events: JournalEvent[]; next: number }>("journal_query", { run: A, kind: "tool.end", limit: 1 });
    assert.deepEqual(page.events.map((e) => e.data.tool), ["read"]);
    const rest = await call<{ events: JournalEvent[]; next: number | null }>("journal_query", { run: A, kind: "tool.end", after: page.next });
    assert.deepEqual([rest.events.map((e) => e.data.tool), rest.next], [["npm"], null]);
    assert.deepEqual((await call<{ events: JournalEvent[] }>("journal_query", { run: A, text: "1 FAILING" })).events.map((e) => e.seq), [5]);
    const read = (await call<{ events: JournalEvent[] }>("journal_query", { run: A, tool: "read", kind: "tool.end" })).events[0];
    assert.match(JSON.stringify(read.data.output), /"blob":"sha256:/, "over 8 KB the output is a blob marker");
    const full = (await call<{ events: JournalEvent[] }>("journal_query", { run: A, tool: "read", kind: "tool.end", payloads: true })).events[0];
    assert.equal(full.data.output, "x".repeat(9000));
  });

  it("journal_tail: the last events, then only what is new; a run without a journal gives its log", async () => {
    const t = await call<{ events: JournalEvent[]; lastSeq: number; journal: boolean; state: string }>("journal_tail", { run: A, limit: 2 });
    assert.deepEqual(t.events.map((e) => e.kind), ["turn.end", "run.end"]);
    assert.equal(t.lastSeq, 9);
    assert.equal(t.journal, true);
    assert.deepEqual((await call<{ events: JournalEvent[]; lastSeq: number }>("journal_tail", { run: A, after: 9 })).events, []);
    assert.equal((await call<{ lastSeq: number }>("journal_tail", { run: A, after: 9 })).lastSeq, 9);
    const log = await call<{ journal: boolean; log: { text: string; next: number } }>("journal_tail", { run: B, limit: 2 });
    assert.equal(log.journal, false);
    assert.deepEqual(log.log, { text: "line 2\nline 3", next: 21 });
    writeFileSync(join(runsDir, B, "log"), "line 1\nline 2\nline 3\nline 4\n");
    assert.deepEqual((await call<{ log: unknown }>("journal_tail", { run: B, logFrom: 21 })).log, { text: "line 4\n", next: 28 });
  });

  it("context_get: the job, or a finished step's output from the run or the runs above it; an agent reads its own by default", async () => {
    assert.equal((await call<{ jobId: string }>("context_get", { run: JOB })).jobId, JOB);
    assert.deepEqual(await call("context_get", { run: A, step: "classify" }), { kind: "state-change", verdict: "NEW" }, "the agent step reads its workflow's output");
    const agent: ToolContext = { ...ctx, caller: { kind: "agent", runId: A, agent: "supabase-api", allowed: new Set(["context_get"]) } };
    assert.deepEqual(await call("context_get", { step: "classify" }, agent), { kind: "state-change", verdict: "NEW" });
    await assert.rejects(callTool("context_get", { run: A, step: "scaffold" }, ctx), /^ToolError: step scaffold has not finished: no output in this run's context store or its parents'$/);
    await assert.rejects(callTool("context_get", { run: B }, ctx), /this run has no job: it was started without a dispatch/);
    await assert.rejects(callTool("context_get", {}, ctx), (err) => isToolError(err) && err.code === "invalid" && err.message === "context_get needs a run");
  });

  it("data_list: every data: file an agent can see, nearest first, local/ before committed, shadowed ones marked", async () => {
    const r = await call<{ files: { ref: string; path: string; local: boolean; shadowedBy?: string }[] }>("data_list", { agent: "dev/lab" });
    const rows = r.files.map((f) => [f.ref, f.path.slice(agentics.length + 1), f.local, f.shadowedBy ? f.shadowedBy.slice(agentics.length + 1) : null]);
    assert.deepEqual(rows, [
      ["data:dispatches/a.json", "agents/dev/lab/data/dispatches/a.json", false, null],
      ["data:dispatches/a.json", "agents/dev/data/dispatches/a.json", false, "agents/dev/lab/data/dispatches/a.json"],
      ["data:notes.md", "agents/dev/data/notes.md", false, null],
      ["data:dispatches/b.json", "shared/data/local/dispatches/b.json", true, null],
      ["data:dispatches/b.json", "shared/data/dispatches/b.json", false, "shared/data/local/dispatches/b.json"],
    ]);
    const shared = await call<{ files: { ref: string }[]; agent: null }>("data_list", { path: "dispatches/" });
    assert.equal(shared.agent, null);
    assert.deepEqual(shared.files.map((f) => f.ref), ["data:dispatches/b.json", "data:dispatches/b.json"]);
  });

  it("job_artifacts: each run's files in the job's tree (no workspace), with sizes, and the patches", async () => {
    const r = await call<{ runs: { runId: string; files: { path: string; bytes: number }[] }[]; patches: Record<string, { bytes: number }> }>("job_artifacts", { job: JOB });
    assert.deepEqual(r.runs.map((x) => x.runId), [W, A]);
    const paths = r.runs.flatMap((x) => x.files.map((f) => f.path));
    for (const p of [`${W}/run.json`, `${W}/journal.jsonl`, `${W}/context/job.json`, `${W}/context/outputs/classify.json`, `${A}/journal.jsonl`, `${A}/sessions/2026-11-18T10-00-01-000Z_s1.jsonl`]) assert.ok(paths.includes(p), p);
    assert.ok(!paths.some((p) => p.includes("workspace") || p.includes("blobs/")), "workspaces and blobs are not artifacts");
    assert.deepEqual(r.patches, { app: { bytes: 20 } });
  });

  it("session_entries: the run's pi session, one line per entry, filtered, with its metrics", async () => {
    const r = await call<{ total: number; entries: { kind: string; text: string; tools: string[] }[]; metrics: { turns: number; toolCalls: number } }>("session_entries", { run: A, oldestFirst: true });
    assert.deepEqual(r.entries.map((e) => e.kind), ["session", "user", "assistant", "tool"]);
    assert.equal(r.entries[2].text, "call read: src/a.ts");
    assert.deepEqual([r.metrics.turns, r.metrics.toolCalls], [1, 1]);
    const tools = await call<{ entries: { kind: string }[] }>("session_entries", { run: A, kinds: ["tool"] });
    assert.deepEqual(tools.entries.map((e) => e.kind), ["tool"]);
    await assert.rejects(callTool("session_entries", { run: W }, ctx), /is a workflow run/);
  });

  it("metrics: jobs by outcome, step durations, tool calls with errors, turns and tokens; filtered by builder and tool", async () => {
    const m = await call<Record<string, any>>("metrics", { since: "1d" });
    assert.equal(m.jobs.total, 1);
    assert.equal(m.jobs.done, 1);
    assert.deepEqual(m.steps.implement, { count: 1, ok: 1, failed: 0, avgMs: 2000, maxMs: 2000 });
    assert.deepEqual(m.tools.npm, { count: 1, ok: 0, failed: 1, avgMs: 100, maxMs: 100 });
    assert.equal(m.agents.turns, 2);
    assert.equal(m.agents.tokens.input, 1000);
    const npm = await call<Record<string, any>>("metrics", { builder: "supabase-api", tool: "npm" });
    assert.deepEqual(Object.keys(npm.tools), ["npm"]);
    assert.equal(npm.agents.runs, 1, "only the job's agent run, not the direct one");
    assert.equal((await call<Record<string, any>>("metrics", { builder: "other" })).jobs.total, 0);
    await assert.rejects(callTool("metrics", { since: "12" }, ctx), /since: a seq is not a time/);
  });
});
