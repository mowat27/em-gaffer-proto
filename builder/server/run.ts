/**
 * The build server as a run (design sections 2 and 10, D13): `builder server run` registers runs/<id>/run.json with
 * kind "server", runs server/http.ts in its own process and records how it ended. systemd's builder-server unit runs
 * it in the foreground; on a machine without the unit, server_start starts it as a detached process (ops/process.ts).
 * Either way it is found again through runs/: a live server run is one whose state is not final and whose process is
 * alive with the run id on its command line (runtime/run.ts runProcessAlive).
 *
 * The id is on the command line: started without `--run-id` (systemd's ExecStart), the process picks an id and
 * replaces itself with the same command plus `--run-id <id>` (process.execve: the same pid, which systemd watches).
 *
 *   starting   the record exists (written by the starter, or by the process itself)
 *   running    the server listens
 *   stopped    ended by SIGTERM or SIGINT (systemctl stop, server_stop): result done, with the signal
 *   failed     it could not listen, or crashed: result failed with the reason
 *
 * One server per runs directory: while another live server run exists, a second one refuses to start and exits 3
 * (the CLI's "refused", which the systemd unit does not restart on). Server runs have no parent, and job runs are not
 * their children: a job's tree stays its own (retention, job_get). A server run left behind by a process that is gone
 * (SIGKILL, power loss) is marked failed by the next server that starts on the runs directory (G8).
 *
 * The machine feed keeps server.start, server.state and server.stop (written by server/http.ts); a crash after the
 * server listened adds a server.stop with the error. Nothing here loads server/http.ts until the server starts, so
 * the process tools (ops/process.ts) can use the lookups below inside any agent's pi process.
 */
import { appendFileSync, fstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendFeed } from "../runtime/feed.ts";
import { createRuntime, newRunId, readRecord, runProcessAlive, writeAtomic } from "../runtime/run.ts";
import { isFinal, type RunRecord, type RunResult, type RunState } from "../runtime/types.ts";

/** The flag that carries a server run's id on its command line. */
export const RUN_ID_FLAG = "--run-id";

/** Exit code of a server that refused to start because another one runs on its runs directory. */
export const EXIT_ALREADY_RUNNING = 3;

/**
 * A detached server's output goes to runs/<id>/log (ops/process.ts); under systemd it goes to the journal. Then a copy
 * goes to the run's log too, so `run_log server` (the TSF's Logs tab) reads the server's output either way.
 */
function teeToLog(file: string): void {
  try {
    if (fstatSync(1).isFile()) return;
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return;
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      try {
        if (typeof chunk === "string" || chunk instanceof Uint8Array) appendFileSync(file, chunk);
      } catch {
        /* the log is a copy */
      }
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}

/** Every server run in a runs directory, oldest first. */
export function serverRuns(runsDir: string): RunRecord[] {
  return createRuntime({ runsDir, piCommand: "pi" })
    .list()
    .filter((r) => r.kind === "server");
}

/** Server runs whose process is alive (state starting or running), oldest first. */
export function liveServerRuns(runsDir: string, except?: string): RunRecord[] {
  return serverRuns(runsDir).filter((r) => r.id !== except && !isFinal(r.state) && runProcessAlive(r));
}

/** A server run's first record. The starter writes it (detached), or the server process itself (systemd). */
export function newServerRecord(id: string, o: { detach?: boolean; pid?: number | null } = {}): RunRecord {
  return { id, parent: null, kind: "server", spec: o.detach ? { detach: true } : {}, state: "starting", pid: o.pid ?? null, startedAt: new Date().toISOString() };
}

export function writeServerRecord(runsDir: string, rec: RunRecord): void {
  mkdirSync(join(runsDir, rec.id), { recursive: true });
  writeAtomic(join(runsDir, rec.id, "run.json"), JSON.stringify(rec, null, 2) + "\n");
}

function update(runsDir: string, id: string, patch: Partial<RunRecord>): RunRecord | null {
  const cur = readRecord(runsDir, id);
  if (!cur) return null;
  const next = { ...cur, ...patch, id } as RunRecord;
  writeServerRecord(runsDir, next);
  return next;
}

/** Mark server runs whose process is gone without a final state (a SIGKILL, a crash before the record was written). */
export function markGoneServerRuns(runsDir: string, except: string): string[] {
  const marked: string[] = [];
  for (const r of serverRuns(runsDir)) {
    if (r.id === except || isFinal(r.state)) continue;
    // A record a starter wrote a moment ago, whose process has not registered yet, is not gone.
    if (r.pid === null && Date.now() - Date.parse(r.startedAt) < 30_000) continue;
    if (runProcessAlive(r)) continue;
    update(runsDir, r.id, { state: "failed", endedAt: new Date().toISOString(), result: { outcome: "failed", reason: "the server's process ended without recording how (killed, or the machine stopped)" } });
    marked.push(r.id);
  }
  return marked;
}

/**
 * Replace this process with the same command plus `--run-id <id>`, so the server run's id is on its command line. The
 * pid stays the same. Never returns. Nothing may be printed before it: output still buffered for a pipe is lost.
 */
export function execWithRunId(id = newRunId()): never {
  if (typeof process.execve !== "function") throw new Error("builder server run needs Node 24 or later (process.execve)");
  return process.execve(process.execPath, [process.execPath, ...process.execArgv, process.argv[1], ...process.argv.slice(2), RUN_ID_FLAG, id], process.env);
}

export interface ServerRunOptions {
  runId: string;
  /** Where runs live: the machine config's server.runsDir. */
  runsDir: string;
  /** How the server loads its config (the same layers this process read). */
  configPath?: string;
  instance?: string;
}

/**
 * Run the build server in this process as the run `runId`. Resolves only with an exit code when it cannot start
 * (another live server, EADDRINUSE); otherwise the process ends through a signal or a crash, and run.json says how.
 */
export async function runServer(o: ServerRunOptions): Promise<number> {
  const { runsDir, runId } = o;
  teeToLog(join(runsDir, runId, "log"));
  const others = liveServerRuns(runsDir, runId);
  if (others.length) {
    const r = others[others.length - 1];
    const reason = `a build server already runs on ${runsDir}: run ${r.id} (pid ${r.pid})`;
    if (readRecord(runsDir, runId)) update(runsDir, runId, { state: "failed", pid: process.pid, endedAt: new Date().toISOString(), result: { outcome: "failed", reason } });
    console.error(`[builder] ${reason}`);
    return EXIT_ALREADY_RUNNING;
  }
  for (const id of markGoneServerRuns(runsDir, runId)) console.log(`[builder] server run ${id} had ended without a record: marked failed`);

  const existing = readRecord(runsDir, runId);
  if (existing && existing.kind !== "server") throw new Error(`run ${runId} is not a server run`);
  if (existing && isFinal(existing.state)) throw new Error(`server run ${runId} has already ended (${existing.state})`);
  writeServerRecord(runsDir, { ...(existing ?? newServerRecord(runId)), state: "starting", pid: process.pid });

  let signal: NodeJS.Signals | null = null;
  let failure: string | null = null;
  let listening = false;
  // Before server/http.ts adds its own handlers (which exit), so the signal is known when the record is written.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (signal ??= sig));
  process.on("exit", (code) => {
    const cur = readRecord(runsDir, runId);
    if (!cur || isFinal(cur.state)) return;
    const reason = failure ?? (signal || code === 0 ? null : `the server exited with code ${code}`);
    const state: RunState = reason ? "failed" : signal ? "stopped" : "done";
    const result: RunResult = reason ? { outcome: "failed", reason } : { outcome: "done", data: signal ? { signal } : {} };
    try {
      update(runsDir, runId, { state, endedAt: new Date().toISOString(), result });
    } catch {
      /* the runs directory is gone */
    }
  });
  process.on("uncaughtException", (err) => {
    failure = `the server crashed: ${err.message}`;
    console.error(err.stack ?? String(err));
    if (listening) appendFeed(runsDir, { kind: "server.stop", data: { pid: process.pid, runId, error: err.message } });
    process.exit(1);
  });

  const { startServer } = await import("./http.ts");
  const server = startServer({ ...(o.configPath ? { configPath: o.configPath } : {}), ...(o.instance ? { instance: o.instance } : {}) });
  server.on("listening", () => {
    listening = true;
    update(runsDir, runId, { state: "running" });
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    failure = `the server could not listen: ${err.message}`;
    console.error(`[builder] ${failure}`);
    process.exit(1);
  });
  // The server keeps the process alive; it ends through a signal (server/http.ts exits) or the handlers above.
  return new Promise<number>(() => {});
}
