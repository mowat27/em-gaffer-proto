/**
 * Workflow definitions and the step walker.
 *
 * `defineBuilder`, `code`, `agent`, `workflow` and `template` are plain functions that return data: calling them does
 * no work. `runWorkflow` walks a builder's steps in order over one workspace and the context store. Each step's output
 * is written to outputs/<step>.json when it ends. The first step that fails ends the workflow with its reason: there is
 * no partial result and no retry.
 *
 * Budgets: a code step gets a signal that aborts at its own budget or at the job deadline, whichever comes first, and
 * the engine stops waiting for it then. An agent step starts its agent as a child run with the step's budget (the
 * runner kills pi there) and is stopped by the engine at the job deadline. The deadline is checked again when each
 * step ends.
 *
 * An agent step runs headless unless the workflow run's spec says `steps: { <step>: { mode: rpc } }`, which can also
 * point the step at another agent or other settings. The agent gets the job's dispatch, job id and base as its input,
 * so it works exactly as a directly launched agent on the same dispatch.
 *
 * Journal: `job.start` (the builder and its version) when the workflow starts, `step.start` and `step.end` (status,
 * reason, ms) per step with span `s-<n>`, what code steps emit, and a template step's `scaffold.file` and
 * `scaffold.skipped`. An agent step's events carry its child run's id
 * (`childRunId`), and the child's run.start names this run as its parent. The fallback file is merged at each step's
 * end (E12). Listeners (engine/listeners.ts) see the events of this run and of its children, never on the step path,
 * and so do the builder's sidecars (engine/sidecars.ts), which start runs on batches of them and are given 10 s after
 * the last step before they are stopped (E7).
 *
 * Machine feed (runtime/feed.ts): `step.start` and `step.end` too, with the run and job ids, so a monitor sees each
 * job's progress without reading journals.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redact } from "../runtime/journal-client.ts";
import type { FeedInput } from "../runtime/feed.ts";
import { FALLBACK_FILE, JournalWriter, type JournalSink } from "../runtime/journal.ts";
import { pinTemplates } from "../runtime/pin.ts";
import { contentHash } from "../runtime/resolve.ts";
import { AGENTICS_DIR } from "../runtime/root.ts";
import type { Emit, RunRecord, RunResult, RunSpec, Runtime } from "../runtime/types.ts";
import { ContextStore } from "./context.ts";
import { jobName } from "./job-name.ts";
import { ListenerHost, sharedListeners, type Listener } from "./listeners.ts";
import { SIDECAR_GRACE_MS, SidecarHost } from "./sidecars.ts";
import { builderModulePath, loadBuilder } from "./load.ts";
import { runTemplateStep } from "./templates.ts";
import type { Builder, Dispatch, Job, Step, StepContext } from "./types.ts";

export const defineBuilder = (b: Builder): Builder => b;

/**
 * A step that fails with an output: the engine stores `output` as the step's outputs/<step>.json, then fails the
 * workflow with the message as its reason (the verify step keeps a failed verdict's findings this way). Any other
 * error fails the step with nothing stored.
 */
export class StepFailure extends Error {
  readonly output: unknown;
  constructor(reason: string, output: unknown) {
    super(reason);
    this.name = "StepFailure";
    this.output = output;
  }
}

/** The output a failed step hands over, also from another copy of this module. */
const failureOutput = (err: unknown): { output: unknown } | null =>
  err instanceof Error && err.name === "StepFailure" && "output" in err ? { output: (err as StepFailure).output } : null;

export const code = (name: string, run: (ctx: StepContext) => Promise<unknown>, opts: { budgetMinutes?: number } = {}): Step => ({
  kind: "code",
  name,
  run,
  ...(opts.budgetMinutes !== undefined ? { budgetMinutes: opts.budgetMinutes } : {}),
});

export const agent = (
  name: string,
  opts: {
    agent: string;
    prompt?: string | ((ctx: StepContext) => string);
    args?: (ctx: StepContext) => string[];
    cwd?: (ctx: StepContext) => string;
    budgetMinutes?: number;
  },
): Step => ({ kind: "agent", name, ...opts });

export const workflow = (name: string, builder: string): Step => ({ kind: "workflow", name, builder });

/**
 * Render a template set (engine/templates.ts): `set` names its directory, `data` gives its view model, `dir` where it
 * renders (default the workspace root). Never fails the job: a missing set or a render error skips (E11).
 */
export const template = (
  name: string,
  opts: { set: (ctx: StepContext) => string; data: (ctx: StepContext) => unknown; dir?: (ctx: StepContext) => string },
): Step => ({ kind: "template", name, set: opts.set, data: opts.data, ...(opts.dir ? { dir: opts.dir } : {}) });

export interface WorkflowOptions {
  job: Job;
  /** The workspace root. */
  dir: string;
  store: ContextStore;
  runtime: Runtime;
  /** Aborts when the run is stopped. */
  signal: AbortSignal;
  log(text: string): void;
  emit: Emit;
  /** Called as each step starts (the run records its current step). */
  onStep?(name: string): void;
  /** The workflow run spec's per-step overrides. */
  steps?: RunSpec["steps"];
  /** The workflow run's journal. */
  journal?: JournalSink | null;
  /** The machine feed, with the run and job ids filled in (step.start, step.end). */
  feed?: (e: Omit<FeedInput, "runId" | "jobId">) => void;
  /** Template paths as the run pinned them at start (E1): template steps read the copies. */
  pinned?(path: string): string;
}

const minutesOf = (job: Job) => Math.round((job.deadline - job.startedAt) / 60_000);
const deadlineReason = (job: Job, step: string) => `job exceeded ${minutesOf(job)} min during ${step}`;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run every step of `builder` in order. Returns the workflow's result: done with every patch the steps produced, or failed. */
export async function runWorkflow(builder: Builder, o: WorkflowOptions): Promise<RunResult> {
  const patches: Record<string, string> = {};
  try {
    await runSteps(builder.steps, o, patches, { n: 0 });
  } catch (err) {
    return { outcome: "failed", reason: messageOf(err) };
  }
  return Object.keys(patches).length ? { outcome: "done", patches } : { outcome: "done" };
}

/** A step's start, announced once: for an agent step as soon as its child run exists, so the event can name it. */
interface StepMarks {
  begin(extra?: Record<string, unknown>): void;
  childRunId?: string;
}

async function runSteps(steps: Step[], o: WorkflowOptions, patches: Record<string, string>, spans: { n: number }): Promise<void> {
  for (const step of steps) {
    if (o.signal.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new Error("stopped");
    o.onStep?.(step.name);
    const span = `s-${++spans.n}`;
    let begun = false;
    const marks: StepMarks = {
      begin(extra = {}) {
        if (begun) return;
        begun = true;
        if (typeof extra.childRunId === "string") marks.childRunId = extra.childRunId;
        o.emit("step.start", `step ${step.name} (${step.kind})`, { step: step.name, stepKind: step.kind, ...extra });
        o.journal?.append({ kind: "step.start", step: step.name, span, data: { stepKind: step.kind, ...extra } });
        o.feed?.({ kind: "step.start", step: step.name, data: { stepKind: step.kind, ...extra } });
      },
    };
    if (step.kind !== "agent") marks.begin();
    const t0 = Date.now();
    const end = (status: "ok" | "failed", reason?: string) => {
      marks.begin();
      const ms = Date.now() - t0;
      const child = marks.childRunId ? { childRunId: marks.childRunId } : {};
      if (status === "ok") o.emit("step.end", `step ${step.name} ok in ${Math.round(ms / 1000)}s`, { step: step.name, status, ms, ...child });
      else o.emit("step.end", `step ${step.name} failed: ${(reason ?? "").slice(0, 200)}`, { step: step.name, status, reason, ms, ...child });
      // Events the run's own pi processes could not send over the socket (E12).
      o.journal?.mergeFallback?.();
      o.journal?.append({ kind: "step.end", step: step.name, span, data: { status, ...(reason !== undefined ? { reason } : {}), ms, ...child } });
      o.feed?.({ kind: "step.end", step: step.name, data: { status, ...(reason !== undefined ? { reason } : {}), ms, ...child } });
    };
    try {
      const out = await runStep(step, o, patches, marks, spans);
      if (Date.now() > o.job.deadline) throw new Error(deadlineReason(o.job, step.name));
      o.store.put(step.name, out);
      const p = (out as { patches?: unknown } | null)?.patches;
      if (p && typeof p === "object") for (const [repo, patch] of Object.entries(p)) if (typeof patch === "string") patches[repo] = patch;
      end("ok");
    } catch (err) {
      const kept = failureOutput(err);
      if (kept) {
        try {
          o.store.put(step.name, kept.output);
        } catch (putErr) {
          o.log(`[builder] step ${step.name}: its output was not stored: ${messageOf(putErr)}\n`);
        }
      }
      end("failed", messageOf(err));
      throw err;
    }
  }
}

async function runStep(step: Step, o: WorkflowOptions, patches: Record<string, string>, marks: StepMarks, spans: { n: number }): Promise<unknown> {
  const ctl = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  const abortWith = (reason: string) => ctl.abort(new Error(reason));
  timers.push(setTimeout(() => abortWith(deadlineReason(o.job, step.name)), Math.max(0, o.job.deadline - Date.now())));
  if (step.kind === "code" && step.budgetMinutes !== undefined) {
    timers.push(setTimeout(() => abortWith(`step ${step.name} exceeded its budget of ${step.budgetMinutes} min`), step.budgetMinutes * 60_000));
  }
  const forward = () => ctl.abort(o.signal.reason);
  o.signal.addEventListener("abort", forward, { once: true });
  if (o.signal.aborted) forward();
  const emit: Emit = (kind, msg, data = {}) => {
    o.emit(kind, msg, data);
    o.journal?.append({ kind, step: step.name, data: { msg, ...data } });
  };
  const ctx: StepContext = {
    job: o.job,
    dir: o.dir,
    get: <T>(name: string) => o.store.get<T>(name),
    signal: ctl.signal,
    log: o.log,
    emit,
    runtime: o.runtime,
    ...(o.steps ? { steps: o.steps } : {}),
    ...(o.pinned ? { pinned: o.pinned } : {}),
  };
  try {
    switch (step.kind) {
      case "code":
        return await raceAbort(step.run(ctx), ctl.signal);
      case "agent":
        return await runAgentStep(step, ctx, marks);
      case "workflow": {
        const inner = await loadBuilder(step.builder);
        await runSteps(inner.steps, o, patches, spans);
        return { builder: inner.name, steps: inner.steps.map((s) => s.name) };
      }
      case "template":
        return await raceAbort(Promise.resolve().then(() => runTemplateStep(step, ctx)), ctl.signal);
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    o.signal.removeEventListener("abort", forward);
  }
}

/** The step's promise, or its signal's reason as soon as the signal aborts. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolveRace, rejectRace) => {
    const onAbort = () => rejectRace(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolveRace(v);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        rejectRace(err);
      },
    );
  });
}

/**
 * Start the step's agent as a child run working in this workspace, and wait for it. Its log is appended to the job log
 * when it ends. The output is the child run's id and its done data.
 */
async function runAgentStep(step: Extract<Step, { kind: "agent" }>, ctx: StepContext, marks: StepMarks): Promise<unknown> {
  const over = ctx.steps?.[step.name] ?? {};
  const message = typeof step.prompt === "function" ? step.prompt(ctx) : step.prompt;
  const d = ctx.job.dispatch;
  const agentId = over.agent ?? step.agent;
  const run = await ctx.runtime.start(
    {
      agent: agentId,
      mode: over.mode ?? "headless",
      workspace: { dir: { path: step.cwd?.(ctx) ?? ctx.dir } },
      input: {
        dispatch: d,
        jobId: ctx.job.jobId,
        base: d.repo.base,
        ...(message !== undefined ? { message } : {}),
        ...(step.args ? { args: step.args(ctx) } : {}),
      },
      ...(over.settings ? { settings: over.settings } : {}),
      ...(step.budgetMinutes !== undefined ? { budgetMinutes: step.budgetMinutes } : {}),
      step: step.name,
    },
    { parent: ctx.job.runId },
  );
  marks.begin({ childRunId: run.id, agent: agentId });
  const childDir = ctx.runtime.dir(run.id);
  let result: RunResult;
  try {
    result = await ctx.runtime.wait(run.id, ctx.signal);
  } catch (err) {
    await ctx.runtime.stop(run.id, messageOf(err));
    throw err;
  } finally {
    const childLog = join(childDir, "log");
    if (existsSync(childLog)) ctx.log(readFileSync(childLog, "utf8"));
    mergeOrphanedFallback(childDir, run.id);
  }
  if (result.outcome === "failed") throw new Error(result.reason);
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? (result.data as Record<string, unknown>) : { data: result.data ?? null };
  return { runId: run.id, ...data };
}

/**
 * A child run that ended without merging its fallback file (its process was killed) leaves events there: merge them
 * into its journal once it is gone (E12).
 */
function mergeOrphanedFallback(childDir: string, runId: string): void {
  try {
    const file = join(childDir, FALLBACK_FILE);
    if (!existsSync(file) || statSync(file).size === 0) return;
    const spec = (JSON.parse(readFileSync(join(childDir, "run.json"), "utf8")) as RunRecord).spec ?? {};
    new JournalWriter(childDir, { runId, ...(spec.agent ? { agent: spec.agent } : {}), ...(spec.step ? { step: spec.step } : {}) }).mergeFallback();
  } catch {
    /* observing never fails the step */
  }
}

/** The content hash of a builder definition: its directory for agentics/builders/<id>/builder.ts, else the module file. */
export function builderVersion(idOrPath: string): string {
  const file = builderModulePath(idOrPath);
  try {
    return basename(file) === "builder.ts" && basename(dirname(dirname(file))) === "builders" ? contentHash(dirname(file)) : contentHash(file);
  } catch {
    return "";
  }
}

/** The job id a dispatch's callback names: its last path segment. */
export const callbackJobId = (callback: string): string => callback.split("/").pop() ?? "";

/**
 * A workflow run, end to end: load its builder, record the job in the context store, start the job log, and run the
 * steps in the workspace the runtime prepared. A builder that does not load fails the run with
 * `builder definition invalid: ...` (E2).
 */
export async function runWorkflowRun(o: {
  record: RunRecord;
  runDir: string;
  dir: string;
  /** The run's dispatch (inline in the spec, or read from a data: path). */
  dispatch: unknown;
  runtime: Runtime;
  signal: AbortSignal;
  emit: Emit;
  onStep(name: string): void;
  /** The run's journal writer (its process owns it). */
  journal?: JournalWriter | null;
  /** The machine feed, bound to the run. */
  feed?: WorkflowOptions["feed"];
  /** The agent tree: agentics/shared/listeners/ is loaded from it. */
  agenticsDir?: string;
}): Promise<RunResult> {
  const spec = o.record.spec;
  let builder: Builder;
  try {
    builder = await loadBuilder(spec.workflow ?? "");
  } catch (err) {
    return { outcome: "failed", reason: `builder definition invalid: ${messageOf(err)}` };
  }
  const given = o.dispatch as Dispatch | undefined;
  if (!given || typeof given !== "object" || !given.repo || !given.task) return { outcome: "failed", reason: "the workflow run's input has no dispatch" };
  // input.repos (runtime/repos.ts): an `app` source with a ref moves the job's base to the commit it named at start.
  const repos = o.record.resolved?.repos;
  const appBase = repos?.app?.base;
  const dispatch: Dispatch = appBase ? { ...given, repo: { ...given.repo, base: appBase } } : given;
  const startedAt = Date.parse(o.record.startedAt);
  const minutes = Math.min(spec.budgetMinutes ?? Infinity, builder.budgetMinutes ?? Infinity);
  // A workflow started by an agent run ends with what that run had left of its budget (run.json's deadline).
  const pinned = o.record.deadline ? Date.parse(o.record.deadline) : Number.NaN;
  const job: Job = {
    runId: o.record.id,
    jobId: o.record.job?.jobId ?? (callbackJobId(dispatch.callback ?? "") || o.record.id),
    dispatch,
    startedAt,
    deadline: Math.min(startedAt + (Number.isFinite(minutes) ? minutes : 24 * 60) * 60_000, Number.isNaN(pinned) ? Infinity : pinned),
    builder: { name: builder.name, version: builderVersion(spec.workflow ?? "") },
    ...(repos ? { repos } : {}),
  };
  const store = new ContextStore(join(o.runDir, "context"));
  // The dispatch holds the callback URL: job.json gets the journal's secret redaction.
  store.writeJob(redact(job));
  const logFile = join(o.runDir, "log");
  const d = dispatch;
  writeFileSync(logFile, `job ${jobName(job.jobId)} (${job.jobId}): ${d.task.context}/${d.task.title} attempt ${d.task.attempt}, base ${d.repo.base}\n`);
  const log = (text: string) => {
    try {
      appendFileSync(logFile, text);
    } catch {
      /* ignore */
    }
  };
  const emit: Emit = (kind, msg, data = {}) => o.emit(kind, msg, { slice: d.task.title, ...data });
  const journal = o.journal ?? null;
  // Sidecars (engine/sidecars.ts) are listeners that start runs: children of this run, never awaited by a step.
  const sidecars = journal && builder.sidecars?.length ? new SidecarHost({ runtime: o.runtime, runId: o.record.id, sidecars: builder.sidecars, log }) : null;
  const listeners = journal ? await startListeners(builder, journal, o.runDir, o.agenticsDir, log, sidecars?.listeners() ?? []) : null;
  journal?.append({
    kind: "job.start",
    data: { jobId: job.jobId, builder: builder.name, builderVersion: job.builder?.version ?? "", steps: builder.steps.map((s) => s.name), deadline: new Date(job.deadline).toISOString(), slice: `${d.task.context}/${d.task.title}`, attempt: d.task.attempt, base: d.repo.base },
  });
  try {
    // E1: template sets are read when their step runs; the run reads the copies it made now.
    let pinned: ((path: string) => string) | undefined;
    try {
      pinned = pinTemplates(o.runDir, o.agenticsDir ?? AGENTICS_DIR);
    } catch (err) {
      log(`[builder] templates not pinned (the steps read them in place): ${messageOf(err)}\n`);
    }
    return await runWorkflow(builder, { job, dir: o.dir, store, runtime: o.runtime, signal: o.signal, log, emit, onStep: o.onStep, ...(spec.steps ? { steps: spec.steps } : {}), journal, ...(o.feed ? { feed: o.feed } : {}), ...(pinned ? { pinned } : {}) });
  } finally {
    // The job has ended: no sidecar batch starts now, and a running one gets its grace (none when the run is stopped).
    sidecars?.close();
    await Promise.all([listeners?.finish(2000), sidecars?.finish(o.signal.aborted ? 0 : SIDECAR_GRACE_MS)]);
  }
}

/**
 * The listener host for a workflow run: shared listeners, then the builder's. A shared listener that does not load is
 * logged and left out: observation never fails a build (G7).
 */
async function startListeners(
  builder: Builder,
  journal: JournalWriter,
  runDir: string,
  agenticsDir: string | undefined,
  log: (text: string) => void,
  sidecars: { name: string; listener: Listener }[] = [],
): Promise<ListenerHost> {
  let shared: { name: string; listener: Listener }[] = [];
  if (agenticsDir) {
    try {
      shared = await sharedListeners(agenticsDir);
    } catch (err) {
      log(`[builder] shared listeners not loaded: ${messageOf(err)}\n`);
      journal.append({ kind: "listener.error", data: { listener: "shared", error: messageOf(err) } });
    }
  }
  const own = (builder.listeners ?? []).filter((l) => !shared.some((s) => s.listener === l)).map((listener, i) => ({ name: listener.name ?? `listener-${i + 1}`, listener }));
  const host = new ListenerHost({ journal, runDir, listeners: [...shared, ...own, ...sidecars], log });
  journal.onEvent = (e) => host.observe(e);
  return host;
}
