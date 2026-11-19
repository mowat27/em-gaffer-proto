#!/usr/bin/env node
/**
 * The run process: `node runtime/main.ts <runId>`, started by runtime/run.ts with the runtime's settings in its
 * environment. It marks the run running, prepares the workspace its run.json resolved, does the work (a workflow
 * through the engine, or one pi run in the resolved mode), writes the result to run.json and exits.
 *
 * An agent run with a dispatch gets it in runs/<id>/context/job.json (shared:context reads it) and the BUILDER_* job
 * variables; BUILDER_BASE is the input's base, else the workspace's HEAD at start.
 *
 * Stopping: on SIGTERM or SIGINT, or when its parent process ends (unless the run is detached), the run stops its
 * child runs (except detached ones, E23) and its pi process, ends `stopped` and exits. It gives that 4.5 s, inside the
 * 5 s its stopper allows.
 *
 * Budget: pi gets run.json's budgetMinutes (runtime/run.ts: the spec's, within what its agent parent had left).
 *
 * Durable runs (runtime/triggers.ts): an agent run in durable mode whose agent.yml has `triggers:` arms them here, and
 * they start turns through the relay's message desk (runtime/messaging.ts), as messages from other runs do.
 *
 * Machine feed (runtime/feed.ts): every run writes its run.start and run.end there, and a workflow run its steps.
 *
 * API (runtime/api.ts): an agent run whose agent.yml has `api:` serves it from this process before its pi starts, and
 * fails when it cannot (the token's variable unset, the address taken).
 *
 * Journal (when run.json says the run keeps one): the process owns the run's journal writer and its socket. It
 * journals run.start (the spec and the parent run id) first and run.end last, then closes the journal (fallback merged,
 * summary.json written) before it writes the final state to run.json, so whoever waits on the run (the server, a
 * workflow) can append to the journal afterwards. SIGUSR2 drops the socket's clients onto the fallback file (E12).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runWorkflowRun } from "../engine/workflow.ts";
import { jobName } from "../engine/job-name.ts";
import { appendFeed, type FeedInput } from "./feed.ts";
import { redact } from "./journal-client.ts";
import { JournalWriter } from "./journal.ts";
import type { MessageDesk } from "./messaging.ts";
import { runPi } from "./pi.ts";
import { loadDispatch } from "./resolve.ts";
import { AGENTICS_DIR } from "./root.ts";
import { createRuntime, eventWriter, jobOf, optionsFromEnv, writeAtomic } from "./run.ts";
import { armTriggers } from "./triggers.ts";
import { isFinal, type RunResult, type RunSpec } from "./types.ts";
import { prepareWorkspace, workspaceHead } from "./workspace.ts";

// The parent's stdout may be gone (it ended): writing there must not kill the run.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const runId = process.argv[2] ?? "";
const env = optionsFromEnv();
if (!runId || !env) {
  console.error("usage: node runtime/main.ts <runId>, started by the runtime (BUILDER_RUNS_DIR and BUILDER_PI_COMMAND set)");
  process.exit(64);
}
const runtime = createRuntime({ ...env, self: runId });
const runDir = runtime.dir(runId);
const initial = runtime.get(runId);
if (!initial) {
  console.error(`no run ${runId} in ${env.runsDir}`);
  process.exit(66);
}
const record = runtime.update(runId, { state: "running", pid: process.pid });
const job = jobOf(runtime, record);
const interactive = record.resolved?.mode === "interactive";
// Progress lines on stderr (the run's log, or the terminal); the machine feed gets the run, step and job events.
const emit = eventWriter(
  [],
  () => ({
    runId,
    ...(record.parent ? { parent: record.parent } : {}),
    ...(job ? { jobId: job.jobId, name: jobName(job.jobId) } : {}),
  }),
  interactive,
);
const feed = (e: Omit<FeedInput, "runId" | "jobId">) => appendFeed(env!.runsDir, { ...e, runId, ...(job ? { jobId: job.jobId } : {}) });
feed({
  kind: "run.start",
  data: {
    kind: record.kind,
    ...(record.spec.agent ? { agent: record.spec.agent } : {}),
    ...(record.spec.workflow ? { workflow: record.spec.workflow } : {}),
    mode: record.resolved?.mode ?? "headless",
    parent: record.parent,
    pid: process.pid,
    // The timeline names the model an agent run starts with.
    ...(record.kind === "agent" && record.resolved?.settings?.model ? { model: `${record.resolved.settings.provider}/${record.resolved.settings.model}`, thinking: record.resolved.settings.thinking } : {}),
    ...(record.spec.name ? { name: record.spec.name } : {}),
    ...(record.spec.step ? { step: record.spec.step } : {}),
    ...(record.spec.detach ? { detach: true } : {}),
  },
});

/** The spec as run.start records it: an inline dispatch is named, not copied (it is in context/job.json). */
function specForJournal(spec: RunSpec): RunSpec {
  const d = spec.input?.dispatch;
  if (!d || typeof d !== "object") return spec;
  const task = (d as { task?: { context?: unknown; title?: unknown } }).task;
  return { ...spec, input: { ...spec.input, dispatch: `inline: ${String(task?.context ?? "?")}/${String(task?.title ?? "?")} (context/job.json)` } };
}

const journal = record.journal ? new JournalWriter(runDir, { runId, ...(record.spec.agent ? { agent: record.spec.agent } : {}), ...(record.spec.step ? { step: record.spec.step } : {}) }) : null;
if (journal) {
  await journal.listen();
  process.on("SIGUSR2", () => journal.dropClients());
  journal.append({
    kind: "run.start",
    ...(record.parent ? { parent: record.parent } : {}),
    data: { kind: record.kind, spec: specForJournal(record.spec), mode: record.resolved?.mode ?? "headless", pid: process.pid, cwd: record.resolved?.cwd ?? runDir, ...(job ? { jobId: job.jobId } : {}) },
  });
}

const controller = new AbortController();
let stopReason: string | null = null;
let finished = false;
/** pi's last line when it finished (the pi.done event), for the feed's run.end. */
let piSaid = "";

function finish(result: RunResult | null): void {
  if (finished) return;
  finished = true;
  try {
    const cur = runtime.get(runId);
    if (cur && !isFinal(cur.state)) {
      const endedAt = new Date().toISOString();
      const final: RunResult | null = stopReason !== null ? { outcome: "failed", reason: stopReason } : result;
      const state = stopReason !== null ? "stopped" : final?.outcome === "done" ? "done" : "failed";
      if (journal) {
        const r = final as { outcome?: string; reason?: string; patches?: Record<string, string> } | null;
        // What pi could not send over the socket (E12) comes before run.end.
        journal.mergeFallback();
        journal.append({
          kind: "run.end",
          data: { state, outcome: r?.outcome ?? "failed", ...(r?.reason ? { reason: r.reason } : {}), ...(r?.patches ? { patches: Object.keys(r.patches) } : {}), ms: Date.now() - Date.parse(record.startedAt) },
        });
        journal.close();
      }
      if (final) {
        // The feed first: whoever sees the final state in run.json finds run.end in the feed.
        // pi's last line (its pi.done event), as the timeline shows it.
        feed({ kind: "run.end", data: { state, outcome: final.outcome, ...(final.outcome === "failed" ? { reason: final.reason } : {}), ...(final.outcome === "done" && piSaid ? { said: piSaid } : {}), ms: Date.now() - Date.parse(record.startedAt) } });
        runtime.update(runId, { state, endedAt, result: final });
      }
    }
  } catch {
    /* the runs directory is gone */
  }
  process.exit(0);
}

/** This run's children that stop with it: every live one except those started with detach (E23). */
const attachedChildren = () => runtime.list().filter((r) => r.parent === runId && !isFinal(r.state) && !r.spec.detach);

function stopSelf(reason: string): void {
  if (stopReason !== null || finished) return;
  stopReason = reason;
  controller.abort(new Error(reason));
  // Child runs stop themselves when this process ends; stopping them first lets them end cleanly.
  void Promise.all(attachedChildren().map((c) => runtime.stopWithin(c.id, reason, 3000))).catch(() => {});
  setTimeout(() => finish(null), 4500).unref();
}

const stopFileReason = () => {
  const file = join(runDir, "stop");
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim() || "stopped" : "stopped";
  } catch {
    return "stopped";
  }
};
process.on("SIGTERM", () => stopSelf(stopFileReason()));
// The terminal went away (its tmux session or ssh connection ended): stop and record it, rather than die unrecorded.
process.on("SIGHUP", () => stopSelf("the terminal closed"));
// In an interactive run Ctrl+C belongs to pi's TUI: the run ends when pi does.
process.on("SIGINT", () => (interactive ? undefined : stopSelf(stopFileReason())));

if (!record.spec.detach) {
  const parentAtStart = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentAtStart) stopSelf("parent ended");
  }, 500).unref();
}

/** The run's dispatch: inline in the spec, or read from where resolve found it. */
function dispatchOf(): unknown {
  const r = record.resolved;
  if (r?.dispatch) return loadDispatch(r.dispatch.path, {}).dispatch;
  return record.spec.input?.dispatch;
}

async function work(): Promise<RunResult> {
  // The budget pi gets: what run.json pinned (within an agent parent's), else the spec's.
  const budgetMinutes = record.budgetMinutes ?? record.spec.budgetMinutes;
  const resolved = record.resolved;
  if (!resolved) return { outcome: "failed", reason: `run ${runId} was not resolved when it started` };
  const snapshotsDir = join(env!.runsDir, ".snapshots");
  if (record.kind === "workflow") {
    const dir = prepareWorkspace(runDir, resolved.workspace, { snapshotsDir });
    return runWorkflowRun({
      record,
      runDir,
      dir,
      dispatch: dispatchOf(),
      runtime,
      signal: controller.signal,
      emit,
      onStep: (step) => runtime.update(runId, { step }),
      journal,
      feed,
      agenticsDir: env!.agenticsDir ?? AGENTICS_DIR,
    });
  }
  // An agent whose agent.yml has api: serves the API (runtime/api.ts) for as long as the run lives; one that cannot fails.
  if (resolved.api) await (await import("./api.ts")).startApi({ settings: resolved.api, runId, runDir, runtime, journal });
  // A durable run's triggers start turns through the relay's desk once pi runs (they wait for it until then).
  let relayReady: (desk: MessageDesk) => void = () => {};
  const relay = new Promise<MessageDesk>((r) => (relayReady = r));
  if (resolved.mode === "durable" && resolved.triggers?.length && resolved.agent) {
    void armTriggers({
      triggers: resolved.triggers,
      stateDir: join(resolved.agent.dir, "state"),
      runsDir: env!.runsDir,
      deliver: async (message, meta) => (await relay).deliver(message, meta, { journal: false, timeoutMs: 60_000 }),
      journal,
      signal: controller.signal,
      log: (text) => emit("trigger.error", text.trim()),
    });
  }
  const cwd = prepareWorkspace(runDir, resolved.workspace, { snapshotsDir });
  const extra: Record<string, string> = {};
  if (!resolved.env.BUILDER_BASE) extra.BUILDER_BASE = workspaceHead(cwd) ?? "HEAD";
  const dispatch = dispatchOf();
  if (dispatch !== undefined) {
    mkdirSync(join(runDir, "context"), { recursive: true });
    const jobFile = { runId, jobId: resolved.env.BUILDER_JOB_ID, dispatch, base: resolved.env.BUILDER_BASE ?? extra.BUILDER_BASE, startedAt: Date.parse(record.startedAt) };
    // The dispatch holds the callback URL: job.json gets the journal's secret redaction.
    writeAtomic(join(runDir, "context", "job.json"), JSON.stringify(redact(jobFile), null, 2) + "\n");
  }
  return runPi({
    command: env!.piCommand,
    resolved,
    runDir,
    cwd,
    env: { ...resolved.env, ...extra },
    ...(budgetMinutes !== undefined ? { budgetMinutes } : {}),
    signal: controller.signal,
    emit: (kind, msg, data) => {
      if (kind === "pi.done" && typeof data?.said === "string") piSaid = data.said;
      emit(kind, msg, data);
    },
    onSocket: (socket) => runtime.update(runId, { socket }),
    onRelay: relayReady,
    journal,
  });
}

let result: RunResult;
try {
  result = await work();
} catch (err) {
  result = { outcome: "failed", reason: (err as Error).message };
}
// Everything pi sent is read before the journal closes (pi has exited: its socket only needs reading to the end).
await journal?.drain(2000);
// A stop in progress gets its children down first; finish() is then called by its timer, or now when it has none.
if (stopReason !== null) {
  while (attachedChildren().length && !finished) await new Promise((r) => setTimeout(r, 200));
}
finish(result);
