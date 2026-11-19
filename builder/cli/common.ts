/**
 * What every CLI command shares: the global flags, the machine config and tool context they give, printing (human or
 * --json) and exit codes. A command module is `cli/commands/<name>.ts` exporting `default: Command`.
 *
 * Exit codes: 0 ok; 1 the tool or the run failed; 2 usage, an unknown tool or invalid arguments; 3 refused (outside the
 * machine limit, or not allowed); 4 not available yet (a stub).
 */
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { CONFIG_FILES_ENV, loadConfig, type MachineConfig } from "../ops/config.ts";
import { cliContext, runtimeFor } from "../ops/core/context.ts";
import { isToolError, type ToolContext } from "../ops/core/tool.ts";
import { expandHome } from "../runtime/paths.ts";

export interface Globals {
  /** --config <path>: a machine config layer on top of the others, for this command and every run it starts. */
  configPath?: string;
  /** --instance <id>: whose instances.<id> section applies. */
  instance?: string;
  /** --json: print JSON (one document, or one line per event for a stream). */
  json: boolean;
  /** -h, --help */
  help: boolean;
}

/** A command: its own arguments (globals removed) in, an exit code out. */
export type Command = (argv: string[], g: Globals) => Promise<number>;

export class UsageError extends Error {}

export function usage(message: string): never {
  throw new UsageError(message);
}

/** The global flags, wherever they stand, and the rest in order. */
export function splitGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  const g: Globals = { json: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const eq = /^--(config|instance)=(.*)$/.exec(a);
    if (eq) {
      if (eq[1] === "config") g.configPath = eq[2];
      else g.instance = eq[2];
    } else if (a === "--config" || a === "--instance") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) usage(`${a} needs a value`);
      if (a === "--config") g.configPath = v;
      else g.instance = v;
    } else if (a === "--json") g.json = true;
    else if (a === "-h" || a === "--help") g.help = true;
    else rest.push(a);
  }
  return { globals: g, rest };
}

/** parseArgs for a command's own options; a bad option is a usage error. */
export function parse<T extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    return usage((err as Error).message);
  }
}

let loaded: MachineConfig | null = null;

/**
 * The machine config for this command. --config and --instance travel to every run it starts (their environment), so
 * a run tree reads, protects and reloads the same layers. A broken layer is a usage-level error (E22).
 */
export function cliConfig(g: Globals): MachineConfig {
  if (loaded) return loaded;
  const configPath = g.configPath ? resolve(expandHome(g.configPath)) : undefined;
  if (configPath) process.env[CONFIG_FILES_ENV] = JSON.stringify([configPath]);
  if (g.instance) process.env.GAFFER_INSTANCE = g.instance;
  loaded = loadConfig({ ...(configPath ? { configPath } : {}), ...(g.instance ? { instance: g.instance } : {}) });
  return loaded;
}

/**
 * The CLI's tool context: what the machine limit allows. $BUILDER_AGENTICS_DIR names another agent tree than
 * builder/agentics, as it does for run processes (runtime/run.ts).
 */
export function cliTools(g: Globals): ToolContext {
  const config = cliConfig(g);
  const agenticsDir = process.env.BUILDER_AGENTICS_DIR;
  return cliContext(config, runtimeFor(config, agenticsDir ? { agenticsDir: resolve(expandHome(agenticsDir)) } : {}));
}

/** Print a command's result: JSON with --json, else the human form (or indented JSON when there is none). */
export function out(g: Globals, value: unknown, human?: (v: never) => string): void {
  if (g.json) console.log(JSON.stringify(value));
  else console.log(human ? human(value as never) : JSON.stringify(value, null, 2));
}

/** An error's exit code (see the file comment). */
export function exitCodeOf(err: unknown): number {
  if (err instanceof UsageError) return 2;
  if (isToolError(err)) return { unknown: 2, invalid: 2, refused: 3, unavailable: 4, failed: 1 }[err.code];
  return 1;
}

/** Report an error (with --json as `{ "error": { code, message } }` on stdout) and return its exit code. */
export function fail(g: Globals, err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof UsageError ? "usage" : isToolError(err) ? err.code : "error";
  if (g.json) console.log(JSON.stringify({ error: { code, message } }));
  else console.error(message);
  return exitCodeOf(err);
}

/** hh:mm:ss of an ISO time, for listings. */
export const clock = (ts: string): string => (ts.length >= 19 ? ts.slice(11, 19) : ts);

/** At most `n` characters on one line. */
export const oneLine = (s: string, n = 160): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A table: columns padded to their widest cell, the last one not. */
export function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i]))).join("  ")).join("\n");
}

/** Resolves on Ctrl+C or SIGTERM: a follow loop's signal. */
export function untilInterrupted(): AbortSignal {
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
  return ac.signal;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
