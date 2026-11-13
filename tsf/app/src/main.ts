import { existsSync, openSync, readSync, closeSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isAlive, readLockPid, readServerState } from "./core/lock.ts";
import { projectPaths, resolveProjectRoot, type ProjectPaths } from "./core/paths.ts";
import { unitName, unitPath } from "./core/systemd.ts";

const USAGE = `usage: tsf <command> [options]

commands:
  start [--tools a,b] [--port n] [--host h] [--dev]   run the factory in this terminal
  stop [--force]                                       stop the running factory
  restart [start options]                              restart the running factory through its API (starts it when it is not running)
  status [--json]                                      show whether the factory is running
  logs [-f] [-n N]                                     show the end of tsf/data/logs/tsf.log
`;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ParsedArgs {
  flags: Map<string, string[]>;
  positional: string[];
}

/** Flags that take a value; every other `--x` / `-x` is a boolean. Accepts `--port 1` and `--port=1`. */
function parseArgs(args: readonly string[], valued: ReadonlySet<string>): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const add = (k: string, v: string): void => {
    const list = flags.get(k) ?? [];
    list.push(v);
    flags.set(k, list);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (valued.has(name)) {
        if (eq !== -1) add(name, a.slice(eq + 1));
        else {
          const next = args[i + 1];
          if (next === undefined) throw new UsageError(`${name} needs a value`);
          add(name, next);
          i++;
        }
      } else {
        add(name, "true");
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

class UsageError extends Error {}

function intFlag(p: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const v = p.flags.get(name)?.at(-1);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max) throw new UsageError(`${name} must be an integer ${min}..${max}`);
  return n;
}

function requireTsf(paths: ProjectPaths): boolean {
  return existsSync(paths.tsfDir);
}

async function cmdStart(args: readonly string[]): Promise<number> {
  const p = parseArgs(args, new Set(["--tools", "--port", "--host"]));
  const port = intFlag(p, "--port", 0, 65535);
  const host = p.flags.get("--host")?.at(-1);
  const toolList = (p.flags.get("--tools") ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
  const tools = p.flags.has("--tools") ? toolList : null;
  const dev = p.flags.has("--dev");
  const { runServer } = await import("./server/main.ts");
  await runServer({ host, port, tools, dev });
  // The listening server keeps the process alive; runServer's signal handlers exit it.
  return await new Promise<number>(() => undefined);
}

async function cmdRestart(args: readonly string[]): Promise<number> {
  const paths = projectPaths(resolveProjectRoot(process.cwd()));
  const state = readServerState(paths.serverState);
  if (!state || !isAlive(state.pid)) {
    out("not running; starting");
    return await cmdStart(args);
  }
  const oldPid = state.pid;
  const res = await fetch(`${state.url}/api/factory/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "tsf restart" }),
    signal: AbortSignal.timeout(5000),
  }).catch((e: unknown) => {
    throw new Error(`could not reach ${state.url}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) {
    err(`tsf: the factory refused to restart: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return 1;
  }
  out(`restarting (pid ${oldPid})`);
  // The old process exits, then a supervisor or its own detached replacement starts the new one.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const now = readServerState(paths.serverState);
    if (now && now.pid !== oldPid && isAlive(now.pid)) {
      try {
        await fetchStatus(now.url);
        out(`TSF running at ${now.url}`);
        return 0;
      } catch {
        // Not answering yet.
      }
    }
  }
  err("tsf: the factory did not come back within 90 s; see `just tsf logs`");
  return 1;
}

async function fetchStatus(url: string): Promise<unknown> {
  const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "-" : JSON.stringify(v);
}

function modelText(m: unknown): string {
  if (m && typeof m === "object") {
    // FactoryStatus.model is a ModelRef { provider, modelId } (shared/types.ts).
    const r = m as { provider?: unknown; modelId?: unknown };
    if (typeof r.provider === "string" && typeof r.modelId === "string") return `${r.provider}/${r.modelId}`;
  }
  return "none";
}

async function cmdStatus(args: readonly string[]): Promise<number> {
  const p = parseArgs(args, new Set());
  const json = p.flags.has("--json");
  const paths = projectPaths(resolveProjectRoot(process.cwd()));
  const state = readServerState(paths.serverState);
  const lockPid = readLockPid(paths.lockFile);

  if (!state || !isAlive(state.pid)) {
    if (!state && lockPid !== undefined && isAlive(lockPid)) {
      if (json) out(JSON.stringify({ running: false, starting: true, pid: lockPid }));
      else out(`starting (pid ${lockPid})`);
      return 0;
    }
    const unit = unitName(paths.projectRoot);
    const hint = !requireTsf(paths)
      ? ` (no tsf/ in ${paths.projectRoot}: run /tsf install)`
      : existsSync(unitPath(paths.projectRoot))
        ? ` (systemd unit ${unit} is installed: sudo systemctl start ${unit})`
        : "";
    if (json) out(JSON.stringify({ running: false }));
    else out(`not running${hint}`);
    return 3;
  }

  let status: unknown;
  try {
    status = await fetchStatus(state.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) out(JSON.stringify({ running: true, url: state.url, error: msg }));
    else out(`running (pid ${state.pid}) at ${state.url}, but GET /api/status failed: ${msg}`);
    return 1;
  }
  if (json) {
    out(JSON.stringify({ running: true, url: state.url, status }));
    return 0;
  }
  const s = (status ?? {}) as Record<string, unknown>;
  out(`${str(s.name ?? "TSF")} running at ${state.url}`);
  out(`pid     ${state.pid}`);
  out(`project ${str(s.projectRoot ?? paths.projectRoot)}`);
  out(`model   ${modelText(s.model)}`);
  out(`busy    ${s.busy === true ? "yes" : "no"}`);
  if (existsSync(unitPath(paths.projectRoot))) out(`systemd ${unitName(paths.projectRoot)} (installed)`);
  return 0;
}

async function cmdStop(args: readonly string[]): Promise<number> {
  const p = parseArgs(args, new Set());
  const force = p.flags.has("--force");
  const paths = projectPaths(resolveProjectRoot(process.cwd()));
  const state = readServerState(paths.serverState);
  const pid = state?.pid ?? readLockPid(paths.lockFile);

  if (pid === undefined || !isAlive(pid)) {
    rmSync(paths.serverState, { force: true });
    out("not running");
    return 0;
  }
  const unit = unitName(paths.projectRoot);
  if (!force && existsSync(unitPath(paths.projectRoot))) {
    out(`managed by systemd: sudo systemctl stop ${unit}`);
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    err(`tsf: could not signal process ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!existsSync(paths.lockFile) || !isAlive(pid)) {
      out("stopped");
      return 0;
    }
    await sleep(100);
  }
  err(`tsf: still running (process ${pid})`);
  return 1;
}

function readTail(file: string, lines: number): { text: string; size: number } {
  const size = statSync(file).size;
  const chunk = 64 * 1024;
  let start = size;
  let buf = "";
  const fd = openSync(file, "r");
  try {
    while (start > 0 && buf.split("\n").length <= lines + 1) {
      const len = Math.min(chunk, start);
      start -= len;
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, start);
      buf = b.toString("utf8") + buf;
    }
  } finally {
    closeSync(fd);
  }
  const all = buf.split("\n");
  if (all.at(-1) === "") all.pop();
  return { text: all.slice(-lines).join("\n"), size };
}

async function cmdLogs(args: readonly string[]): Promise<number> {
  const p = parseArgs(args, new Set(["-n"]));
  const follow = p.flags.has("-f");
  const n = intFlag(p, "-n", 0, 1_000_000) ?? 50;
  const paths = projectPaths(resolveProjectRoot(process.cwd()));
  const file = join(paths.logsDir, "tsf.log");
  if (!existsSync(file)) {
    err(`tsf: no log file at ${file}`);
    return 1;
  }
  const tail = readTail(file, n);
  if (tail.text !== "") out(tail.text);
  if (!follow) return 0;
  let pos = tail.size;
  for (;;) {
    await sleep(250);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < pos) pos = 0; // rotated
    if (size > pos) {
      const fd = openSync(file, "r");
      try {
        const b = Buffer.alloc(size - pos);
        readSync(fd, b, 0, b.length, pos);
        process.stdout.write(b);
      } finally {
        closeSync(fd);
      }
      pos = size;
    }
  }
}

/** Entry point for `bin/tsf.mjs`. Returns the process exit code (`start` does not return while the server runs). */
export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "start":
        return await cmdStart(rest);
      case "stop":
        return await cmdStop(rest);
      case "restart":
        return await cmdRestart(rest);
      case "status":
        return await cmdStatus(rest);
      case "logs":
        return await cmdLogs(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(USAGE.trimEnd());
        return cmd === undefined ? 2 : 0;
      default:
        err(`tsf: unknown command ${cmd}`);
        err(USAGE.trimEnd());
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`tsf: ${e.message}`);
      return 2;
    }
    err(`tsf: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

