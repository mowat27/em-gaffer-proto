/**
 * Sidecars (design section 5, E7): runs a workflow starts on its own journal events, which never block a step and
 * never fail the job. A builder lists them in `sidecars: [sidecar("tool-summariser", { on: "tool.end", every: 10 })]`.
 *
 * Each sidecar is a listener (engine/listeners.ts) of the workflow run: it sees the events of the run and of every
 * child run its steps start, counts the ones its rule matches (`on`, `match`, as a listener's) and, every `every` of
 * them, starts a run of its agent with that batch as input:
 *
 *   headless, workspace none, parent the workflow run     tools: what its agent.yml enables, at most the workflow
 *   input.args: [the batch, previews only]                 run's (the runtime's ceiling); usually none
 *   budgetMinutes: 2 (the rule's budgetMinutes)            its agent's prompt template gets the batch as $1
 *
 * One instance per sidecar: events that arrive while it runs are coalesced into the next batch, which starts when the
 * run ends and at least `every` events are waiting. The start is never awaited on the step path.
 *
 * Journal (the workflow run's, each event's data naming the sidecar): `sidecar.start` (batch number, its run id as
 * `sidecarRunId`, the range of events it covers), `sidecar.output` (the run's final text, with the range and the
 * spans of the tool calls it covers) plus an artifact runs/<id>/artifacts/<sidecar>/batch-<n>.md, and `sidecar.end`
 * (done, failed or stopped, with the reason and how long it took). The run's id is never named `childRunId`, so the
 * listener host does not follow the sidecar's own journal.
 *
 * Job end: once the steps end no batch starts (a batch still short of `every` is not summarised). A sidecar still
 * running gets a grace of 10 s to finish, then it is stopped (E7). A sidecar that fails (it cannot start, or its run
 * fails) is logged and ignored; after 3 failures in a row it is switched off for the job (`sidecar.off`), as a
 * listener is (E10). The totals go to the run's summary.json under the sidecar's name.
 */
import type { JournalEvent } from "../runtime/journal.ts";
import type { RunResult, Runtime } from "../runtime/types.ts";
import { matches, type Listener, type ListenerApi } from "./listeners.ts";

export interface SidecarOptions {
  /** An event kind, a prefix ending in `*` ("tool.*"), or "*": as a listener's `on`. */
  on: string;
  /** A run starts every this many matching events. */
  every: number;
  /** As a listener's `match`: every key must equal the event's own field or else its data field. */
  match?: Partial<Record<string, unknown>>;
  /** The sidecar run's budget. Default 2 min. */
  budgetMinutes?: number;
  /** Default `sidecar-<agent>` (a `/` in the agent id becomes `-`). Names its events, artifacts and summary entry. */
  name?: string;
}

export interface Sidecar {
  /** An agent id in agentics/agents/. */
  agent: string;
  name: string;
  on: string;
  every: number;
  match?: Partial<Record<string, unknown>>;
  budgetMinutes: number;
}

export const SIDECAR_BUDGET_MINUTES = 2;
/** How long a running sidecar may go on after the job's steps end (E7). */
export const SIDECAR_GRACE_MS = 10_000;
export const MAX_SIDECAR_FAILURES = 3;
/** The batch as the sidecar's input: at most this many characters (the oldest events are left out first). */
export const MAX_BATCH_CHARS = 16_000;
const PREVIEW = 200;

/** A sidecar rule for a builder's `sidecars:`. Plain data: nothing starts until a workflow run uses it. */
export function sidecar(agent: string, o: SidecarOptions): Sidecar {
  if (typeof agent !== "string" || !agent.trim()) throw new Error("sidecar: the agent id is required");
  if (typeof o?.on !== "string" || !o.on) throw new Error(`sidecar ${agent}: on is required (an event kind, a prefix ending in *, or *)`);
  if (!Number.isInteger(o.every) || o.every < 1) throw new Error(`sidecar ${agent}: every must be a whole number of events, 1 or more`);
  if (o.budgetMinutes !== undefined && !(o.budgetMinutes > 0)) throw new Error(`sidecar ${agent}: budgetMinutes must be more than 0`);
  const name = o.name ?? `sidecar-${agent.replace(/\//g, "-")}`;
  if (!/^[\w.-]+$/.test(name)) throw new Error(`sidecar ${agent}: name ${JSON.stringify(name)}: letters, digits, _ . - only`);
  return { agent, name, on: o.on, every: o.every, ...(o.match ? { match: o.match } : {}), budgetMinutes: o.budgetMinutes ?? SIDECAR_BUDGET_MINUTES };
}

export function isSidecar(v: unknown): v is Sidecar {
  const s = v as Sidecar | null;
  return !!s && typeof s === "object" && typeof s.agent === "string" && typeof s.name === "string" && typeof s.on === "string" && typeof s.every === "number";
}

// ---- the batch ----

/** One event of a batch, previews only. */
export interface BatchItem {
  runId: string;
  seq: number;
  kind: string;
  span?: string;
  step?: string;
  tool?: string;
  input?: string;
  outcome?: string;
  output?: string;
  /** For an event that is not a tool call: its data, in one line. */
  data?: string;
}

/** A value in one line of at most `n` characters: a string as it is, a blob marker's preview, anything else as JSON. */
export function preview(v: unknown, n = PREVIEW): string {
  const blob = v as { blob?: unknown; preview?: unknown } | null;
  let s: string;
  if (blob && typeof blob === "object" && typeof blob.blob === "string" && "preview" in blob) s = String(blob.preview ?? "");
  else if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v) ?? "";
    } catch {
      s = String(v);
    }
  }
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A matched event as a batch item, with the input of its tool call when its tool.start was seen. */
export function batchItem(e: JournalEvent, input?: string): BatchItem {
  const d = e.data ?? {};
  const base = { runId: e.runId, seq: e.seq, kind: e.kind, ...(e.span ? { span: e.span } : {}), ...(e.step ? { step: e.step } : {}) };
  if (e.kind.startsWith("tool.") && typeof d.tool === "string") {
    const outcome = typeof d.outcome === "string" ? d.outcome : d.isError === true ? "error" : e.kind === "tool.end" ? "ok" : undefined;
    const inp = e.kind === "tool.start" ? preview(d.input) : input;
    return { ...base, tool: d.tool, ...(inp ? { input: inp } : {}), ...(outcome ? { outcome } : {}), ...(d.output !== undefined ? { output: preview(d.output) } : {}) };
  }
  return { ...base, data: preview(d) };
}

const line = (i: BatchItem): string =>
  i.tool !== undefined
    ? `#${i.seq} ${i.tool}${i.input ? ` ${i.input}` : ""}${i.outcome ? ` -> ${i.outcome}` : ""}${i.output ? `: ${i.output}` : ""}`
    : `#${i.seq} ${i.kind}${i.data ? ` ${i.data}` : ""}`;

/** The batch as the sidecar's input: a header, then one line per event, oldest first, within MAX_BATCH_CHARS. */
export function batchText(items: BatchItem[], max = MAX_BATCH_CHARS): string {
  const runs = [...new Set(items.map((i) => i.runId))];
  const steps = [...new Set(items.map((i) => i.step).filter((s): s is string => !!s))];
  const head = `${items.length} event(s) from run ${runs.join(", ")}${steps.length ? ` (step ${steps.join(", ")})` : ""}, oldest first:`;
  const lines = items.map(line);
  let used = head.length + 1;
  let from = lines.length;
  while (from > 0 && used + lines[from - 1].length + 1 <= max) used += lines[--from].length + 1;
  const left = from > 0 ? [`(${from} earlier event(s) left out)`] : [];
  return [head, ...left, ...lines.slice(from)].join("\n");
}

/** The events a batch covers: its first and last, and the spans of its tool calls. */
export function rangeOf(items: BatchItem[]): { range: { from: Pick<BatchItem, "runId" | "seq" | "span">; to: Pick<BatchItem, "runId" | "seq" | "span"> } | null; spans: string[] } {
  const at = (i: BatchItem) => ({ runId: i.runId, seq: i.seq, ...(i.span ? { span: i.span } : {}) });
  const first = items[0];
  const last = items[items.length - 1];
  return { range: first && last ? { from: at(first), to: at(last) } : null, spans: [...new Set(items.map((i) => i.span).filter((s): s is string => !!s))] };
}

// ---- the host ----

interface Running {
  runId: string | null;
  batch: number;
  stopping: boolean;
  done: Promise<void>;
}

interface State {
  rule: Sidecar;
  /** Matched events not yet in a batch. */
  pending: BatchItem[];
  /** tool.start inputs by `<runId>/<span>`, so a tool.end item carries its call's input. */
  inputs: Map<string, string>;
  running: Running | null;
  batches: number;
  failuresInRow: number;
  off: boolean;
  totals: { batches: number; done: number; failed: number; stopped: number; outputs: number; events: number };
  api: ListenerApi | null;
}

const MAX_INPUTS = 500;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

export interface SidecarHostOptions {
  /** Starts, waits for and stops the sidecar runs (the workflow run's own runtime). */
  runtime: Pick<Runtime, "start" | "wait" | "stop">;
  /** The workflow run: every sidecar run's parent. */
  runId: string;
  sidecars: Sidecar[];
  /** The job log. */
  log?(text: string): void;
}

export class SidecarHost {
  private readonly o: SidecarHostOptions;
  private readonly states: State[];
  private closed = false;

  constructor(o: SidecarHostOptions) {
    this.o = o;
    this.states = o.sidecars.map((rule) => ({
      rule,
      pending: [],
      inputs: new Map(),
      running: null,
      batches: 0,
      failuresInRow: 0,
      off: false,
      totals: { batches: 0, done: 0, failed: 0, stopped: 0, outputs: 0, events: 0 },
      api: null,
    }));
  }

  /**
   * One listener per sidecar for the workflow run's listener host. Each sees every event (to keep tool.start inputs)
   * and batches the ones its rule matches; handling an event only queues it, so the host's queue never waits on a run.
   */
  listeners(): { name: string; listener: Listener }[] {
    return this.states.map((s) => {
      const rule: Listener = { on: s.rule.on, ...(s.rule.match ? { match: s.rule.match } : {}), handle: () => {} };
      return {
        name: s.rule.name,
        listener: {
          name: s.rule.name,
          on: "*",
          handle: (e: JournalEvent, api: ListenerApi) => {
            s.api = api;
            if (e.kind === "tool.start" && e.span) {
              s.inputs.set(`${e.runId}/${e.span}`, preview(e.data?.input));
              if (s.inputs.size > MAX_INPUTS) s.inputs.delete(s.inputs.keys().next().value!);
            }
            if (this.closed || s.off || !matches(rule, e)) return;
            const key = e.span ? `${e.runId}/${e.span}` : "";
            s.pending.push(batchItem(e, e.kind === "tool.start" ? undefined : s.inputs.get(key)));
            if (e.kind === "tool.end") s.inputs.delete(key);
            this.maybeStart(s);
          },
        },
      };
    });
  }

  /** The steps have ended: no batch starts from now on. */
  close(): void {
    this.closed = true;
  }

  /** Close, give a running sidecar up to `graceMs` to finish, then stop it; and record each sidecar's totals. */
  async finish(graceMs = SIDECAR_GRACE_MS): Promise<void> {
    this.close();
    await Promise.all(
      this.states.map(async (s) => {
        const r = s.running;
        if (r) {
          const finished = await Promise.race([r.done.then(() => true), sleep(Math.max(0, graceMs)).then(() => false)]);
          if (!finished) {
            r.stopping = true;
            if (r.runId) await this.o.runtime.stop(r.runId, `job ended: ${s.rule.name} stopped after its ${Math.round(graceMs / 1000)} s grace`).catch(() => {});
            await Promise.race([r.done, sleep(10_000)]);
          }
        }
        if (s.api && s.totals.batches + s.totals.events > 0) s.api.summary({ agent: s.rule.agent, ...s.totals, pending: s.pending.length, ...(s.off ? { off: true } : {}) });
      }),
    );
  }

  private maybeStart(s: State): void {
    if (this.closed || s.off || s.running || s.pending.length < s.rule.every || !s.api) return;
    const batch = s.pending.splice(0);
    const n = ++s.batches;
    const running: Running = { runId: null, batch: n, stopping: false, done: Promise.resolve() };
    s.running = running;
    running.done = this.runBatch(s, s.api, running, batch)
      .catch((err) => this.o.log?.(`[builder] ${s.rule.name}: ${messageOf(err)}\n`))
      .finally(() => {
        s.running = null;
        this.maybeStart(s);
      });
  }

  private async runBatch(s: State, api: ListenerApi, running: Running, batch: BatchItem[]): Promise<void> {
    const rule = s.rule;
    const t0 = Date.now();
    const { range, spans } = rangeOf(batch);
    s.totals.batches++;
    s.totals.events += batch.length;
    const ids = { sidecar: rule.name, agent: rule.agent, batch: running.batch };
    let result: RunResult;
    try {
      const rec = await this.o.runtime.start(
        { agent: rule.agent, mode: "headless", workspace: "none", input: { args: [batchText(batch)] }, budgetMinutes: rule.budgetMinutes },
        { parent: this.o.runId },
      );
      running.runId = rec.id;
      api.emit("sidecar.start", { ...ids, sidecarRunId: rec.id, events: batch.length, range });
      // Stopped at job end: the stop was asked for while the run was being started.
      if (running.stopping) await this.o.runtime.stop(rec.id, "job ended").catch(() => {});
      result = await this.o.runtime.wait(rec.id);
    } catch (err) {
      result = { outcome: "failed", reason: `could not start: ${messageOf(err)}` };
    }
    const ms = Date.now() - t0;
    const runIdField = running.runId ? { sidecarRunId: running.runId } : {};
    if (result.outcome === "done") {
      s.failuresInRow = 0;
      s.totals.done++;
      const text = outputOf(result);
      if (text) {
        s.totals.outputs++;
        api.emit("sidecar.output", { ...ids, ...runIdField, text, events: batch.length, range, spans });
        try {
          api.artifact(`batch-${running.batch}.md`, artifactText(rule, running.batch, running.runId, batch.length, range, text));
        } catch (err) {
          this.o.log?.(`[builder] ${rule.name}: its artifact was not written: ${messageOf(err)}\n`);
        }
      }
      api.emit("sidecar.end", { ...ids, ...runIdField, status: "done", ms, ...(text ? {} : { note: "the run gave no text" }) });
      return;
    }
    if (running.stopping) {
      s.totals.stopped++;
      api.emit("sidecar.end", { ...ids, ...runIdField, status: "stopped", reason: result.reason, ms });
      return;
    }
    s.totals.failed++;
    s.failuresInRow++;
    this.o.log?.(`[builder] ${rule.name} batch ${running.batch} failed: ${result.reason}\n`);
    api.emit("sidecar.end", { ...ids, ...runIdField, status: "failed", reason: result.reason, ms });
    if (s.failuresInRow >= MAX_SIDECAR_FAILURES) {
      s.off = true;
      s.pending = [];
      this.o.log?.(`[builder] ${rule.name} is off for this job after ${s.failuresInRow} failures in a row\n`);
      api.emit("sidecar.off", { ...ids, failures: s.failuresInRow });
    }
  }
}

/** A headless run's final text (runtime/pi.ts puts it in data.output). */
function outputOf(r: RunResult): string {
  if (r.outcome !== "done") return "";
  const out = (r.data as { output?: unknown } | undefined)?.output;
  return typeof out === "string" ? out.trim() : "";
}

function artifactText(rule: Sidecar, batch: number, runId: string | null, events: number, range: ReturnType<typeof rangeOf>["range"], text: string): string {
  const where = range ? `${range.from.runId} #${range.from.seq}${range.to.runId !== range.from.runId ? ` to ${range.to.runId}` : ""} to #${range.to.seq}` : "no events";
  return `# ${rule.name}, batch ${batch}\n\nAgent ${rule.agent}${runId ? `, run ${runId}` : ""}. ${events} event(s): ${where}.\n\n${text}\n`;
}
