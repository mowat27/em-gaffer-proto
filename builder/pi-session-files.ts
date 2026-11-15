/** Pi session files on disk (Node): list them, read one, and find one by name. Used by the factory's HTTP route and the builder layer's tools. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { jobName } from "./job-name.ts";

export const MAX_SESSION_BYTES = 32 * 1024 * 1024;

export interface SessionInfo {
  /** `<directory>/<file>`, the handle `readSession` takes. */
  readonly id: string;
  /** ISO start time, from the file name (pi names a session file after the moment it started). */
  readonly started: string;
  readonly dir: string;
  /** The builder job the session ran for, when the directory names one. */
  readonly jobId: string | null;
  /** The job's friendly name (null for a session not run for a job). */
  readonly name: string | null;
  readonly size: number;
}

/** `2026-11-15T12-07-44-708Z_<id>.jsonl` -> `2026-11-15T12:07:44.708Z`; null when the name does not follow the pattern. */
function startedFromName(file: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(file);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/** Every session under `sessionsDir`, most recent first. */
export function listSessions(sessionsDir: string): SessionInfo[] {
  if (!existsSync(sessionsDir)) return [];
  const out: SessionInfo[] = [];
  for (const dir of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    // The directory is named after pi's working directory: .../builder/jobs/<jobId> or .../builder/jobs/<jobId>/<appDir>.
    const jobId = /-jobs-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-.*)?--$/.exec(dir.name)?.[1] ?? null;
    for (const file of readdirSync(join(sessionsDir, dir.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const stat = statSync(join(sessionsDir, dir.name, file.name));
      out.push({ id: `${dir.name}/${file.name}`, started: startedFromName(file.name) ?? stat.birthtime.toISOString(), dir: dir.name, jobId, name: jobId ? jobName(jobId) : null, size: stat.size });
    }
  }
  return out.sort((a, b) => b.started.localeCompare(a.started));
}

export type ReadResult = { ok: true; id: string; content: string; size: number } | { ok: false; code: "invalid" | "forbidden" | "not_found" | "too_large"; message: string };

export function readSession(sessionsDir: string, id: string | undefined): ReadResult {
  const parts = id?.split("/") ?? [];
  if (id === undefined || parts.length !== 2 || parts.some((part) => part === "" || part === "." || part === "..") || !parts[1].endsWith(".jsonl") || id.includes("\\")) {
    return { ok: false, code: "invalid", message: "id must be <directory>/<file>.jsonl" };
  }
  const root = resolve(sessionsDir);
  const target = resolve(root, parts[0], parts[1]);
  if (relative(root, target).startsWith("..")) return { ok: false, code: "forbidden", message: "path is outside the sessions directory" };
  if (!existsSync(target) || !statSync(target).isFile()) return { ok: false, code: "not_found", message: "session not found" };
  const size = statSync(target).size;
  if (size > MAX_SESSION_BYTES) return { ok: false, code: "too_large", message: `session is larger than ${MAX_SESSION_BYTES} bytes` };
  return { ok: true, id, content: readFileSync(target, "utf8"), size };
}

/** A session by reference: empty or "latest" (the most recent), a friendly name, a job id or its first characters, or the full id. */
export function findSession(sessions: SessionInfo[], ref: string | undefined): SessionInfo | undefined {
  const r = (ref ?? "").trim().toLowerCase();
  if (r === "" || r === "latest") return sessions[0];
  return sessions.find((s) => s.id.toLowerCase() === r || s.name === r || s.jobId?.toLowerCase() === r) ?? sessions.find((s) => s.jobId !== null && r.length >= 4 && s.jobId.toLowerCase().startsWith(r));
}
