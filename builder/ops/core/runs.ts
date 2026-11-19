/**
 * runs: start, list, read, stop and wait for runs, resolve a run spec without starting it, reset a run's workspace.
 * Everything goes through the caller's runtime, so an agent's runs are its children: E8 (runs.may_start) and the tool
 * ceiling apply, and they stop with it unless detached (E23). E16: a run starts at once in its own workspace, whatever
 * the server is doing.
 */
import { join } from "node:path";
import { Type } from "typebox";
import { loadAgent, redactEnv, resolve } from "../../runtime/resolve.ts";
import { liveLimit, NO_LIMIT, runProcessAlive } from "../../runtime/run.ts";
import { isFinal, MODES, type Mode, type RunRecord, type RunSpec, type RunState } from "../../runtime/types.ts";
import { prepareWorkspace } from "../../runtime/workspace.ts";
import { findRun, isAncestor, rootOf, runsDirOf, summarizeRun } from "./common.ts";
import { callerLabel, defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

const Run = (what = "A run id, a job id or name, latest, or self") => Type.String({ description: what });
const ModeT = Type.Union(MODES.map((m) => Type.Literal(m)));
const Settings = Type.Object({ provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()) }, { additionalProperties: false });

/** A run spec (design section 2): runtime/types.ts RunSpec, as the tools take it. */
export const RunSpecSchema = Type.Object(
  {
    agent: Type.Optional(Type.String({ description: "An agent id (its path under agentics/agents/)" })),
    workflow: Type.Optional(Type.String({ description: "A builder id or a path to a builder module" })),
    mode: Type.Optional(ModeT),
    workspace: Type.Optional(Type.Unknown({ description: 'empty | none | { dir: { path } } | { dir: "parent" } (your own workspace) | { snapshot: { from, ref?, into? } }; paths may be area:, data:, ~ or absolute' })),
    input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "dispatch (inline, data: path or file), args, message, base, repos, ..." })),
    settings: Type.Optional(Settings),
    steps: Type.Optional(Type.Record(Type.String(), Type.Object({ mode: Type.Optional(ModeT), agent: Type.Optional(Type.String()), settings: Type.Optional(Settings) }, { additionalProperties: false }))),
    journal: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.String()),
    detach: Type.Optional(Type.Boolean({ description: "Keep running when the run that started it ends" })),
    budgetMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
);

type SpecArgs = Omit<RunSpec, "step">;

/** The calling run's record (an agent's or an api run's), or null for the CLI. */
const callerRun = (ctx: ToolContext): RunRecord | null => (ctx.caller.runId ? ctx.runtime.get(ctx.caller.runId) : null);

/** The machine limit the caller's runs get now: a reload's, when the calling run was told one. */
const limitFor = (ctx: ToolContext) => liveLimit(ctx.caller.runId ? ctx.runtime.dir(ctx.caller.runId) : null, ctx.runtime.options.limit ?? NO_LIMIT);

/** The mode a spec runs in: its own, else the agent.yml's, else headless (a workflow run is always headless). */
function modeOf(ctx: ToolContext, spec: RunSpec): Mode {
  if (spec.mode) return spec.mode;
  if (!spec.agent) return "headless";
  try {
    return loadAgent(spec.agent, ctx.runtime.options.agenticsDir).yml.mode ?? "headless";
  } catch {
    return "headless"; // the runtime names what is wrong with the agent
  }
}

const runStart = defineTool({
  name: "run_start",
  group: "runs",
  description:
    "Start a run from a run spec: an agent or a workflow, its mode, workspace (workspace { dir: parent } shares yours), input (a dispatch, args, a message) and settings. It starts at once and runs in its own process; follow it with run_wait, journal_tail or context_get. Its budget is at most what is left of yours. A run you start stops when your run ends unless detach is true. From the CLI use builder run, or detach: a non-detached run stops when the command ends.",
  params: RunSpecSchema,
  run: async (a: SpecArgs, ctx: ToolContext) => {
    const spec: RunSpec = { ...a };
    if (ctx.caller.kind !== "cli" && modeOf(ctx, spec) === "interactive") throw new ToolError("invalid", "an interactive run needs a terminal: start it with builder run, or give another mode (headless, rpc, durable)");
    let rec: RunRecord;
    try {
      rec = await ctx.runtime.start(spec, ctx.caller.runId ? { parent: ctx.caller.runId } : {});
    } catch (err) {
      throw new ToolError(/refused/.test((err as Error).message) ? "refused" : "failed", (err as Error).message);
    }
    return {
      runId: rec.id,
      dir: ctx.runtime.dir(rec.id),
      state: rec.state,
      mode: rec.resolved?.mode ?? "headless",
      cwd: rec.resolved?.cwd ?? null,
      tools: rec.resolved?.tools ?? [],
      pid: rec.pid,
      ...(rec.budgetMinutes !== undefined ? { budgetMinutes: rec.budgetMinutes, deadline: rec.deadline } : {}),
      ...(spec.detach ? { detach: true } : {}),
    };
  },
});

const STATES: readonly string[] = ["starting", "running", "done", "failed", "stopped", "live", "ended"];

const runList = defineTool({
  name: "run_list",
  group: "runs",
  description: "Runs, newest first: id, agent or workflow, state, step, mode, parent, job, outcome. Filter by state (or live, ended), kind, target, parent or job.",
  params: Type.Object(
    {
      state: Type.Optional(Type.Union(STATES.map((s) => Type.Literal(s)))),
      kind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("workflow"), Type.Literal("server")])),
      target: Type.Optional(Type.String({ description: "agent:<id> or workflow:<id>, * as a wildcard" })),
      parent: Type.Optional(Type.String({ description: "Only the children of this run (self: yours)" })),
      job: Type.Optional(Type.String({ description: "Only the runs of this job (its id or name)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "At most this many (default 50)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { state?: string; kind?: "agent" | "workflow" | "server"; target?: string; parent?: string; job?: string; limit?: number }, ctx: ToolContext) => {
    const parent = a.parent === "self" ? ctx.caller.runId : a.parent;
    const jobRoot = a.job ? rootOf(ctx, findRun(ctx, a.job)).id : null;
    const glob = a.target ? new RegExp(`^${a.target.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`) : null;
    const runs = ctx.runtime
      .list()
      .reverse()
      .filter((r) => {
        if (a.state === "live" ? isFinal(r.state) : a.state === "ended" ? !isFinal(r.state) : a.state && r.state !== (a.state as RunState)) return false;
        if (a.kind && r.kind !== a.kind) return false;
        if (glob && !glob.test(summarizeRun(r).target)) return false;
        if (parent && r.parent !== parent) return false;
        if (jobRoot && rootOf(ctx, r).id !== jobRoot) return false;
        return true;
      });
    const limit = a.limit ?? 50;
    return { runsDir: runsDirOf(ctx), total: runs.length, runs: runs.slice(0, limit).map(summarizeRun) };
  },
});

const runGet = defineTool({
  name: "run_get",
  group: "runs",
  description: "A run's record (run.json: spec, what it resolved to, state, step, result with its patches), its folder, whether its process is alive, and its children.",
  params: Type.Object({ run: Run() }, { additionalProperties: false }),
  run: async (a: { run: string }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    return {
      ...rec,
      dir: ctx.runtime.dir(rec.id),
      alive: !isFinal(rec.state) && runProcessAlive(rec),
      children: ctx.runtime
        .list()
        .filter((r) => r.parent === rec.id)
        .map((r) => r.id),
    };
  },
});

const runStop = defineTool({
  name: "run_stop",
  group: "runs",
  description: "Stop a run (SIGTERM, SIGKILL after 5 s): it ends stopped with the reason, and its children stop with it (except detached ones). A server job is cancelled with control_send instead, so its callback says why.",
  params: Type.Object({ run: Run("A run id"), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
  run: async (a: { run: string; reason?: string }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    if (isFinal(rec.state)) return { runId: rec.id, state: rec.state, result: rec.result ?? null, already: true };
    const root = rootOf(ctx, rec);
    if (root.job) throw new ToolError("refused", `run ${rec.id} belongs to server job ${root.job.jobId}: cancel it with control_send { action: "cancel" }, so the gaffer is told why`);
    const self = callerRun(ctx);
    if (self && isAncestor(ctx, rec.id, self)) throw new ToolError("refused", `run ${rec.id} is your own run or one above it`);
    await ctx.runtime.stop(rec.id, a.reason ?? `stopped by ${callerLabel(ctx.caller)}`);
    const after = ctx.runtime.get(rec.id);
    return { runId: rec.id, state: after?.state ?? "stopped", result: after?.result ?? null };
  },
});

const runWait = defineTool({
  name: "run_wait",
  group: "runs",
  description: "Wait for a run to end and return its result (done with its data and patches, or failed with the reason) and, for a run that called done, its done arguments as `done`. Gives up after timeoutSeconds (default 1800; 0 waits as long as it takes) and says so.",
  params: Type.Object({ run: Run(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  run: async (a: { run: string; timeoutSeconds?: number }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    const seconds = a.timeoutSeconds ?? 1800;
    const ac = new AbortController();
    const timer = seconds > 0 ? setTimeout(() => ac.abort(new Error("timeout")), seconds * 1000) : undefined;
    try {
      const result = await ctx.runtime.wait(rec.id, ac.signal);
      // A child's done arguments (shared:outcome's done.json), the subagent's answer to its parent.
      const done = result.outcome === "done" ? (result.data as { done?: unknown } | undefined)?.done : undefined;
      return { runId: rec.id, state: ctx.runtime.get(rec.id)?.state ?? null, result, ...(done !== undefined && done !== null ? { done } : {}) };
    } catch (err) {
      if (!ac.signal.aborted) throw err;
      const now = ctx.runtime.get(rec.id);
      return { runId: rec.id, state: now?.state ?? null, ...(now?.step ? { step: now.step } : {}), timedOut: true };
    } finally {
      clearTimeout(timer);
    }
  },
});

const configResolve = defineTool({
  name: "config_resolve",
  group: "runs",
  description: "What a run spec would load, without starting it: the agent.yml and defaults.yml, the mode, workspace, tools (within the machine limit and your own), every skill, extension and prompt with its hash, pi's arguments and environment (secrets hidden).",
  params: RunSpecSchema,
  run: async (a: SpecArgs, ctx: ToolContext) => {
    try {
      const r = resolve({ ...a }, { config: { limit: limitFor(ctx) }, parent: callerRun(ctx), ...(ctx.runtime.options.agenticsDir ? { agentics: ctx.runtime.options.agenticsDir } : {}) });
      return { ...r, env: redactEnv(r.env) };
    } catch (err) {
      throw new ToolError(/refused/.test((err as Error).message) ? "refused" : "failed", (err as Error).message);
    }
  },
});

const workspaceReset = defineTool({
  name: "workspace_reset",
  group: "runs",
  description: "Refill an ended run's workspace from where it came from: a snapshot is copied again, an empty workspace is emptied. A dir workspace is worked in place and has nothing to reset.",
  params: Type.Object({ run: Run("A run id") }, { additionalProperties: false }),
  run: async (a: { run: string }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    if (!isFinal(rec.state)) throw new ToolError("refused", `run ${rec.id} is ${rec.state}: stop it first`);
    const self = callerRun(ctx);
    if (ctx.caller.kind === "agent" && self && !isAncestor(ctx, self.id, rec)) throw new ToolError("refused", `run ${rec.id} was not started by your run`);
    const ws = rec.resolved?.workspace;
    if (!ws || ws === "none") throw new ToolError("failed", `run ${rec.id} has no workspace`);
    if (typeof ws === "object" && "dir" in ws) throw new ToolError("failed", `run ${rec.id} worked in place in ${ws.dir.path}: there is nothing to reset`);
    const cwd = prepareWorkspace(ctx.runtime.dir(rec.id), ws, { snapshotsDir: join(runsDirOf(ctx), ".snapshots") });
    return { runId: rec.id, workspace: cwd, from: ws === "empty" ? "empty" : ws.snapshot.from };
  },
});

export const tools: ToolDef[] = [runStart, runList, runGet, runStop, runWait, configResolve, workspaceReset];
