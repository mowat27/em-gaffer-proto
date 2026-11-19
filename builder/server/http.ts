/**
 * The build server: the contract's HTTP side (docs/contract.md). Runs locally, one job at a time.
 *
 *   POST /slices   dispatch (202 accepted, 400 malformed, 422 { missing }, 503 + Retry-After while busy or draining)
 *   GET  /health   200 ok
 *
 * Each accepted job is a headless run of the active builder's workflow (server/job.ts). The server knows nothing
 * about pi, agents or workspaces: the builder definition says what a job does, the runtime runs it.
 *
 * Monitoring is the machine feed (runtime/feed.ts, `builder events`): server.start, server.state (idle, busy with a
 * job at a step, draining), server.stop, and the job and callback events. There is no status endpoint.
 *
 * Control (E14): the server polls its control inbox (server/control.ts) every second. drain lets the running job
 * finish and answers every dispatch 503 until resume; cancel stops the running job, which posts `failed` with
 * `cancelled by operator`. Each message is journaled (control.received, control.applied) in the job's run and the
 * feed, and answered in the outbox.
 *
 * Configuration: the layered machine config (ops/config.ts: packaged, ~/.gaffer/config.yml, $GAFFER_CONFIG), read at
 * start (a broken layer stops the server, E22) and again at every accept (a broken layer then keeps the last good
 * config). Runs on Node 24 type stripping: only erasable TypeScript syntax is used.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { jobLabel, jobName } from "../engine/job-name.ts";
import type { Builder } from "../engine/types.ts";
import { loadConfig, type LoadOptions } from "../ops/config.ts";
import { activeBuilder, loadActive, type LoadedActive } from "../ops/definitions/active.ts";
import { controlDir, startInboxPoller, type ControlMessage, type ControlResult, type Poller } from "./control.ts";
import { CANCELLED, feedOf, feedState, journalToRun, pruneRuns, recoverJobs, runJob, runtimeFor, serverEmitter, stateOf, type CurrentJob, type ServerState } from "./job.ts";
import { missingRequirements, validate } from "./validate.ts";

/** How often a running server applies the retention period (runtime/retention.ts). */
const RETENTION_EVERY_MS = 60 * 60 * 1000;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Apply one control message to the server's state. */
async function applyControl(state: ServerState, msg: ControlMessage, id: string): Promise<ControlResult> {
  const job = state.current;
  const runtime = runtimeFor(state.cfg);
  const feed = feedOf(state.cfg);
  const ids = { ...(job ? { jobId: job.jobId } : {}), ...(job?.runId ? { runId: job.runId } : {}) };
  const received = { id, action: msg.action, ...(msg.jobId ? { jobId: msg.jobId } : {}), ...(msg.by ? { by: msg.by } : {}) };
  feed({ kind: "control.received", ...ids, data: received });
  if (job?.runId) journalToRun(runtime, job.runId, { kind: "control.received", data: received });

  let result: ControlResult;
  if (msg.action === "drain") {
    state.draining = true;
    result = { ok: true, ...stateOf(state) };
  } else if (msg.action === "resume") {
    state.draining = false;
    result = { ok: true, ...stateOf(state) };
  } else if (!job) {
    result = { ok: false, error: "no job is running", ...stateOf(state) };
  } else if (msg.jobId && msg.jobId !== job.jobId && msg.jobId !== jobName(job.jobId)) {
    result = { ok: false, error: `job ${msg.jobId} is not running (the running job is ${jobLabel(job.jobId)})`, ...stateOf(state) };
  } else if (job.step === "callback" || job.step === "cleanup") {
    result = { ok: false, error: `job ${jobLabel(job.jobId)} has finished its run and is at ${job.step}: too late to cancel`, ...stateOf(state) };
  } else {
    job.cancelled = true;
    if (job.runId) await runtime.stop(job.runId, CANCELLED);
    result = { ok: true, ...stateOf(state) };
  }
  const applied = { id, action: msg.action, result };
  serverEmitter(state)("control", `control ${msg.action}${msg.by ? ` from ${msg.by}` : ""}: ${result.ok ? "applied" : result.error}`);
  feed({ kind: "control.applied", ...ids, data: applied });
  if (job?.runId) journalToRun(runtime, job.runId, { kind: "control.applied", data: applied });
  feedState(state);
  return result;
}

export function startServer(o: LoadOptions = {}): Server {
  const state: ServerState = { cfg: loadConfig(o), current: null, lastJob: null, draining: false };
  const emit = serverEmitter(state);
  let poller: Poller | null = null;

  async function slices(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
    const v = validate(body);
    if (!v.ok) {
      emit("reject", `400: ${v.error}`);
      return json(res, 400, { error: v.error });
    }
    // Everything that awaits happens here, before the busy check, so the check and the accept below run in one go.
    let cfg = state.cfg;
    try {
      cfg = loadConfig(o);
    } catch (err) {
      emit("config.error", `could not read the config, keeping the last one: ${(err as Error).message}`);
    }
    // The active builder (ops/definitions/active.ts): a config pin, else active.yml, else the default. E2: one that does
    // not load runs its last valid version from the history; with none the job is accepted below and its run fails
    // with the definition's error.
    let active: LoadedActive | null = null;
    try {
      active = await loadActive(cfg);
    } catch (err) {
      emit("builder.error", `could not load the active builder: ${(err as Error).message}`);
    }
    const builder: Builder | null = active?.builder ?? null;
    if (state.current) {
      emit("busy", `503: busy with job ${jobLabel(state.current.jobId)}`);
      return json(res, 503, { error: "busy", jobId: state.current.jobId }, { "retry-after": "15" });
    }
    if (state.draining) {
      emit("draining", "503: draining (resume through the control inbox)");
      return json(res, 503, { error: "draining" }, { "retry-after": "15" });
    }
    state.cfg = cfg;
    const missing = missingRequirements(v.d, builder ? builder.provides : null);
    if (missing.length) {
      emit("reject", `422: cannot meet ${missing.join(", ")}`, { missing });
      return json(res, 422, { missing });
    }
    const jobId = v.d.callback.split("/").pop() as string;
    const job: CurrentJob = { jobId, title: v.d.task.title, context: v.d.task.context, attempt: v.d.task.attempt, startedAt: Date.now(), step: "accepted", runId: null, ...(active ? { active } : {}) };
    state.current = job;
    emit("accepted", `202: job ${jobLabel(jobId)} for ${v.d.task.context}/${v.d.task.title} (attempt ${v.d.task.attempt})`, {
      sliceId: v.d.task.sliceId,
      base: v.d.repo.base,
      attempt: v.d.task.attempt,
    });
    feedState(state);
    json(res, 202, { jobId });
    void runJob(state, cfg, v.d, job, emit).catch((err: Error) => {
      emit("job.error", `job ${jobLabel(jobId)} broke the job loop: ${err.message}`);
      if (state.current === job) state.current = null;
      feedState(state);
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/slices") return await slices(req, res);
      json(res, 404, { error: "not found" });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
  });

  const { host, port, runsDir } = state.cfg.server;
  const control = controlDir(runsDir);
  server.listen(port, host, () => {
    emit("listening", `build server listening on http://${host}:${port}`, { host, port, pid: process.pid });
    const active = activeBuilder(state.cfg);
    feedOf(state.cfg)({ kind: "server.start", data: { pid: process.pid, host, port, builder: active.id, builderSource: active.source, runsDir, control, layers: state.cfg.layers, instance: state.cfg.instance } });
    feedState(state);
    void recoverJobs(state.cfg, emit);
    poller = startInboxPoller(control, (msg, id) => applyControl(state, msg, id));
    // Retention: at start and every hour, so a server with no jobs still lets old run data go.
    void pruneRuns(state.cfg, emit);
    setInterval(() => void pruneRuns(state.cfg, emit), RETENTION_EVERY_MS).unref();
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // The job's run notices that its parent is gone and stops; the next server start sends its callback (E13).
      emit("stopping", `build server stopping (${sig})${state.current ? `, abandoning job ${jobLabel(state.current.jobId)}` : ""}`);
      poller?.stop();
      feedOf(state.cfg)({ kind: "server.stop", ...(state.current ? { jobId: state.current.jobId } : {}), data: { signal: sig, pid: process.pid, ...(state.current ? { abandoned: state.current.jobId } : {}) } });
      server.close();
      process.exit(0);
    });
  }
  return server;
}
