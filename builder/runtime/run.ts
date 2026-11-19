/**
 * Runs as processes. Each run is `node runtime/main.ts <runId>`, registered in runs/<id>/run.json, which is rewritten
 * atomically (tmp + rename). The process that starts a run writes the first record (state `starting`). From then on
 * the run's own process writes it (running, step, the result), and the starter writes it again only once that
 * process has ended: to note a crash, a stop, or that a job's callback was made.
 *
 * A run whose parent process ends stops its own children and ends `stopped`, unless it was started with
 * `detach: true` (runtime/main.ts watches for that). A stopping run stops its children, except detached ones (E23).
 *
 * Budgets (subagents, design section 5): a run gets its spec's budgetMinutes, but a run started by an agent run gets at
 * most what is left of that run's budget, detached or not (G6). run.json pins the result as `budgetMinutes` and
 * `deadline`; a parent with under a minute left starts nothing (a pi run's shortest budget is a minute). A workflow
 * run's agent steps get their step budgets from the engine, which stops them at the job's deadline.
 *
 * Names: at most one live run has a given `name` (messaging addresses it by name), and an agent has at most one live
 * durable run (its session and state/ are the agent's own). Durable and named runs always keep a journal: they take
 * messages and triggers, which are journaled.
 *
 * Starting resolves the spec first (runtime/resolve.ts): the agent's agent.yml, the defaults.yml above it, the machine
 * limit and the parent's tools. An unknown agent, a broken agent.yml or a run the parent may not start (E8) throws
 * here, to the starter, and no run is made. What it resolved to is pinned in run.json.
 *
 * Whether the run keeps a journal (runtime/journal.ts) is decided here too and pinned in run.json: workflow runs, job
 * runs and the children of a run with a journal always, an agent run started directly only with `journal: true`.
 *
 * Config reload: `config_reload` writes runs/<id>/config.json (RunConfig) into every live run. A run's runtime uses
 * that limit, when there is one, for the children it starts from then on (and passes it down in their environment);
 * ops/pi-extension.ts re-registers the run's own tools from it at the next turn.
 *
 * Machine feed (runtime/feed.ts): a run's process writes its own run.start and run.end; a starter that finds the
 * process gone without a result writes the run.end itself. run.end is always in the feed before the final state is
 * in run.json, so a reader that waits on run.json finds it.
 *
 * The runtime knows nothing about the contract or about workflow steps.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolLimit } from "../ops/groups.ts";
import { appendFeed } from "./feed.ts";
import { ceilingOf, resolve as resolveSpec } from "./resolve.ts";
import { BUILDER_ROOT } from "./root.ts";
import { isFinal, type Emit, type RunJob, type RunRecord, type RunResult, type RunSpec, type Runtime } from "./types.ts";

export { BUILDER_ROOT } from "./root.ts";
const MAIN = join(BUILDER_ROOT, "runtime", "main.ts");

export interface RuntimeOptions {
  /** Where runs live (absolute). */
  runsDir: string;
  /** The pi executable that agent runs start. */
  piCommand: string;
  /** The machine config files given with --config: the run tree protects them (write-scope) and reloads with them. */
  configFiles?: string[];
  /** The run this process is, when it is one: the default parent of the runs it starts. */
  self?: string;
  /** The machine limit on every run's tools (ops/config.ts). Default: no limit. */
  limit?: ToolLimit;
  /** Another agent tree than builder/agentics (tests). */
  agenticsDir?: string;
}

export interface LocalRuntime extends Runtime {
  readonly options: RuntimeOptions;
  /** Merge `patch` into a run's record and rewrite it. Throws when the run does not exist. */
  update(id: string, patch: Partial<RunRecord>): RunRecord;
  /** stop() with another escalation delay, for a run stopping its own children inside its own stop budget. */
  stopWithin(id: string, reason: string, killAfterMs: number): Promise<void>;
}

/** Runtime options travel to run processes in these variables, so a run tree shares the settings its root started with. */
const ENV = { runsDir: "BUILDER_RUNS_DIR", piCommand: "BUILDER_PI_COMMAND", configFiles: "BUILDER_CONFIG_FILES", limit: "BUILDER_LIMIT", agenticsDir: "BUILDER_AGENTICS_DIR" } as const;

/** No limit: what a runtime created without a machine config allows. */
export const NO_LIMIT: ToolLimit = { enable: ["*"], disable: [] };

export function runtimeEnv(o: RuntimeOptions): Record<string, string> {
  return {
    [ENV.runsDir]: o.runsDir,
    [ENV.piCommand]: o.piCommand,
    [ENV.limit]: JSON.stringify(o.limit ?? NO_LIMIT),
    ...(o.configFiles?.length ? { [ENV.configFiles]: JSON.stringify(o.configFiles) } : {}),
    ...(o.agenticsDir ? { [ENV.agenticsDir]: o.agenticsDir } : {}),
  };
}

/** The options a run process was started with, or null when this process was not started by a runtime. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<RuntimeOptions, "self"> | null {
  const runsDir = env[ENV.runsDir];
  const piCommand = env[ENV.piCommand];
  if (!runsDir || !piCommand) return null;
  let limit: ToolLimit = NO_LIMIT;
  try {
    if (env[ENV.limit]) limit = JSON.parse(env[ENV.limit]!) as ToolLimit;
  } catch {
    // A broken snapshot must not widen anything: nothing is allowed.
    limit = { enable: [], disable: [] };
  }
  let configFiles: string[] = [];
  try {
    const files: unknown = JSON.parse(env[ENV.configFiles] || "[]");
    if (Array.isArray(files)) configFiles = files.filter((f): f is string => typeof f === "string" && !!f);
  } catch {
    /* not a list: none */
  }
  return {
    runsDir,
    piCommand,
    limit,
    ...(configFiles.length ? { configFiles } : {}),
    ...(env[ENV.agenticsDir] ? { agenticsDir: env[ENV.agenticsDir] } : {}),
  };
}

/** runs/<id>/config.json: what config_reload told a live run. */
export const RUN_CONFIG_FILE = "config.json";

export interface RunConfig {
  loadedAt: string;
  /** The layers that were read, lowest first. */
  layers: string[];
  instance: string | null;
  /** The machine limit from then on. */
  limit: ToolLimit;
}

/** A run's config.json, or null when config_reload has not told it anything (or the file is unreadable). */
export function readRunConfig(runDir: string): RunConfig | null {
  try {
    const c = JSON.parse(readFileSync(join(runDir, RUN_CONFIG_FILE), "utf8")) as RunConfig;
    return c && c.limit && Array.isArray(c.limit.enable) && Array.isArray(c.limit.disable) ? c : null;
  } catch {
    return null;
  }
}

/** The machine limit for a run now: its config.json's when config_reload told it one, else the one it started with. */
export function liveLimit(runDir: string | null, startedWith: ToolLimit): ToolLimit {
  return (runDir ? readRunConfig(runDir)?.limit : null) ?? startedWith;
}

/**
 * Whether a run keeps a journal: workflow runs and server job runs always, the children of a run with a journal always
 * (they inherit, so every tool call of a job is in a journal), durable and named runs always (they take messages and
 * triggers), any other agent run started directly only when its spec asks.
 */
export function hasJournal(kind: "workflow" | "agent", spec: RunSpec, job: RunJob | undefined, parent: RunRecord | null, mode?: string): boolean {
  return kind === "workflow" || !!job || spec.journal === true || parent?.journal === true || mode === "durable" || !!spec.name;
}

/** A pi run's shortest budget, in minutes (runtime/pi.ts). */
export const MIN_BUDGET_MINUTES = 1;

/**
 * A run's budget: the spec's budgetMinutes, within what is left of an agent parent's (its `deadline`). Throws when
 * the parent has under a minute left. Minutes are rounded down to a hundredth, so a child never outlasts its parent.
 */
export function budgetOf(spec: RunSpec, parent: RunRecord | null, now = Date.now()): { budgetMinutes?: number; deadline?: string } {
  const own = spec.budgetMinutes;
  const end = parent?.kind === "agent" && parent.deadline ? Date.parse(parent.deadline) : Number.NaN;
  const at = (minutes: number) => ({ budgetMinutes: minutes, deadline: new Date(now + minutes * 60_000).toISOString() });
  if (Number.isNaN(end)) return own !== undefined ? at(own) : {};
  const left = Math.floor(((end - now) / 60_000) * 100) / 100;
  if (left < MIN_BUDGET_MINUTES) {
    throw new Error(`run refused: agent ${parent!.spec.agent} (run ${parent!.id}) has ${left > 0 ? `${left} min` : "nothing"} left of its budget, under the ${MIN_BUDGET_MINUTES} min a run needs`);
  }
  return at(own !== undefined && own <= left ? own : left);
}

/** Why a run cannot start beside the live runs: its name is taken, or its agent already has a live durable run. */
function liveConflict(spec: RunSpec, mode: string, runs: () => RunRecord[]): string | null {
  if (!spec.name && mode !== "durable") return null;
  for (const r of runs()) {
    if (isFinal(r.state) || r.kind === "server") continue;
    const sameName = !!spec.name && r.spec.name === spec.name;
    const sameDurable = mode === "durable" && r.resolved?.mode === "durable" && !!spec.agent && r.spec.agent === spec.agent;
    if (!sameName && !sameDurable) continue;
    // A run whose process is gone (a crash left its record running) is not live.
    if (r.pid !== null && !runProcessAlive(r)) continue;
    if (sameName) return `run refused: run ${r.id} is live with the name ${spec.name} (a name addresses one live run)`;
    return `run refused: agent ${spec.agent} already has a live durable run, ${r.id} (its session and state/ are the agent's own)`;
  }
  return null;
}

/** `20261117-203315-a1b2c3`: sorts by start time, readable in `ls runs/`. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function readRecord(runsDir: string, id: string): RunRecord | null {
  try {
    return JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

let tmpSeq = 0;
/** Write a file so readers only ever see the old or the new content. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function writeRecord(runsDir: string, rec: RunRecord): void {
  writeAtomic(join(runsDir, rec.id, "run.json"), JSON.stringify(rec, null, 2) + "\n");
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the run's process is alive and still is that run (not a later process that reused its pid). */
export function runProcessAlive(rec: Pick<RunRecord, "id" | "pid">): boolean {
  if (rec.pid === null || !processAlive(rec.pid)) return false;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(rec.pid)], { encoding: "utf8" });
  if (ps.status !== 0 && !ps.stdout) return ps.error ? true : false; // no ps: trust the pid
  return ps.stdout.includes(rec.id);
}

/**
 * Appends events as JSON lines to each file, and the message to stderr unless `quiet` (an interactive run's terminal
 * belongs to pi). Progress is diagnostics: stdout stays for data (`builder run --json`). Never throws: observing never
 * breaks a build.
 */
export function eventWriter(files: (string | undefined)[], base: () => Record<string, unknown> = () => ({}), quiet = false): Emit {
  return (kind, msg, data = {}) => {
    try {
      if (!quiet) console.error(`[builder] ${msg}`);
    } catch {
      /* stderr gone */
    }
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), source: "builder", kind, msg, ...base(), ...data }) + "\n";
    } catch {
      return;
    }
    for (const file of files) {
      if (!file) continue;
      try {
        appendFileSync(file, line);
      } catch (err) {
        try {
          console.error(`[builder] could not append to ${file}: ${(err as Error).message}`);
        } catch {
          /* stderr gone */
        }
      }
    }
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean, ms: number, every = 200): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await sleep(every);
  }
  return done();
}

interface Handle {
  child: ChildProcess;
  exited: boolean;
  how: string;
}

export function createRuntime(options: RuntimeOptions): LocalRuntime {
  const o: RuntimeOptions = { ...options, runsDir: resolve(options.runsDir) };
  const handles = new Map<string, Handle>();
  const dir = (id: string) => join(o.runsDir, id);
  const get = (id: string) => readRecord(o.runsDir, id);
  const update = (id: string, patch: Partial<RunRecord>): RunRecord => {
    const cur = get(id);
    if (!cur) throw new Error(`no run ${id} in ${o.runsDir}`);
    const next = { ...cur, ...patch, id: cur.id } as RunRecord;
    writeRecord(o.runsDir, next);
    return next;
  };
  /** Has the run's process ended (or never started)? */
  const processGone = (rec: RunRecord): boolean => {
    const h = handles.get(rec.id);
    if (h) return h.exited;
    if (rec.pid === null) return Date.now() - Date.parse(rec.startedAt) > 30_000;
    return !runProcessAlive(rec);
  };

  /** The limit for the runs this runtime starts: a reload's, when the run this process is was told one. */
  const limitNow = (): ToolLimit => liveLimit(o.self ? dir(o.self) : null, o.limit ?? NO_LIMIT);
  /** A run that ended without writing its own run.end (its process vanished): the feed still gets one. */
  const feedEnd = (rec: RunRecord, state: RunRecord["state"], result: RunResult) =>
    appendFeed(o.runsDir, {
      kind: "run.end",
      runId: rec.id,
      ...(rec.job ? { jobId: rec.job.jobId } : {}),
      data: { state, outcome: result.outcome, ...(result.outcome === "failed" ? { reason: result.reason } : {}), ms: Date.now() - Date.parse(rec.startedAt), by: "starter" },
    });

  const start: Runtime["start"] = async (spec, opts = {}) => {
    const kind = spec.workflow && !spec.agent ? "workflow" : spec.agent && !spec.workflow ? "agent" : null;
    if (!kind) throw new Error("a run spec names exactly one of workflow and agent");
    const parentId = opts.parent ?? o.self ?? null;
    const parent = parentId ? get(parentId) : null;
    const id = newRunId();
    const limit = limitNow();
    const resolved = resolveSpec(spec, { config: { limit }, parent, runDir: dir(id), ...(o.agenticsDir ? { agentics: o.agenticsDir } : {}) });
    // An interactive run owns the terminal it was launched from; a detached run writes to its own output file.
    const interactive = resolved.mode === "interactive";
    if (interactive && spec.detach) throw new Error("an interactive run cannot be detached: it runs in the launching terminal");
    const now = Date.now();
    const budget = budgetOf(spec, parent, now);
    const conflict = liveConflict(spec, resolved.mode, list);
    if (conflict) throw new Error(conflict);
    mkdirSync(dir(id), { recursive: true });
    const rec: RunRecord = {
      id,
      parent: parentId,
      kind,
      spec,
      state: "starting",
      pid: null,
      startedAt: new Date(now).toISOString(),
      ...(opts.job ? { job: opts.job } : {}),
      resolved,
      ceiling: ceilingOf(kind, resolved, parent),
      journal: hasJournal(kind, spec, opts.job, parent, resolved.mode),
      ...budget,
    };
    writeRecord(o.runsDir, rec);
    try {
      opts.onRecord?.(rec, dir(id));
    } catch {
      /* the starter's own bookkeeping: it never stops the run */
    }
    const out = spec.detach ? openSync(join(dir(id), "output"), "a") : null;
    const child = spawn(process.execPath, [MAIN, id], {
      env: { ...process.env, ...runtimeEnv({ ...o, limit }) },
      stdio: out !== null ? ["ignore", out, out] : interactive ? "inherit" : ["ignore", "inherit", "inherit"],
      detached: !!spec.detach,
    });
    if (out !== null) closeSync(out);
    const h: Handle = { child, exited: false, how: "" };
    handles.set(id, h);
    child.on("exit", (code, signal) => {
      h.exited = true;
      h.how = signal ? `signal ${signal}` : `exit code ${code}`;
    });
    child.on("error", (err) => {
      h.exited = true;
      h.how = `could not start: ${err.message}`;
    });
    if (spec.detach) child.unref();
    return { ...rec, pid: child.pid ?? null };
  };

  const wait: Runtime["wait"] = (id, signal) =>
    new Promise<RunResult>((resolveWait, rejectWait) => {
      let lastCheck = 0;
      let timer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void) => {
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => rejectWait(signal?.reason));
      if (signal?.aborted) return rejectWait(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const check = () => {
        const rec = get(id);
        if (!rec) return finish(() => rejectWait(new Error(`no run ${id} in ${o.runsDir}`)));
        if (isFinal(rec.state)) return finish(() => resolveWait(rec.result ?? { outcome: "failed", reason: `run ${id} ended ${rec.state} without a result` }));
        // Checking a process we did not start costs a `ps`: once a second is enough.
        if (!handles.has(id) && Date.now() - lastCheck < 1000) return;
        lastCheck = Date.now();
        if (!processGone(rec)) return;
        const again = get(id);
        if (again && isFinal(again.state)) return finish(() => resolveWait(again.result ?? { outcome: "failed", reason: `run ${id} ended ${again.state} without a result` }));
        const how = handles.get(id)?.how;
        const result: RunResult = { outcome: "failed", reason: `run ${id} ended without a result${how ? ` (${how})` : ""}` };
        try {
          // The feed before the final state, as the run's own process does it.
          feedEnd(rec, "failed", result);
          update(id, { state: "failed", endedAt: new Date().toISOString(), result });
        } catch {
          /* the run's directory is gone */
        }
        finish(() => resolveWait(result));
      };
      timer = setInterval(check, 200);
      check();
    });

  const stopWithin = async (id: string, reason: string, killAfterMs: number): Promise<void> => {
    const rec = get(id);
    if (!rec || isFinal(rec.state)) return;
    try {
      writeFileSync(join(dir(id), "stop"), reason);
    } catch {
      /* best effort: the reason is also in the record below */
    }
    const pid = handles.get(id)?.child.pid ?? rec.pid;
    const gone = () => {
      const r = get(id);
      return !r || isFinal(r.state) || processGone(pid !== undefined && pid !== null ? { ...r, pid } : r);
    };
    if (pid !== null && pid !== undefined && !gone()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      if (!(await until(gone, killAfterMs))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        await until(gone, 2000);
      }
    }
    const after = get(id);
    if (after && !isFinal(after.state)) {
      feedEnd(after, "stopped", { outcome: "failed", reason });
      update(id, { state: "stopped", endedAt: new Date().toISOString(), result: { outcome: "failed", reason } });
    }
  };

  const list = (): RunRecord[] => {
    if (!existsSync(o.runsDir)) return [];
    const out: RunRecord[] = [];
    for (const e of readdirSync(o.runsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const rec = get(e.name);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  };

  return {
    options: o,
    start,
    wait,
    stop: (id, reason = "stopped") => stopWithin(id, reason, 5000),
    stopWithin,
    get,
    list,
    dir,
    update,
  };
}

/** The job a run belongs to: its own, or the nearest ancestor's. */
export function jobOf(rt: Runtime, rec: RunRecord): RunJob | null {
  let cur: RunRecord | null = rec;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (cur.job) return cur.job;
    cur = cur.parent ? rt.get(cur.parent) : null;
  }
  return null;
}

