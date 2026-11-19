/**
 * The story of a run, read from journals only (the journal is the source of truth): what the agent did (each tool call
 * with its input and output) and why (the system prompt, the prompts, the model's thinking and replies, and the tokens
 * each response used), for a run and every run below it, merged into one list of entries in time order.
 *
 * A job's work is spread over a tree of runs (the job's workflow run, its agent's run, each tool-summariser run); its
 * story is the whole tree, so the Builder screen's Sessions tab shows one entry list and one set of totals per job, as
 * the previous design's pi session view did.
 *
 * Entries, from the journal events (agentics/shared/extensions/journal.ts, runtime/main.ts, engine/workflow.ts):
 *
 *   run         run.start, agent.start, agent.outcome, run.end, job.accepted, job.result, callback.*: the run's own
 *               events, one line each
 *   step        step.start, step.end (a workflow step)
 *   meta        model.select: the model and thinking level
 *   system      model.system: the prompt sections the model gets
 *   user        model.prompt: a prompt, follow-up or custom message
 *   assistant   model.message with its turn's model.usage: thinking, text, the tool calls with their input
 *               (tool.start), and the tokens and cost of that response. An older journal without model.message gives
 *               one per model.usage, with no text.
 *   tool        tool.end (with its tool.start and tool.gate events): the tool, its input, output, time and outcome
 *   tool-error  the same, for a call that failed, was blocked or was invalid
 *   other       anything else (listener events, hints, journal.merged)
 *
 * Every entry keeps the raw journal events behind it. Payloads moved to blobs are read back in full (payloadOf), or
 * their preview once the blob is gone.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { payloadOf, readJournal, type JournalEvent } from "../runtime/journal.ts";

export type StoryKind = "run" | "step" | "meta" | "system" | "user" | "assistant" | "tool" | "tool-error" | "other";

export const STORY_KIND_LABEL: Record<StoryKind, string> = {
  run: "run",
  step: "step",
  meta: "config",
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool result",
  "tool-error": "tool error",
  other: "other",
};

export const STORY_KINDS = Object.keys(STORY_KIND_LABEL) as StoryKind[];

export interface StoryUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface StoryCall {
  id: string;
  name: string;
  input: unknown;
}

export interface StoryEntry {
  /** Position in the story, from 1. */
  n: number;
  ts: string;
  runId: string;
  agent?: string;
  step?: string;
  kind: StoryKind;
  /** The tools this entry calls (assistant) or answers (tool). */
  tools: string[];
  /** A one-line summary (run, step, meta, other entries, and an assistant entry's error). */
  line?: string;
  /** user and assistant: the text; system: the leading instruction text, if any. */
  text?: string;
  thinking?: string;
  /** system: the sections the message declares or replaces (null removes one). */
  sections?: Record<string, string | null>;
  toolsAdded?: string[];
  toolsRemoved?: string[];
  /** assistant: the tool calls, with their input. */
  calls?: StoryCall[];
  usage?: StoryUsage;
  thinkingLevel?: string;
  stopReason?: string;
  /** tool: the call. */
  tool?: string;
  input?: unknown;
  output?: string;
  ms?: number;
  /** ok | error | blocked | invalid */
  outcome?: string;
  gates?: { gate: string; decision: string; reason?: string }[];
  /** The journal events this entry was made from. */
  raw: JournalEvent[];
}

export interface StoryRun {
  runId: string;
  parent: string | null;
  agent?: string;
  step?: string;
  events: number;
}

export interface StoryMetrics {
  entries: number;
  durationMs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** The model of the main agent (the one with the most turns), and every model used. */
  model: string;
  models: string[];
  thinking: string;
  topTools: [string, number][];
}

export interface Story {
  runId: string;
  runs: StoryRun[];
  metrics: StoryMetrics;
  entries: StoryEntry[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clip = (s: string, n = 200): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A field as written, its blob read back. JSON text from a blob that held an object is parsed again. */
function full(dir: string, v: unknown): unknown {
  const out = payloadOf(dir, v);
  if (out !== v && typeof out === "string" && /^[[{]/.test(out)) {
    try {
      return JSON.parse(out) as unknown;
    } catch {
      return out;
    }
  }
  return out;
}

const textOf = (dir: string, v: unknown): string => str(full(dir, v));

/** The runs of a tree, root first: each run's children are the runs whose run.start names it as parent. */
export function treeRuns(runsDir: string, rootId: string, all: { id: string; parent: string | null }[]): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length && out.length < 500; i++) for (const r of all) if (r.parent === out[i] && !out.includes(r.id)) out.push(r.id);
  return out.filter((id) => existsSync(join(runsDir, id)));
}

/** One line for a run's own event. */
function runLine(e: JournalEvent): string {
  const d = e.data;
  switch (e.kind) {
    case "run.start": {
      const spec = rec(d.spec);
      const what = spec.agent ? `agent ${str(spec.agent)}` : spec.workflow ? `workflow ${str(spec.workflow)}` : str(d.kind);
      return `${what} started, ${str(d.mode)}${spec.step ? `, step ${str(spec.step)}` : ""}`;
    }
    case "agent.start":
      return `pi ${str(d.model)}${d.thinking ? ` (thinking ${str(d.thinking)})` : ""}${Array.isArray(d.tools) ? `, ${d.tools.length} tools` : ""}`;
    case "agent.outcome":
      return `${str(d.outcome)}${d.reason ? `: ${clip(str(d.reason))}` : ""}${typeof d.changes === "number" ? `, ${d.changes} changed file(s)` : ""}`;
    case "run.end":
      return `${str(d.state)}${d.reason ? `: ${clip(str(d.reason), 300)}` : ""}${typeof d.ms === "number" ? ` in ${Math.round(d.ms / 1000)}s` : ""}`;
    case "job.accepted":
      return `job ${str(d.name) || str(d.jobId)}: ${str(d.slice)}, attempt ${str(d.attempt)}, builder ${str(d.builder)}`;
    case "job.start":
      return `builder ${str(d.builder)}`;
    case "job.result":
      return `${str(d.outcome)}${d.reason ? `: ${clip(str(d.reason), 300)}` : ""}${typeof d.commits === "number" ? `, ${d.commits} commit(s)` : ""}${typeof d.patchBytes === "number" ? `, patch ${d.patchBytes} bytes` : ""}`;
    default:
      return typeof d.msg === "string" ? `${e.kind}: ${clip(d.msg, 300)}` : `${e.kind}: ${clip(JSON.stringify(d), 300)}`;
  }
}

const RUN_KINDS = new Set(["run.start", "agent.start", "agent.outcome", "run.end", "job.accepted", "job.start", "job.result"]);

/** The entries of one run's journal, in its seq order. */
function runEntries(dir: string, events: JournalEvent[]): Omit<StoryEntry, "n">[] {
  const out: Omit<StoryEntry, "n">[] = [];
  const base = (e: JournalEvent) => ({ ts: e.ts, runId: e.runId, ...(e.agent ? { agent: e.agent } : {}), ...(e.step ? { step: e.step } : {}) });
  const starts = new Map<string, JournalEvent>();
  const gates = new Map<string, JournalEvent[]>();
  const usage = new Map<string, JournalEvent>();
  for (const e of events) {
    if (e.kind === "tool.start" && e.span) starts.set(e.span, e);
    else if (e.kind === "tool.gate" && e.span) gates.set(e.span, [...(gates.get(e.span) ?? []), e]);
    else if (e.kind === "model.usage" && e.span) usage.set(e.span, e);
  }
  const hasMessages = events.some((e) => e.kind === "model.message");
  const usageOf = (u: JournalEvent | undefined): StoryUsage | undefined =>
    u ? { model: str(u.data.model), input: num(u.data.input), output: num(u.data.output), cacheRead: num(u.data.cacheRead), cacheWrite: num(u.data.cacheWrite), cost: num(u.data.cost) } : undefined;
  for (const e of events) {
    const d = e.data;
    if (RUN_KINDS.has(e.kind) || e.kind.startsWith("callback.")) {
      out.push({ ...base(e), kind: "run", tools: [], line: runLine(e), raw: [e] });
    } else if (e.kind === "step.start" || e.kind === "step.end") {
      const line =
        e.kind === "step.start"
          ? `${e.step ?? ""} started (${str(d.stepKind)})${d.agent ? `, agent ${str(d.agent)}` : ""}${d.childRunId ? `, run ${str(d.childRunId)}` : ""}`
          : `${e.step ?? ""} ${str(d.status)}${typeof d.ms === "number" ? ` in ${Math.round(d.ms / 1000)}s` : ""}${d.reason ? `: ${clip(str(d.reason), 300)}` : ""}`;
      out.push({ ...base(e), kind: "step", tools: [], line, raw: [e] });
    } else if (e.kind === "model.select") {
      out.push({ ...base(e), kind: "meta", tools: [], line: `model ${str(d.model)}${d.thinking ? `, thinking ${str(d.thinking)}` : ""}`, raw: [e] });
    } else if (e.kind === "model.system") {
      const sections = rec(full(dir, d.sections)) as Record<string, string | null>;
      out.push({
        ...base(e),
        kind: "system",
        tools: [],
        sections,
        ...(d.content ? { text: textOf(dir, d.content) } : {}),
        ...(Array.isArray(d.toolsAdded) ? { toolsAdded: d.toolsAdded.map(str) } : {}),
        ...(Array.isArray(d.toolsRemoved) ? { toolsRemoved: d.toolsRemoved.map(str) } : {}),
        raw: [e],
      });
    } else if (e.kind === "model.prompt") {
      out.push({ ...base(e), kind: "user", tools: [], text: textOf(dir, d.text), ...(d.customType ? { line: `custom message ${str(d.customType)}` } : {}), raw: [e] });
    } else if (e.kind === "model.message") {
      const u = e.span ? usage.get(e.span) : undefined;
      const listed = full(dir, d.toolCalls);
      const calls = (Array.isArray(listed) ? listed : []).map((c) => {
        const call = rec(c);
        const id = str(call.id);
        const start = starts.get(`t-${id}`);
        return { id, name: str(call.name), input: start ? full(dir, start.data.input) : call.arguments };
      });
      out.push({
        ...base(e),
        kind: "assistant",
        tools: [...new Set(calls.map((c) => c.name))],
        text: textOf(dir, d.text),
        thinking: textOf(dir, d.thinking),
        calls,
        ...(usageOf(u) ? { usage: usageOf(u) } : {}),
        ...(d.thinkingLevel ? { thinkingLevel: str(d.thinkingLevel) } : {}),
        ...(d.stopReason ? { stopReason: str(d.stopReason) } : {}),
        ...(d.error ? { line: `model error: ${clip(str(d.error), 400)}` } : {}),
        raw: [e, ...(u ? [u] : [])],
      });
    } else if (e.kind === "model.usage") {
      // An older journal (no model.message): the response is its usage and the calls made in its turn.
      if (hasMessages) continue;
      const calls = events
        .filter((s) => s.kind === "tool.start" && s.parent === e.span)
        .map((s) => ({ id: (s.span ?? "").replace(/^t-/, ""), name: str(s.data.tool), input: full(dir, s.data.input) }));
      out.push({ ...base(e), kind: "assistant", tools: [...new Set(calls.map((c) => c.name))], calls, usage: usageOf(e), ...(d.stopReason ? { stopReason: str(d.stopReason) } : {}), raw: [e] });
    } else if (e.kind === "tool.end") {
      const start = e.span ? starts.get(e.span) : undefined;
      const g = e.span ? (gates.get(e.span) ?? []) : [];
      const outcome = str(d.outcome) || (d.isError ? "error" : "ok");
      out.push({
        ...base(e),
        kind: d.isError === true || outcome !== "ok" ? "tool-error" : "tool",
        tools: [str(d.tool)],
        tool: str(d.tool),
        input: start ? full(dir, start.data.input) : undefined,
        output: textOf(dir, d.output),
        ms: num(d.ms),
        outcome,
        ...(g.length ? { gates: g.map((x) => ({ gate: str(x.data.gate), decision: str(x.data.decision), ...(x.data.reason ? { reason: str(x.data.reason) } : {}) })) } : {}),
        raw: [...(start ? [start] : []), ...g, e],
      });
    } else if (e.kind === "tool.start" || e.kind === "tool.gate" || e.kind === "turn.end") {
      // Part of a tool entry or a turn: a tool.start with no tool.end (the run stopped mid-call) is shown alone.
      if (e.kind === "tool.start" && !events.some((x) => x.kind === "tool.end" && x.span === e.span)) {
        out.push({ ...base(e), kind: "tool", tools: [str(d.tool)], tool: str(d.tool), input: full(dir, d.input), outcome: "running", raw: [e] });
      }
    } else {
      // A progress event carries its own message (msg); a sidecar's output its text.
      const said = typeof d.msg === "string" ? d.msg : typeof d.text === "string" ? d.text : typeof d.output === "string" ? d.output : JSON.stringify(d);
      out.push({ ...base(e), kind: "other", tools: [], line: `${e.kind}: ${clip(said, 400)}`, raw: [e] });
    }
  }
  return out;
}

/** The totals of a story's entries; the duration is the root run's (first to last event). */
export function storyMetrics(entries: Pick<StoryEntry, "kind" | "ts" | "tools" | "usage" | "agent" | "raw">[]): StoryMetrics {
  const m: StoryMetrics = { entries: entries.length, durationMs: 0, turns: 0, toolCalls: 0, toolErrors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, model: "", models: [], thinking: "", topTools: [] };
  const tools = new Map<string, number>();
  const turnsByModel = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "assistant") {
      m.turns++;
      const u = e.usage;
      if (u) {
        m.input += u.input;
        m.output += u.output;
        m.cacheRead += u.cacheRead;
        m.cacheWrite += u.cacheWrite;
        m.cost += u.cost;
        if (u.model) turnsByModel.set(u.model, (turnsByModel.get(u.model) ?? 0) + 1);
      }
    } else if (e.kind === "tool" || e.kind === "tool-error") {
      m.toolCalls++;
      if (e.kind === "tool-error") m.toolErrors++;
      for (const t of e.tools) tools.set(t, (tools.get(t) ?? 0) + 1);
    } else if (e.kind === "meta" && !m.thinking) {
      const t = e.raw[0]?.data.thinking;
      if (typeof t === "string") m.thinking = t;
    }
  }
  const ranked = [...turnsByModel.entries()].sort((a, b) => b[1] - a[1]);
  m.model = ranked[0]?.[0] ?? "";
  m.models = ranked.map(([k]) => k);
  // An older journal has no model.select: the main agent's agent.start names its thinking level.
  if (!m.thinking) {
    const start = entries.flatMap((e) => e.raw).find((r) => r.kind === "agent.start" && r.data.model === m.model && typeof r.data.thinking === "string");
    if (start) m.thinking = String(start.data.thinking);
  }
  const stamps = entries.map((e) => Date.parse(e.ts)).filter((t) => !Number.isNaN(t));
  m.durationMs = stamps.length ? Math.max(...stamps) - Math.min(...stamps) : 0;
  m.topTools = [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
  return m;
}

/**
 * The story of the tree under `rootId` (the root and every run below it), from their journals in `runsDir`. `runs` is
 * every run record's id and parent (the runtime's list), so children are found without reading every journal.
 */
export function readStory(runsDir: string, rootId: string, runs: { id: string; parent: string | null }[]): Story {
  const ids = treeRuns(runsDir, rootId, runs);
  const parentOf = new Map(runs.map((r) => [r.id, r.parent]));
  const perRun: Omit<StoryEntry, "n">[][] = [];
  const storyRuns: StoryRun[] = [];
  for (const id of ids) {
    const dir = join(runsDir, id);
    const events = readJournal(dir);
    const start = events.find((e) => e.kind === "run.start");
    storyRuns.push({ runId: id, parent: parentOf.get(id) ?? null, ...(start?.agent ? { agent: start.agent } : {}), ...(start?.step ? { step: start.step } : {}), events: events.length });
    perRun.push(runEntries(dir, events));
  }
  // Merged in time order across runs, each run's own entries kept in its journal order (a pi event carries pi's clock,
  // so a run's timestamps are not strictly increasing).
  const heads = perRun.map(() => 0);
  const entries: StoryEntry[] = [];
  for (;;) {
    let pick = -1;
    for (let r = 0; r < perRun.length; r++) {
      if (heads[r] >= perRun[r].length) continue;
      if (pick < 0 || perRun[r][heads[r]].ts < perRun[pick][heads[pick]].ts) pick = r;
    }
    if (pick < 0) break;
    entries.push({ n: entries.length + 1, ...perRun[pick][heads[pick]++] });
  }
  return { runId: rootId, runs: storyRuns, metrics: storyMetrics(entries), entries };
}
