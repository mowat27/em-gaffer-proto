/**
 * A job, from the server's side: start the active builder's workflow as a headless run in an empty workspace, wait
 * for its result, turn it into the contract's callback body, post it, then prune old run workspaces. One job at a
 * time; the server's state is in memory, every run's state is in runs/<id>/run.json.
 *
 * E13: when the server starts, job runs left behind by a server that is gone, with their callback not made, get one
 * callback: `failed` with `builder restarted during <step>`, or the run's own result when it had finished.
 *
 * Journal: the server writes into the job run's journal: `job.accepted` before the run's process starts (seq 1), then,
 * after the run ended, `job.result`, `callback.sent` and every `callback.*` outcome, continuing the run's seq. A
 * control message that arrives while the run is live goes through the run's journal fallback file, which the run
 * merges at its next step end (one writer assigns seq at any time).
 *
 * Machine feed (runtime/feed.ts): job.accepted, job.result and the callback's outcome (ok, gone, abandoned).
 *
 * Cancel (E14): the job's run is stopped with the reason `cancelled by operator`, which is the callback's reason.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { jobLabel, jobName } from "../engine/job-name.ts";
import type { Dispatch } from "../engine/types.ts";
import type { MachineConfig } from "../ops/config.ts";
import { activeBuilder, type LoadedActive } from "../ops/definitions/active.ts";
import { appendFeed, type FeedInput } from "../runtime/feed.ts";
import { FALLBACK_FILE, JournalWriter } from "../runtime/journal.ts";
import { createRuntime, processAlive } from "../runtime/run.ts";
import { isFinal, type Emit, type RunRecord, type RunResult } from "../runtime/types.ts";
import { pruneExpired } from "../runtime/retention.ts";
import { pruneWorkspaces } from "../runtime/workspace.ts";
import { postCallback, type ContractResult } from "./callback.ts";

/** The callback reason of a job the operator cancelled (E14, E19). */
export const CANCELLED = "cancelled by operator";

export interface CurrentJob {
  jobId: string;
  title: string;
  context: string;
  attempt: number;
  startedAt: number;
  /** accepted, running (the run's own step is in its run.json), callback, cleanup. */
  step: string;
  runId: string | null;
  /** The operator cancelled it (control inbox): its run is stopped as soon as it exists. */
  cancelled?: boolean;
  /** The active builder as it was loaded at accept (ops/definitions/active.ts): what the job's run spec names (E2). */
  active?: LoadedActive;
}

export interface ServerState {
  /** The machine config the next job uses (re-read at each accept). */
  cfg: MachineConfig;
  current: CurrentJob | null;
  lastJob: (CurrentJob & { outcome: string; endedAt: number }) | null;
  /** Drained (control inbox): the running job finishes, and every dispatch is answered 503 until resume (E14). */
  draining: boolean;
}

/** The server's progress lines on stdout (its log). The machine feed gets the server, job and callback events. */
export function serverEmitter(_state: ServerState): Emit {
  return (_kind, msg) => {
    try {
      console.log(`[builder] ${msg}`);
    } catch {
      /* stdout gone */
    }
  };
}

/** The server's state as server.state reports it: idle, busy with a job at a step, or draining. */
export function stateOf(state: ServerState): { state: "idle" | "busy" | "draining"; jobId?: string; name?: string; runId?: string; step?: string } {
  const cur = state.current;
  const job = cur ? { jobId: cur.jobId, name: jobName(cur.jobId), ...(cur.runId ? { runId: cur.runId } : {}), step: cur.step } : {};
  return { state: state.draining ? "draining" : cur ? "busy" : "idle", ...job };
}

/** Append to the machine feed of the config's runs directory. */
export const feedOf = (cfg: MachineConfig) => (e: FeedInput) => appendFeed(cfg.server.runsDir, e);

/** server.state, now. */
export function feedState(state: ServerState): void {
  const s = stateOf(state);
  feedOf(state.cfg)({ kind: "server.state", ...(s.jobId ? { jobId: s.jobId } : {}), ...(s.runId ? { runId: s.runId } : {}), data: s });
}

export const runtimeFor = (cfg: MachineConfig) =>
  createRuntime({ runsDir: cfg.server.runsDir, piCommand: cfg.pi.command, limit: cfg.limit, ...(cfg.loadOptions?.configPath ? { configFiles: [cfg.loadOptions.configPath] } : {}) });

/** A workflow result as the contract's callback body: `patches.app` is the patch. */
export function toContract(r: RunResult): ContractResult {
  if (r.outcome === "failed") return { outcome: "failed", reason: r.reason };
  const patch = r.patches?.app;
  if (typeof patch !== "string" || !patch) return { outcome: "failed", reason: "the workflow produced no patch for the app repository" };
  return { outcome: "done", patch };
}

/**
 * The server's one writer per job run (D-R26: one writer assigns seq at any time). A writer keeps its own seq, so two
 * on one journal would hand out the same numbers: job.result and the callback (runJob) and a control message applied
 * at the same moment (applyControl) share this one. It is made once the run has ended (its own process no longer
 * writes), continues the run's seq, and is let go when the job is done with it.
 */
const serverWriters = new Map<string, JournalWriter>();

/** The job run's journal for the server's own events, after the run ended. Fallback lines left behind are merged first. */
function jobJournal(runtime: ReturnType<typeof runtimeFor>, runId: string): JournalWriter {
  const dir = runtime.dir(runId);
  let w = serverWriters.get(dir);
  if (!w) {
    w = new JournalWriter(dir, { runId });
    serverWriters.set(dir, w);
  }
  w.mergeFallback();
  return w;
}

/** The job is done writing: a later server event starts a new writer, which reads the seq from the file. */
const releaseJournal = (runtime: ReturnType<typeof runtimeFor>, runId: string) => serverWriters.delete(runtime.dir(runId));

/**
 * An event for a job run's journal from the server: appended directly once the run has ended, else through the run's
 * fallback file, which the run's own writer merges at its next step end or when it ends (one writer at any time).
 */
export function journalToRun(runtime: ReturnType<typeof runtimeFor>, runId: string, e: { kind: string; data: Record<string, unknown> }): void {
  try {
    const rec = runtime.get(runId);
    if (!rec) return;
    if (isFinal(rec.state)) jobJournal(runtime, runId).append(e);
    else appendFileSync(join(runtime.dir(runId), FALLBACK_FILE), JSON.stringify({ ...e, ts: new Date().toISOString(), cid: `server-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }) + "\n");
  } catch {
    /* the journal only observes */
  }
}

/** The callback kinds the machine feed carries. */
const FEED_CALLBACKS = new Set(["callback.ok", "callback.gone", "callback.abandoned"]);

/** The server's emit for a job, with every callback.* event also journaled in the job run, and its outcome in the feed. */
function journaledEmit(emit: Emit, journal: JournalWriter | null, feed: (e: FeedInput) => void, ids: { jobId: string; runId?: string | null }): Emit {
  return (kind, msg, data = {}) => {
    emit(kind, msg, data);
    if (journal && kind.startsWith("callback")) journal.append({ kind, data: { msg, ...data } });
    if (FEED_CALLBACKS.has(kind)) feed({ kind: kind as FeedInput["kind"], jobId: ids.jobId, ...(ids.runId ? { runId: ids.runId } : {}), data: { msg, ...data } });
  };
}

/** job.result: the outcome the gaffer is sent, in the job run's journal and the feed. */
function journalResult(journal: JournalWriter | null, result: RunResult, body: ContractResult, feed: (e: FeedInput) => void, ids: { jobId: string; runId?: string | null }): void {
  // git format-patch starts each commit with "From <sha> <date>": the timeline shows how many the job made.
  const commits = body.outcome === "failed" ? 0 : (body.patch.match(/^From [0-9a-f]{40} /gm) ?? []).length;
  const data = { outcome: body.outcome, ...(body.outcome === "failed" ? { reason: body.reason } : { patchBytes: body.patch.length, commits }), ...(result.outcome === "failed" && result.halted ? { halted: true } : {}) };
  journal?.append({ kind: "job.result", data });
  feed({ kind: "job.result", jobId: ids.jobId, ...(ids.runId ? { runId: ids.runId } : {}), data });
}

export async function runJob(state: ServerState, cfg: MachineConfig, d: Dispatch, job: CurrentJob, emit: Emit): Promise<void> {
  const runtime = runtimeFor(cfg);
  const feed = feedOf(cfg);
  const { jobTimeoutMinutes } = cfg.server;
  // The builder loaded at accept; E2: a history version when the active one does not load.
  const active = job.active ?? { ...activeBuilder(cfg), workflow: activeBuilder(cfg).id, builder: null };
  let result: RunResult;
  try {
    const run = await runtime.start(
      { workflow: active.workflow, mode: "headless", workspace: "empty", input: { dispatch: d }, budgetMinutes: jobTimeoutMinutes },
      {
        job: { jobId: job.jobId, callback: d.callback, server: process.pid },
        onRecord: (rec) => {
          const builder = { builder: active.id, ...(active.fallback ? { builderVersion: active.fallback.version, fallback: true } : {}) };
          const accepted = { jobId: job.jobId, name: jobName(job.jobId), sliceId: d.task.sliceId, slice: `${d.task.context}/${d.task.title}`, attempt: d.task.attempt, handover: d.task.handover, repo: d.repo.url, base: d.repo.base, requires: d.requires, ...builder, callback: d.callback };
          const journal = new JournalWriter(runtime.dir(rec.id), { runId: rec.id });
          journal.append({ kind: "job.accepted", data: accepted });
          const { callback: _callback, ...forFeed } = accepted;
          feed({ kind: "job.accepted", jobId: job.jobId, runId: rec.id, data: forFeed });
          if (active.error) {
            // E2: the active builder does not load. The job runs the last valid version, or fails with the error.
            const invalid = { kind: "builder", id: active.id, error: active.error, ...(active.fallback ? { fallback: active.fallback } : { fallback: null }) };
            journal.append({ kind: "definition.invalid", data: invalid });
            feed({ kind: "definition.invalid", jobId: job.jobId, runId: rec.id, data: invalid });
          }
        },
      },
    );
    job.runId = run.id;
    job.step = "running";
    feedState(state);
    // Cancelled while the run was starting.
    if (job.cancelled) await runtime.stop(run.id, CANCELLED);
    // The workflow run enforces the job deadline itself. This is the backstop for a run that cannot (a hung process).
    const backstop = new AbortController();
    const timer = setTimeout(() => backstop.abort(), (jobTimeoutMinutes + 1) * 60_000);
    try {
      result = await runtime.wait(run.id, backstop.signal);
    } catch (err) {
      if (!backstop.signal.aborted) throw err;
      const step = runtime.get(run.id)?.step ?? "start";
      const reason = `job exceeded ${jobTimeoutMinutes} min during ${step}`;
      await runtime.stop(run.id, reason);
      result = { outcome: "failed", reason };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    result = { outcome: "failed", reason: (err as Error).message };
  }
  if (job.cancelled && result.outcome === "failed") result = { outcome: "failed", reason: CANCELLED };
  const body = toContract(result);
  if (body.outcome === "failed") emit("job.failed", body.reason, { reason: body.reason });
  const journal = job.runId ? jobJournal(runtime, job.runId) : null;
  const ids = { jobId: job.jobId, runId: job.runId };
  journalResult(journal, result, body, feed, ids);

  job.step = "callback";
  feedState(state);
  emit("callback", `POST ${d.callback} (${body.outcome})`);
  journal?.append({ kind: "callback.sent", data: { url: d.callback, outcome: body.outcome } });
  await postCallback(d.callback, body, cfg.server.callbackRetries, journaledEmit(emit, journal, feed, ids));
  if (job.runId) {
    markCallbackDone(runtime, job.runId);
    releaseJournal(runtime, job.runId);
  }

  job.step = "cleanup";
  pruneWorkspaces(cfg.server.runsDir, cfg.server.keepWorkspaces, job.runId, (msg) => emit("cleanup.warn", msg));
  void pruneRuns(cfg, emit);
  state.lastJob = { ...job, outcome: body.outcome, endedAt: Date.now() };
  state.current = null;
  emit("job.end", `job ${jobLabel(job.jobId)} ${body.outcome} in ${Math.round((Date.now() - job.startedAt) / 1000)}s`, { outcome: body.outcome, name: jobName(job.jobId) });
  feedState(state);
}

/** Delete run data past the retention period (runtime/retention.ts), reporting what went. Never throws. */
export async function pruneRuns(cfg: MachineConfig, emit: Emit): Promise<void> {
  try {
    const r = await pruneExpired(cfg.server.runsDir, { days: cfg.server.retentionDays });
    const runs = r.trees.reduce((n, t) => n + t.runs.length, 0);
    if (runs || r.other.length || r.feedLines) emit("cleanup", `retention (${cfg.server.retentionDays} days): deleted ${runs} run(s) in ${r.trees.length} tree(s), ${r.other.length} other folder(s), ${r.feedLines} feed line(s)`, { trees: r.trees.length, runs, other: r.other.length, feedLines: r.feedLines });
    for (const e of r.errors) emit("cleanup.warn", e);
  } catch (err) {
    emit("cleanup.warn", `retention: ${(err as Error).message}`);
  }
}

function markCallbackDone(runtime: ReturnType<typeof runtimeFor>, runId: string): void {
  try {
    const rec = runtime.get(runId);
    if (rec?.job) runtime.update(runId, { job: { ...rec.job, callbackDone: true } });
  } catch {
    /* the run's directory is gone */
  }
}

/** Job runs this server must answer for: their callback is not made and the server that accepted them is gone. */
export function orphanedJobRuns(runs: RunRecord[], selfPid = process.pid): RunRecord[] {
  return runs.filter((r) => {
    if (r.kind !== "workflow" || !r.job || r.job.callbackDone) return false;
    const owner = r.job.server;
    // A pid equal to ours belonged to an earlier server (pids are reused, often in containers).
    return owner === undefined || owner === selfPid || !processAlive(owner);
  });
}

/** E13: one callback for every job run a stopped server left behind. */
export async function recoverJobs(cfg: MachineConfig, emit: Emit): Promise<void> {
  const runtime = runtimeFor(cfg);
  for (const r of orphanedJobRuns(runtime.list())) {
    const job = r.job!;
    try {
      const step = r.step ?? "start";
      if (!isFinal(r.state)) await runtime.stop(r.id, `builder restarted during ${step}`);
      const cur = runtime.get(r.id) ?? r;
      const finished = (cur.state === "done" || cur.state === "failed") && cur.result && !isRestart(cur.result, step);
      const body: ContractResult = finished ? toContract(cur.result!) : { outcome: "failed", reason: `builder restarted during ${step}` };
      emit("job.recovered", `job ${jobLabel(job.jobId)} was left ${r.state} by a builder that stopped: sending ${body.outcome}`, { jobId: job.jobId, runId: r.id, outcome: body.outcome });
      const journal = jobJournal(runtime, r.id);
      const ids = { jobId: job.jobId, runId: r.id };
      journalResult(journal, finished ? cur.result! : body.outcome === "failed" ? { outcome: "failed", reason: body.reason } : { outcome: "done" }, body, feedOf(cfg), ids);
      journal.append({ kind: "callback.sent", data: { url: job.callback, outcome: body.outcome, recovered: true } });
      await postCallback(job.callback, body, cfg.server.callbackRetries, journaledEmit(emit, journal, feedOf(cfg), ids));
      markCallbackDone(runtime, r.id);
      releaseJournal(runtime, r.id);
    } catch (err) {
      emit("job.recover.warn", `could not recover job ${jobLabel(job.jobId)}: ${(err as Error).message}`, { jobId: job.jobId, runId: r.id });
    }
  }
}

const isRestart = (r: RunResult, step: string) => r.outcome === "failed" && r.reason === `builder restarted during ${step}`;
