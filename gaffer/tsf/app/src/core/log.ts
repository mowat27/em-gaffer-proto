import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 10 * 1024 * 1024;

function errorFields(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  return v;
}

function serialise(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Error) return errorFields(v);
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  });
}

function levelFromEnv(): LogLevel {
  const v = process.env.TSF_LOG_LEVEL;
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

/**
 * JSON-lines logger. `file` gets one JSON object per line (rotated once at 10 MB: `<file>.1`); `stderr` mirrors
 * each line to stderr. Writes are synchronous so a crash loses nothing; a failing write never throws.
 */
export function createLogger(opts: { file?: string; level?: LogLevel; stderr?: boolean }): Logger {
  const min = RANK[opts.level ?? levelFromEnv()];
  const { file, stderr } = opts;
  let size = 0;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      size = statSync(file).size;
    } catch {
      size = 0;
    }
  }

  function write(line: string): void {
    if (file) {
      try {
        if (size + line.length > MAX_BYTES) {
          rmSync(`${file}.1`, { force: true });
          renameSync(file, `${file}.1`);
          size = 0;
        }
        appendFileSync(file, line);
        size += line.length;
      } catch {
        // Logging must never take the process down.
      }
    }
    if (stderr) {
      try {
        process.stderr.write(line);
      } catch {
        // ignore
      }
    }
  }

  function make(base: Record<string, unknown>): Logger {
    const emit = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
      if (RANK[level] < min) return;
      write(`${serialise({ t: new Date().toISOString(), level, event, ...base, ...fields })}\n`);
    };
    return {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (fields) => make({ ...base, ...fields }),
    };
  }

  return make({});
}

const noop = (): void => undefined;
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLogger,
};
