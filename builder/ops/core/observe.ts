/**
 * observe: read what the builder is and has done, from files (G8): the machine config with the layer of each value,
 * jobs, journals, the context store, data/ folders, a job's artifacts, pi sessions and metrics. Nothing here changes
 * anything, so the built-in limit (no packaged config) still allows it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { Type } from "typebox";
import { findStepOutput, readContextJob } from "../../engine/context.ts";
import { jobName } from "../../engine/job-name.ts";
import { describeEntry, filterEntries, KINDS, metricsOf, parseSession, type Entry, type Kind } from "../../engine/pi-session.ts";
import { readStory, type StoryEntry } from "../../engine/run-story.ts";
import { redactText } from "../../runtime/journal-client.ts";
import { MAX_SESSION_BYTES } from "../../engine/pi-session-files.ts";
import { parseSince } from "../../runtime/feed.ts";
import { JOURNAL_FILE, journalMetrics, payloadOf, readJournal, stepDurations, treeMetrics, type JournalEvent } from "../../runtime/journal.ts";
import { agentDir, dataCandidates } from "../../runtime/paths.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import { isFinal, type RunRecord } from "../../runtime/types.ts";
import { publicConfig } from "../config.ts";
import { findRun, rootOf, runsDirOf, summarizeRun } from "./common.ts";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

const Run = (what = "A run id, a job id or name, latest, or self") => Type.String({ description: what });
const Limit = (max: number, dflt: number) => Type.Optional(Type.Integer({ minimum: 1, maximum: max, description: `At most this many (default ${dflt})` }));

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** The builder's version: the git commit of builder/ (with -dirty when it has local changes), or null. */
function builderVersion(root: string): string | null {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty", "--abbrev=12"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The last `n` lines of a file, and its size (where to continue from). */
function tailFile(file: string, n: number, from?: number): { text: string; next: number } {
  if (!existsSync(file)) return { text: "", next: 0 };
  const buf = readFileSync(file);
  if (from !== undefined) return { text: buf.subarray(Math.min(from, buf.length)).toString("utf8"), next: buf.length };
  const lines = buf.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { text: lines.slice(-n).join("\n"), next: buf.length };
}

const instanceGet = defineTool({
  name: "instance_get",
  group: "observe",
  description: "This builder instance: its id, version, the merged machine config (secrets hidden) and the layer each value came from.",
  params: Type.Object({}, { additionalProperties: false }),
  run: async (_a: Record<string, never>, ctx: ToolContext) => ({
    instance: ctx.config.instance,
    version: builderVersion(ctx.builderRoot),
    builderRoot: ctx.builderRoot,
    runsDir: runsDirOf(ctx),
    layers: ctx.config.layers,
    config: publicConfig(ctx.config),
    sources: ctx.config.sources,
  }),
});

/** A job's workflow run and what its context store knows. */
function jobOf(ctx: ToolContext, ref: string): { root: RunRecord; dir: string; job: { jobId?: string; dispatch?: { task?: Record<string, unknown>; repo?: Record<string, unknown> }; builder?: { name?: string; version?: string }; deadline?: number } } {
  const root = rootOf(ctx, findRun(ctx, ref));
  if (root.kind !== "workflow") throw new ToolError("failed", `run ${root.id} is not a job: it is ${root.kind === "agent" ? `a direct run of agent ${root.spec.agent}` : `a ${root.kind} run`} (use run_get)`);
  const dir = ctx.runtime.dir(root.id);
  return { root, dir, job: (readContextJob(dir) ?? {}) as ReturnType<typeof jobOf>["job"] };
}

const jobGet = defineTool({
  name: "job_get",
  group: "observe",
  description: "A job (a workflow run, from a server dispatch or started directly): its slice, state, current step, result, callback, step durations, child runs and metrics.",
  params: Type.Object({ job: Run("A job id or name, or any run id inside the job") }, { additionalProperties: false }),
  run: async (a: { job: string }, ctx: ToolContext) => {
    const { root, dir, job } = jobOf(ctx, a.job);
    const task = job.dispatch?.task ?? {};
    const r = root.result;
    const summary = readJson(join(dir, "summary.json")) as { tree?: unknown; metrics?: unknown } | undefined;
    const jobId = root.job?.jobId ?? job.jobId;
    return {
      runId: root.id,
      ...(jobId ? { jobId, name: jobName(jobId) } : {}),
      slice: task.context !== undefined ? `${String(task.context)}/${String(task.title)}` : null,
      attempt: task.attempt ?? null,
      base: job.dispatch?.repo?.base ?? null,
      builder: job.builder ?? { name: root.spec.workflow },
      state: root.state,
      step: root.step ?? null,
      startedAt: root.startedAt,
      endedAt: root.endedAt ?? null,
      result: r ? (r.outcome === "failed" ? { outcome: r.outcome, reason: r.reason, ...(r.halted ? { halted: true } : {}) } : { outcome: r.outcome, patches: Object.fromEntries(Object.entries(r.patches ?? {}).map(([k, v]) => [k, { bytes: Buffer.byteLength(v) }])) }) : null,
      callback: root.job ? { done: !!root.job.callbackDone } : null,
      steps: stepDurations(dir),
      children: ctx.runtime.list().filter((x) => x.parent === root.id).map(summarizeRun),
      metrics: summary?.tree ?? summary?.metrics ?? (existsSync(join(dir, JOURNAL_FILE)) ? treeMetrics(dir) : null),
    };
  },
});

/** An event with its blob markers replaced by the full payloads. */
const withPayloads = (dir: string, e: JournalEvent): JournalEvent => ({ ...e, data: Object.fromEntries(Object.entries(e.data).map(([k, v]) => [k, payloadOf(dir, v)])) });

const journalQuery = defineTool({
  name: "journal_query",
  group: "observe",
  description: "Search a run's journal: by kind (tool.end, or tool.* for a prefix), step, tool and text, a page at a time (after: the last seq you have).",
  params: Type.Object(
    {
      run: Run(),
      kind: Type.Optional(Type.String({ description: "A kind, or a prefix ending in * (tool.*)" })),
      step: Type.Optional(Type.String()),
      tool: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ description: "Case-insensitive, anywhere in the event" })),
      after: Type.Optional(Type.Integer({ minimum: 0, description: "Only events with a larger seq" })),
      limit: Limit(1000, 100),
      payloads: Type.Optional(Type.Boolean({ description: "Replace blob markers with the full payloads" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { run: string; kind?: string; step?: string; tool?: string; text?: string; after?: number; limit?: number; payloads?: boolean }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    const dir = ctx.runtime.dir(rec.id);
    const limit = a.limit ?? 100;
    const got = readJournal(dir, { ...(a.kind ? { kind: a.kind } : {}), ...(a.step ? { step: a.step } : {}), ...(a.tool ? { tool: a.tool } : {}), ...(a.text ? { text: a.text } : {}), ...(a.after !== undefined ? { after: a.after } : {}), limit: limit + 1 });
    const page = got.slice(0, limit);
    return { runId: rec.id, events: a.payloads ? page.map((e) => withPayloads(dir, e)) : page, next: got.length > limit ? page[page.length - 1].seq : null };
  },
});

const journalTail = defineTool({
  name: "journal_tail",
  group: "observe",
  description: "The end of a run's journal (or, for a run without one, of its log). Pass after (the last seq you have) to get only what is new.",
  params: Type.Object(
    {
      run: Run(),
      limit: Limit(1000, 20),
      after: Type.Optional(Type.Integer({ minimum: 0, description: "Only events with a larger seq" })),
      logFrom: Type.Optional(Type.Integer({ minimum: 0, description: "A run without a journal: the log from this byte offset (the last answer's log.next)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { run: string; limit?: number; after?: number; logFrom?: number }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    const dir = ctx.runtime.dir(rec.id);
    const limit = a.limit ?? 20;
    const journal = existsSync(join(dir, JOURNAL_FILE));
    const all = readJournal(dir, a.after !== undefined ? { after: a.after } : {});
    const events = a.after !== undefined ? all.slice(0, Math.max(limit, 500)) : all.slice(-limit);
    const lastSeq = events.length ? events[events.length - 1].seq : (a.after ?? 0);
    return {
      runId: rec.id,
      state: rec.state,
      ...(rec.step ? { step: rec.step } : {}),
      journal,
      events,
      lastSeq,
      ...(journal ? {} : { log: tailFile(join(dir, "log"), limit, a.logFrom) }),
    };
  },
});

const contextGet = defineTool({
  name: "context_get",
  group: "observe",
  description:
    "Read a run's context store: with no step, the job (the dispatch being built); with a step, that finished step's output (for example the scaffold report), from the run or the runs above it. An agent reads its own run's by default.",
  params: Type.Object(
    {
      run: Type.Optional(Run("A run id, a job id or name, or latest; default: your own run")),
      step: Type.Optional(Type.String({ description: "A finished step's name, e.g. scaffold" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { run?: string; step?: string }, ctx: ToolContext) => {
    const runId = a.run ? findRun(ctx, a.run).id : ctx.caller.runId;
    if (!runId) throw new ToolError("invalid", "context_get needs a run");
    const dir = ctx.runtime.dir(runId);
    if (!a.step) {
      const job = readContextJob(dir);
      if (job === undefined) throw new ToolError("failed", "this run has no job: it was started without a dispatch");
      return job;
    }
    const out = findStepOutput(a.step, dir);
    if (!out.found) throw new ToolError("failed", `step ${a.step} has not finished: no output in this run's context store or its parents'`);
    return out.value;
  },
});

/** Every file under `root` (relative, with / separators), leaving out `skip` directly below it. */
function walk(root: string, skip: string[] = []): string[] {
  const out: string[] = [];
  const go = (dir: string, depth: number) => {
    if (depth > 8 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (dir === root && skip.includes(e.name)) continue;
      if (e.isDirectory()) go(p, depth + 1);
      else if (e.isFile()) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  go(root, 0);
  return out;
}

const dataList = defineTool({
  name: "data_list",
  group: "observe",
  description: "The data: files an agent can see (its own data/, the folders above it, shared/data), where each comes from, and which a nearer one shadows. data/local/ comes first at each level.",
  params: Type.Object(
    {
      agent: Type.Optional(Type.String({ description: "An agent id (default: yours; without one, shared/data only)" })),
      path: Type.Optional(Type.String({ description: "Only files under this path, e.g. dispatches/" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { agent?: string; path?: string }, ctx: ToolContext) => {
    const agentics = ctx.runtime.options.agenticsDir ?? AGENTICS_DIR;
    const agent = a.agent ?? ctx.caller.agent;
    const dir = agent ? agentDir(agent, agentics) : undefined;
    // dataCandidates of "" are the roots themselves, nearest first, local/ before the committed folder.
    const roots = dataCandidates("", { ...(dir ? { agentDir: dir } : {}), agentics });
    const files: { ref: string; path: string; root: string; local: boolean; shadowedBy?: string }[] = [];
    const winner = new Map<string, string>();
    for (const root of roots) {
      const local = basename(root) === "local";
      for (const rel of walk(root, local ? [] : ["local"])) {
        if (a.path && !rel.startsWith(a.path.replace(/^data:/, ""))) continue;
        const path = join(root, rel);
        const first = winner.get(rel);
        if (!first) winner.set(rel, path);
        files.push({ ref: `data:${rel}`, path, root, local, ...(first ? { shadowedBy: first } : {}) });
      }
    }
    return { agent: agent ?? null, roots: roots.filter((r) => existsSync(r)), files };
  },
});

/** The run and every run below it. */
function treeOf(ctx: ToolContext, root: RunRecord): RunRecord[] {
  const all = ctx.runtime.list();
  const out = [root];
  for (let i = 0; i < out.length && out.length < 500; i++) out.push(...all.filter((r) => r.parent === out[i].id));
  return out;
}

const jobArtifacts = defineTool({
  name: "job_artifacts",
  group: "observe",
  description: "What a job left: per run in its tree, run.json, the log, the journal, summary.json, context/ outputs and pi sessions, with sizes (paths relative to the runs directory), and the patches it produced.",
  params: Type.Object({ job: Run("A job id or name, or any run id inside the job") }, { additionalProperties: false }),
  run: async (a: { job: string }, ctx: ToolContext) => {
    const root = rootOf(ctx, findRun(ctx, a.job));
    const runsDir = runsDirOf(ctx);
    const runs = treeOf(ctx, root).map((r) => {
      const dir = ctx.runtime.dir(r.id);
      const files = walk(dir, ["workspace", "blobs"])
        .filter((f) => !f.endsWith(".sock"))
        .map((f) => ({ path: relative(runsDir, join(dir, f)).split(sep).join("/"), bytes: statSync(join(dir, f)).size }));
      return { runId: r.id, target: summarizeRun(r).target, state: r.state, files };
    });
    const patches = root.result?.outcome === "done" ? Object.fromEntries(Object.entries(root.result.patches ?? {}).map(([k, v]) => [k, { bytes: Buffer.byteLength(v) }])) : {};
    return { runId: root.id, runsDir, runs, patches };
  },
});

/** Where an agent run's pi sessions are: its --session-dir. */
function sessionDir(ctx: ToolContext, rec: RunRecord): string {
  const argv = rec.resolved?.argv ?? [];
  const i = argv.indexOf("--session-dir");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : join(ctx.runtime.dir(rec.id), "sessions");
}

const sessionEntries = defineTool({
  name: "session_entries",
  group: "observe",
  description: "An agent run's pi session: its entries described in one line each (filter by kind, tool and text), with the session's metrics.",
  params: Type.Object(
    {
      run: Run(),
      kinds: Type.Optional(Type.Array(Type.Union(KINDS.map((k) => Type.Literal(k))), { description: `Any of ${KINDS.join(", ")}` })),
      tools: Type.Optional(Type.Array(Type.String())),
      text: Type.Optional(Type.String()),
      oldestFirst: Type.Optional(Type.Boolean()),
      limit: Limit(1000, 50),
    },
    { additionalProperties: false },
  ),
  run: async (a: { run: string; kinds?: Kind[]; tools?: string[]; text?: string; oldestFirst?: boolean; limit?: number }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    if (rec.kind !== "agent") throw new ToolError("failed", `run ${rec.id} is a ${rec.kind} run: only agent runs have pi sessions${rec.kind === "workflow" ? " (job_get lists its agents' runs)" : ""}`);
    const dir = sessionDir(ctx, rec);
    const files = walk(dir).filter((f) => f.endsWith(".jsonl"));
    const entries: (Entry & { file: string })[] = [];
    for (const f of files) {
      const path = join(dir, f);
      if (statSync(path).size > MAX_SESSION_BYTES) continue;
      for (const e of parseSession(readFileSync(path, "utf8"))) entries.push({ ...e, file: f });
    }
    const shown = filterEntries(entries, { ...(a.kinds ? { kinds: a.kinds } : {}), ...(a.tools ? { tools: a.tools } : {}), ...(a.text ? { text: a.text } : {}), newestFirst: !a.oldestFirst }) as (Entry & { file: string })[];
    return {
      runId: rec.id,
      sessionDir: dir,
      files,
      metrics: metricsOf(entries),
      total: shown.length,
      entries: shown.slice(0, a.limit ?? 50).map((e) => ({ file: e.file, n: e.n, ts: e.ts ? new Date(e.ts).toISOString() : null, kind: e.kind, tools: e.tools, text: describeEntry(e) })),
    };
  },
});

/** A run's slice and model from its journal and context store, for a list row. */
function rowOf(ctx: ToolContext, r: RunRecord) {
  const dir = ctx.runtime.dir(r.id);
  const job = readContextJob(dir) as { dispatch?: { task?: { context?: unknown; title?: unknown; attempt?: unknown } } } | undefined;
  const task = job?.dispatch?.task;
  const summary = readJson(join(dir, "summary.json")) as { tree?: Record<string, unknown>; metrics?: Record<string, unknown> } | undefined;
  const m = summary?.tree ?? summary?.metrics;
  const end = r.endedAt ? Date.parse(r.endedAt) : isFinal(r.state) ? Date.parse(r.startedAt) : Date.now();
  return {
    ...summarizeRun(r),
    ...(task ? { slice: `${String(task.context)}/${String(task.title)}`, attempt: task.attempt ?? null } : {}),
    durationMs: Math.max(0, end - Date.parse(r.startedAt)),
    ...(m ? { metrics: { turns: m.turns ?? 0, toolCalls: m.toolCalls ?? 0, toolErrors: m.toolErrors ?? 0, tokens: m.tokens ?? null, cost: m.cost ?? 0, model: m.model ?? null } } : {}),
  };
}

const runStories = defineTool({
  name: "run_stories",
  group: "observe",
  description:
    "The runs whose story can be read with run_story, newest first: each job (a workflow run with no parent) and each run started directly (the ops agent, an agent or workflow run from the CLI), with its slice, duration, outcome and totals. The runs inside them (an agent step, a tool summariser, a workflow an agent started) are part of their story.",
  params: Type.Object(
    {
      limit: Limit(1000, 100),
      since: Type.Optional(Type.String({ description: "A time (ISO 8601) or a duration such as 7d: only runs started since then" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { limit?: number; since?: string }, ctx: ToolContext) => {
    let since = 0;
    if (a.since) {
      const s = parseSince(a.since);
      if (!("time" in s)) throw new ToolError("invalid", "since: a time or a duration, not a seq");
      since = s.time;
    }
    const all = ctx.runtime.list();
    const ids = new Set(all.map((r) => r.id));
    const roots = all.filter((r) => r.kind !== "server" && (!r.parent || !ids.has(r.parent)) && Date.parse(r.startedAt) >= since).reverse();
    return { total: roots.length, runs: roots.slice(0, a.limit ?? 100).map((r) => rowOf(ctx, r)) };
  },
});

/** A text field cut to `max` characters, saying how much was left out. */
const cut = (s: string | undefined, max: number): string | undefined => (s === undefined || s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more characters: journal_query with payloads has the rest)`);

const runStory = defineTool({
  name: "run_story",
  group: "observe",
  description:
    "The whole story of a run from the journals: for a job, its workflow run and every run below it (its agent, the tool summarisers) merged in time order. Entries: run and step events, the model and thinking level, the system prompt sections, the prompts, each model response (thinking, text, tool calls with their input, tokens and cost), each tool result (output, time, outcome, gates). With totals for the whole run.",
  params: Type.Object(
    {
      run: Run("A run id, a job id or name, latest, or self: any run in the tree (the story is the tree's root's)"),
      tree: Type.Optional(Type.Boolean({ description: "false: only this run, not its root's tree (default true)" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 1_000_000, description: "Cut each text field to this many characters (default 65536)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { run: string; tree?: boolean; maxChars?: number }, ctx: ToolContext) => {
    const rec = findRun(ctx, a.run);
    const root = a.tree === false ? rec : rootOf(ctx, rec);
    const all = ctx.runtime.list();
    const story = readStory(runsDirOf(ctx), root.id, a.tree === false ? [] : all.map((r) => ({ id: r.id, parent: r.parent })));
    const max = a.maxChars ?? 65536;
    const entries = story.entries.map(
      (e): StoryEntry => ({
        ...e,
        ...(e.text !== undefined ? { text: cut(e.text, max) } : {}),
        ...(e.thinking !== undefined ? { thinking: cut(e.thinking, max) } : {}),
        ...(e.output !== undefined ? { output: cut(e.output, max) } : {}),
        ...(e.sections ? { sections: Object.fromEntries(Object.entries(e.sections).map(([k, v]) => [k, typeof v === "string" ? cut(v, max)! : v])) } : {}),
      }),
    );
    return { ...rowOf(ctx, root), ...story, entries };
  },
});

const runLog = defineTool({
  name: "run_log",
  group: "observe",
  description:
    "The end of a run's log (runs/<id>/log, the run's own output: for a job, its steps' commands, the pi command and prompt and pi's output; for the build server, its requests and jobs), with secrets hidden. run: a run, a job id or name, latest, or server (the newest build server run).",
  params: Type.Object(
    {
      run: Run("A run id, a job id or name, latest, or server"),
      lines: Limit(20000, 300),
      events: Type.Optional(Type.Boolean({ description: "Keep pi's raw JSON event lines (a headless agent's output; the journal has them as events). Default false" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { run: string; lines?: number; events?: boolean }, ctx: ToolContext) => {
    const rec = a.run === "server" ? [...ctx.runtime.list()].reverse().find((r) => r.kind === "server") : findRun(ctx, a.run);
    if (!rec) throw new ToolError("failed", `no build server run in ${runsDirOf(ctx)}`);
    const file = join(ctx.runtime.dir(rec.id), "log");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    let lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const all = lines.length;
    // pi --mode json writes one {"type":...} event per line: the journal holds them, the log's reader wants the rest.
    if (!a.events) lines = lines.filter((l) => !l.startsWith('{"type":'));
    const hidden = all - lines.length;
    return {
      runId: rec.id,
      kind: rec.kind,
      state: rec.state,
      ...(rec.job ? { jobId: rec.job.jobId, job: jobName(rec.job.jobId) } : {}),
      bytes: Buffer.byteLength(text),
      ...(hidden ? { hiddenEvents: hidden } : {}),
      text: redactText(lines.slice(-(a.lines ?? 300)).join("\n")),
    };
  },
});

interface Agg {
  count: number;
  ok: number;
  failed: number;
  totalMs: number;
  maxMs: number;
}
const agg = (): Agg => ({ count: 0, ok: 0, failed: 0, totalMs: 0, maxMs: 0 });
const add = (m: Agg, ok: boolean, ms: number) => {
  m.count++;
  if (ok) m.ok++;
  else m.failed++;
  m.totalMs += ms;
  m.maxMs = Math.max(m.maxMs, ms);
};
const report = (m: Record<string, Agg>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { count: v.count, ok: v.ok, failed: v.failed, avgMs: v.count ? Math.round(v.totalMs / v.count) : 0, maxMs: v.maxMs }]));

const metrics = defineTool({
  name: "metrics",
  group: "observe",
  description: "Metrics over a period, from the journals: jobs by outcome, step durations, tool calls (count, errors, time), turns, tokens and cost. Filter by builder, agent, step and tool.",
  params: Type.Object(
    {
      since: Type.Optional(Type.String({ description: "A time (ISO 8601) or a duration such as 1d (default 7d)" })),
      until: Type.Optional(Type.String({ description: "A time (ISO 8601); default now" })),
      builder: Type.Optional(Type.String({ description: "Only jobs of this builder (its id or name)" })),
      agent: Type.Optional(Type.String({ description: "Only runs of this agent" })),
      step: Type.Optional(Type.String()),
      tool: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  run: async (a: { since?: string; until?: string; builder?: string; agent?: string; step?: string; tool?: string }, ctx: ToolContext) => {
    let since: number;
    try {
      const s = parseSince(a.since ?? "7d");
      if (!("time" in s)) throw new Error("a seq is not a time");
      since = s.time;
    } catch (err) {
      throw new ToolError("invalid", `since: ${(err as Error).message}`);
    }
    const until = a.until ? Date.parse(a.until) : Date.now();
    if (Number.isNaN(until)) throw new ToolError("invalid", `until ${a.until} is not a time`);
    const inPeriod = ctx.runtime.list().filter((r) => {
      const t = Date.parse(r.startedAt);
      return t >= since && t <= until;
    });
    const builderOf = (r: RunRecord) => {
      const b = (readContextJob(ctx.runtime.dir(r.id)) as { builder?: { name?: string } } | undefined)?.builder?.name;
      return [r.spec.workflow, b].filter((x): x is string => !!x);
    };
    const jobs = inPeriod.filter((r) => r.kind === "workflow" && (!r.parent || ctx.runtime.get(r.parent)?.kind !== "workflow") && (!a.builder || builderOf(r).includes(a.builder)));
    const jobIds = new Set(jobs.map((j) => j.id));
    const inJobs = (r: RunRecord) => {
      for (let cur: RunRecord | null = r, d = 0; cur && d < 32; cur = cur.parent ? ctx.runtime.get(cur.parent) : null, d++) if (jobIds.has(cur.id)) return true;
      return false;
    };
    const agents = inPeriod.filter((r) => r.kind === "agent" && (!a.agent || r.spec.agent === a.agent) && (!a.builder || inJobs(r)));
    const outcomes: Record<string, number> = {};
    let jobMs = 0;
    for (const j of jobs) {
      const key = isFinal(j.state) ? (j.result?.outcome === "done" ? "done" : j.state === "stopped" ? "stopped" : "failed") : "running";
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (j.endedAt) jobMs += Date.parse(j.endedAt) - Date.parse(j.startedAt);
    }
    const steps: Record<string, Agg> = {};
    for (const j of jobs) {
      for (const s of stepDurations(ctx.runtime.dir(j.id))) {
        if (a.step && s.step !== a.step) continue;
        add((steps[s.step] ??= agg()), s.status === "ok", s.ms);
      }
    }
    const tools: Record<string, Agg> = {};
    const totals = { runs: agents.length, turns: 0, toolCalls: 0, toolErrors: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, cost: 0 };
    for (const r of agents) {
      const dir = ctx.runtime.dir(r.id);
      if (a.step && r.spec.step !== a.step) continue;
      const m = journalMetrics(dir);
      totals.turns += m.turns;
      totals.toolCalls += m.toolCalls;
      totals.toolErrors += m.toolErrors;
      totals.tokens.input += m.tokens.input;
      totals.tokens.output += m.tokens.output;
      totals.tokens.cacheRead += m.tokens.cacheRead;
      totals.cost += m.cost;
      for (const e of readJournal(dir, { kind: "tool.end", ...(a.tool ? { tool: a.tool } : {}) })) {
        const name = typeof e.data.tool === "string" ? e.data.tool : "?";
        add((tools[name] ??= agg()), e.data.isError !== true, typeof e.data.ms === "number" ? e.data.ms : 0);
      }
    }
    return {
      period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
      jobs: { total: jobs.length, ...outcomes, avgMs: jobs.filter((j) => j.endedAt).length ? Math.round(jobMs / jobs.filter((j) => j.endedAt).length) : 0 },
      steps: report(steps),
      agents: totals,
      tools: report(tools),
    };
  },
});

export const tools: ToolDef[] = [instanceGet, jobGet, journalQuery, journalTail, contextGet, dataList, jobArtifacts, sessionEntries, runStories, runStory, runLog, metrics];
