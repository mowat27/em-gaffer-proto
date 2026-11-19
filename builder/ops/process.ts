/**
 * The process adapter (design sections 10 and 13, D13): how the build server process is started, found and stopped.
 *
 *   systemd    when this machine has the builder-server unit (vm/builder-server.service, installed by vm.sh launch),
 *              the server is the unit: `systemctl start|stop builder-server`. systemctl runs with --no-ask-password,
 *              and again through `sudo -n` when that is refused (the unit is a system unit; on an exe.dev VM the
 *              user has sudo without a password). `systemctl status builder-server` shows it whatever an agent did.
 *   detached   elsewhere (the laptop), a detached `node cli/builder.ts server run --run-id <id>` in its own session,
 *              so it outlives whoever started it. Its output goes to runs/<id>/log (`builder logs <id>`).
 *
 * Either way the server registers itself as a run (server/run.ts), and that is how it is found again: by its
 * run.json in runs/, alive with its id on its command line. Its settings come only from the machine config: a
 * detached server gets the starter's --config and --instance, and an environment without the BUILDER_* variables
 * of the run that started it.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { newRunId, readRecord, runProcessAlive } from "../runtime/run.ts";
import { BUILDER_ROOT } from "../runtime/root.ts";
import { isFinal, type RunRecord } from "../runtime/types.ts";
import { liveServerRuns, newServerRecord, RUN_ID_FLAG, writeServerRecord } from "../server/run.ts";

/** The systemd unit that owns the build server on a VM. */
export const UNIT = "builder-server.service";

const CLI = join(BUILDER_ROOT, "cli", "builder.ts");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface UnitState {
  /** ActiveState: active, inactive, failed, activating, deactivating. */
  state: string;
  active: boolean;
  /** MainPID, or null when it has none. */
  pid: number | null;
}

/** systemd's view of the builder-server unit; null when there is no systemctl or this machine has no such unit. */
export function unitState(): UnitState | null {
  const r = spawnSync("systemctl", ["show", UNIT, "-p", "LoadState", "-p", "ActiveState", "-p", "MainPID"], { encoding: "utf8", timeout: 15_000 });
  if (r.error || r.status !== 0) return null;
  const props: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  if (props.LoadState !== "loaded") return null;
  const state = props.ActiveState ?? "unknown";
  const pid = Number(props.MainPID);
  return { state, active: state === "active" || state === "activating" || state === "reloading", pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

/** `systemctl <verb> builder-server`, then through `sudo -n` when systemctl refuses. Throws with what both said. */
export function systemctl(verb: "start" | "stop"): void {
  const direct = spawnSync("systemctl", ["--no-ask-password", verb, UNIT], { encoding: "utf8", timeout: 120_000 });
  if (!direct.error && direct.status === 0) return;
  const why = (r: ReturnType<typeof spawnSync>) => (r.error ? r.error.message : String(r.stderr ?? "").trim() || `exit code ${r.status}`);
  if (process.getuid?.() === 0) throw new Error(`systemctl ${verb} ${UNIT}: ${why(direct)}`);
  const sudo = spawnSync("sudo", ["-n", "systemctl", verb, UNIT], { encoding: "utf8", timeout: 120_000 });
  if (!sudo.error && sudo.status === 0) return;
  throw new Error(`systemctl ${verb} ${UNIT}: ${why(direct)}; with sudo -n: ${why(sudo)}`);
}

/** The environment of a detached server: this one without the BUILDER_* variables of the run that starts it. */
export function serverEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("BUILDER_")) out[k] = v;
  return out;
}

export interface DetachOptions {
  runsDir: string;
  /** The --config layer and the instance the starter loaded: the server reads the same layers. */
  configPath?: string;
  instance?: string | null;
}

/** Start `builder server run` detached, as a new server run. Returns its first record (the process takes it over). */
export function startDetached(o: DetachOptions): RunRecord {
  const rec = newServerRecord(newRunId(), { detach: true });
  writeServerRecord(o.runsDir, rec);
  const log = openSync(join(o.runsDir, rec.id, "log"), "a");
  try {
    const args = [CLI, "server", "run", RUN_ID_FLAG, rec.id, ...(o.configPath ? ["--config", o.configPath] : []), ...(o.instance ? ["--instance", o.instance] : [])];
    const child = spawn(process.execPath, args, { cwd: BUILDER_ROOT, env: serverEnv(), stdio: ["ignore", log, log], detached: true });
    child.on("error", () => {
      /* reported through the record: it never leaves `starting` */
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  return rec;
}

/**
 * Wait until a server run is listening: the run `runId` when given, else one whose pid is `pid` (systemd's MainPID)
 * when given, else any. Throws with the run's reason when it fails, or when none is up within `ms`.
 */
export async function waitForServer(runsDir: string, ms: number, o: { runId?: string; pid?: number | null; notIn?: string[] } = {}): Promise<RunRecord> {
  const until = Date.now() + ms;
  for (;;) {
    if (o.runId) {
      const r = readRecord(runsDir, o.runId);
      if (r && isFinal(r.state)) throw new Error(`the server run ${r.id} ${r.state}${r.result?.outcome === "failed" ? `: ${r.result.reason}` : ""} (its output: ${join(runsDir, r.id, "log")})`);
      if (r?.state === "running" && runProcessAlive(r)) return r;
    } else {
      const up = liveServerRuns(runsDir).filter((r) => r.state === "running" && !(o.notIn ?? []).includes(r.id) && (!o.pid || r.pid === o.pid));
      if (up.length) return up[up.length - 1];
    }
    if (Date.now() >= until) break;
    await sleep(200);
  }
  throw new Error(`no build server listening on ${runsDir} after ${Math.round(ms / 1000)} s${o.runId ? ` (server run ${o.runId}: see ${join(runsDir, o.runId, "log")})` : ""}`);
}

/** Wait until none of `ids` is a live server run. False when one still is after `ms`. */
export async function waitGone(runsDir: string, ids: string[], ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const live = liveServerRuns(runsDir).filter((r) => ids.includes(r.id));
    if (!live.length) return true;
    if (Date.now() >= until) return false;
    await sleep(200);
  }
}
