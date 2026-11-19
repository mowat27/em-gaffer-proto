/**
 * Writing definitions, their history and change sets (design section 9, D10, E15). Plain files (G8):
 *
 *   agentics/history/<kind>/<id>/<stamp>-<version12>/       the previous version's files, exactly as they were
 *   agentics/history/<kind>/<id>/<stamp>-<version12>.json  { kind, id, version, savedAt, by, change, next, reason }
 *   agentics/changesets/<changeset>/changeset.json         a proposed change (definitions: { changes: propose })
 *
 * A change is written file by file (each one atomically), only the files that differ, and only definition files: what
 * is not part of a definition (an agent's data/, state/, nested agents) is never touched. A change takes a lock per
 * definition (a directory in the temp dir, keyed by the tree), so the expectedVersion check and the write are one step
 * for every process on the machine.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { newRunId } from "../../runtime/run.ts";
import { readFileSet, versionOf, type Def, type FileSet, type Kind } from "./kinds.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let tmpSeq = 0;
function writeAtomicBuffer(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Remove `dir` and the empty folders above it, up to (not including) `stop`. */
function pruneEmpty(dir: string, stop: string): void {
  for (let d = dir; d.startsWith(stop) && d !== stop; d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/**
 * Make the definition hold exactly `next` (null: remove its files). Files that are the same are not rewritten; files of
 * the definition that `next` leaves out are removed, with the folders that end up empty. Everything else in the
 * definition's directory stays.
 */
export function writeFileSet(def: Def, next: FileSet | null, current: FileSet | null = readFileSet(def)): void {
  if (def.single) {
    if (!next) {
      rmSync(def.path, { force: true });
      return;
    }
    const [content] = [...next.values()];
    writeAtomicBuffer(def.path, content ?? Buffer.alloc(0));
    return;
  }
  const at = (rel: string) => join(def.path, ...rel.split("/"));
  for (const [rel, content] of next ?? []) {
    const old = current?.get(rel);
    if (old && old.equals(content)) continue;
    writeAtomicBuffer(at(rel), content);
  }
  for (const rel of current?.keys() ?? []) {
    if (next?.has(rel)) continue;
    rmSync(at(rel), { force: true });
    pruneEmpty(dirname(at(rel)), def.path);
  }
  if (!next) pruneEmpty(def.path, dirname(def.path));
}

/** Copy a file set into a fresh directory (its files at their relative paths). */
export function materialise(files: FileSet, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of files) writeAtomicBuffer(join(dir, ...rel.split("/")), content);
}

/** Read every file under `dir` as a file set (for history entries and change sets). */
export function readDirSet(dir: string): FileSet {
  const set: FileSet = new Map();
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (e.isFile()) set.set(rel, readFileSync(join(d, e.name)));
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return set;
}

// ---- locks ----

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 120_000;

/** Run `fn` holding the definition's lock (a directory: mkdir is atomic). A lock older than 2 minutes is stale. */
export async function withLock<T>(def: Def, fn: () => Promise<T>): Promise<T> {
  const tree = createHash("sha256").update(def.agentics).digest("hex").slice(0, 12);
  const root = join(tmpdir(), `builder-definitions-${tree}`);
  mkdirSync(root, { recursive: true });
  const lock = join(root, `${def.kind}--${def.id.replace(/\//g, "--")}.lock`);
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > until) throw new Error(`${def.kind} ${def.id} is being changed by another caller: try again`);
      await sleep(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ---- history ----

export interface Caller {
  kind: "agent" | "cli" | "api";
  runId?: string;
  agent?: string;
}

export interface HistoryMeta {
  kind: Kind;
  id: string;
  /** The version kept here (the one the change replaced). */
  version: string;
  savedAt: string;
  by: Caller;
  /** The change that replaced it: the tool, and the version it wrote (null: the definition was deleted). */
  change: { tool: string; op: string; next: string | null; changeset?: string };
  reason?: string;
}

export interface HistoryEntry extends HistoryMeta {
  /** The folder holding the files. */
  path: string;
}

export const historyDir = (agentics: string, kind: Kind, id: string): string => join(agentics, "history", kind, ...id.split("/"));

/** Keep `files` (the definition's version `version`) in its history. Returns the entry's folder. */
export function saveHistory(def: Def, files: FileSet, meta: Omit<HistoryMeta, "kind" | "id" | "version" | "savedAt">): string {
  const version = versionOf(files, def.single);
  const root = historyDir(def.agentics, def.kind, def.id);
  const savedAt = new Date().toISOString();
  const stamp = savedAt.replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "") + `-${savedAt.slice(20, 23)}`;
  let name = `${stamp}-${version.slice(0, 12)}`;
  for (let n = 2; existsSync(join(root, name)); n++) name = `${stamp}-${version.slice(0, 12)}-${n}`;
  const dir = join(root, name);
  materialise(files, dir);
  const full: HistoryMeta = { kind: def.kind, id: def.id, version, savedAt, ...meta };
  writeFileSync(`${dir}.json`, JSON.stringify(full, null, 2) + "\n");
  return dir;
}

/** A definition's history, newest first. */
export function listHistory(agentics: string, kind: Kind, id: string): HistoryEntry[] {
  const root = historyDir(agentics, kind, id);
  if (!existsSync(root)) return [];
  const out: HistoryEntry[] = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith(".json")) continue;
    const path = join(root, f.slice(0, -5));
    try {
      const meta = JSON.parse(readFileSync(join(root, f), "utf8")) as HistoryMeta;
      if (existsSync(path) && typeof meta.version === "string") out.push({ ...meta, path });
    } catch {
      /* a broken entry is skipped */
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : b.path.localeCompare(a.path)));
}

/** A history entry by version (the full version, or a prefix of at least 6 characters that names one). */
export function findHistory(agentics: string, kind: Kind, id: string, version: string): HistoryEntry {
  const all = listHistory(agentics, kind, id);
  const exact = all.find((e) => e.version === version);
  if (exact) return exact;
  const prefix = version.length >= 6 ? all.filter((e) => e.version.startsWith(version)) : [];
  const versions = [...new Set(prefix.map((e) => e.version))];
  if (versions.length === 1) return prefix[0];
  if (versions.length > 1) throw new Error(`version ${version} is ambiguous in the history of ${kind} ${id}`);
  throw new Error(`no version ${version} in the history of ${kind} ${id} (history_list shows them)`);
}

/** The files of a history entry, keyed as the definition holds them. */
export function historyFiles(entry: HistoryEntry): FileSet {
  return readDirSet(entry.path);
}

// ---- diffs ----

/** A unified diff between two file sets (git diff --no-index), or a list of changed files when git is missing. */
export function diffSets(a: FileSet | null, b: FileSet | null, labels: { a: string; b: string }): string {
  const tmp = mkdtempSync(join(tmpdir(), "builder-diff-"));
  try {
    const da = join(tmp, "a");
    const db = join(tmp, "b");
    materialise(a ?? new Map(), da);
    materialise(b ?? new Map(), db);
    // The folders are named a and b: with --no-prefix the paths read a/<file> and b/<file>.
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-prefix", "--", "a", "b"], { cwd: tmp, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      const names = new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])]);
      return [...names]
        .sort()
        .filter((n) => !(a?.get(n) && b?.get(n) && a.get(n)!.equals(b.get(n)!)))
        .map((n) => `${a?.has(n) ? (b?.has(n) ? "changed" : "removed") : "added"} ${n}`)
        .join("\n");
    }
    return r.stdout ? `# a: ${labels.a}\n# b: ${labels.b}\n${r.stdout}` : "";
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- change sets ----

export interface ChangeSet {
  id: string;
  state: "proposed" | "applied";
  createdAt: string;
  by: Caller;
  /** The change tool and its arguments: applying it calls the tool again with them. */
  tool: string;
  args: Record<string, unknown>;
  kind: Kind;
  defId: string;
  /** The version the change was made against (null: the definition did not exist). */
  baseVersion: string | null;
  /** The version it would write (null: a delete). */
  version: string | null;
  reason?: string;
  diff: string;
  affects: { agents: string[]; builders: string[] };
  appliedAt?: string;
  appliedBy?: Caller;
}

export const changesetsDir = (agentics: string): string => join(agentics, "changesets");

export function saveChangeSet(agentics: string, cs: Omit<ChangeSet, "id" | "state" | "createdAt">): ChangeSet {
  const id = `${newRunId()}`;
  const full: ChangeSet = { id, state: "proposed", createdAt: new Date().toISOString(), ...cs };
  const dir = join(changesetsDir(agentics), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "changeset.json"), JSON.stringify(full, null, 2) + "\n");
  writeFileSync(join(dir, "change.diff"), cs.diff);
  return full;
}

export function readChangeSet(agentics: string, id: string): ChangeSet {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`"${id}" is not a change set id`);
  const file = join(changesetsDir(agentics), id, "changeset.json");
  if (!existsSync(file)) throw new Error(`no change set ${id} in ${changesetsDir(agentics)}`);
  return JSON.parse(readFileSync(file, "utf8")) as ChangeSet;
}

export function updateChangeSet(agentics: string, cs: ChangeSet): void {
  writeAtomicBuffer(join(changesetsDir(agentics), cs.id, "changeset.json"), Buffer.from(JSON.stringify(cs, null, 2) + "\n"));
}

export function listChangeSets(agentics: string): ChangeSet[] {
  const root = changesetsDir(agentics);
  if (!existsSync(root)) return [];
  const out: ChangeSet[] = [];
  for (const name of readdirSync(root).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(root, name, "changeset.json"), "utf8")) as ChangeSet);
    } catch {
      /* not a change set */
    }
  }
  return out.reverse();
}

/** A short random id part (tests and temp names). */
export const randomId = (): string => randomBytes(4).toString("hex");

/** The basename a single-file definition's one entry has. */
export const singleName = (def: Def): string => basename(def.path);
