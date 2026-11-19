/**
 * Retention of run data under the runs directory, in two rules:
 *
 *   - Workspaces (runs/<id>/workspace, the clones) are kept for the newest `keepWorkspaces` jobs
 *     (runtime/workspace.ts pruneWorkspaces, after every job).
 *   - Everything else is kept for `retentionDays` (default 30), then deleted: a run tree (a root run and every run below
 *     it) whose runs all ended more than that long ago is deleted whole, with its run.json, journal, blobs, log,
 *     sessions, context, pinned definitions, summary and artifacts; so are a folder without a run record and a
 *     workspace snapshot (runs/.snapshots/*) last changed that long ago, and the lines of the machine feed
 *     (runs/index.jsonl) older than that.
 *
 * A tree with a live run is never touched, however old: the interactive ops run keeps its live session in its folder
 * and can run for longer than the retention period. Neither are its feed lines. A run is live while its state is not
 * final and its process is alive (runProcessAlive); a record a crash left "running" ages out like a finished run,
 * from its start.
 *
 * The feed is pruned in place: an expired line's bytes are overwritten with spaces, its newline kept. A line's seq is
 * its line number (runtime/feed.ts) and readers follow it by byte offset, so the file keeps its length and every line
 * its number, and the many processes appending to it never race a rewrite. What is kept: lines younger than the
 * cut-off, lines naming a run whose folder is still there, and the newest server.start (the screens read the server's
 * state from it).
 *
 * The build server prunes at start, after every job and every hour (server/http.ts, server/job.ts); `runs_prune`
 * (ops/core/operate.ts) does it on demand, or reports what it would do. Pruning never throws: a failure is reported.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { FEED_FILE } from "./feed.ts";
import { readRecord, runProcessAlive } from "./run.ts";
import { isFinal, type RunRecord } from "./types.ts";

export const DEFAULT_RETENTION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  /** Days run data is kept (default 30). */
  days?: number;
  /** Now, in ms (tests). */
  now?: number;
  /** Report only: delete nothing. */
  dryRun?: boolean;
}

export interface PruneReport {
  cutoff: string;
  dryRun: boolean;
  /** Run folders deleted (or that would be), by tree root. */
  trees: { root: string; runs: string[]; endedAt: string }[];
  /** Folders without a run record, and snapshots. */
  other: string[];
  /** Feed lines blanked. */
  feedLines: number;
  /** Trees left because a run in them is live. */
  live: string[];
  errors: string[];
}

/** When a run ended: endedAt, or for a final run without one its start (an old record). */
const endOf = (r: RunRecord): number => Date.parse(r.endedAt ?? r.startedAt);

/** The run records of a runs directory, by id. */
function records(runsDir: string): Map<string, RunRecord> {
  const recs = new Map<string, RunRecord>();
  for (const e of readdirSync(runsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const r = readRecord(runsDir, e.name);
    if (r) recs.set(r.id, r);
  }
  return recs;
}

/** Run trees by root id: a root run (no parent, or a parent that is gone) and every run below it. */
export function runTrees(recs: Map<string, RunRecord>): Map<string, RunRecord[]> {
  const rootOf = (r: RunRecord): string => {
    let cur = r;
    for (let depth = 0; depth < 32; depth++) {
      const up = cur.parent ? recs.get(cur.parent) : undefined;
      if (!up) return cur.id;
      cur = up;
    }
    return cur.id;
  };
  const trees = new Map<string, RunRecord[]>();
  for (const r of recs.values()) {
    const root = rootOf(r);
    trees.set(root, [...(trees.get(root) ?? []), r]);
  }
  return trees;
}

/** Delete run data older than the retention period. See the module comment for what is kept. */
export async function pruneExpired(runsDir: string, o: PruneOptions = {}): Promise<PruneReport> {
  const days = o.days ?? DEFAULT_RETENTION_DAYS;
  const now = o.now ?? Date.now();
  const cutoff = now - days * DAY;
  const report: PruneReport = { cutoff: new Date(cutoff).toISOString(), dryRun: !!o.dryRun, trees: [], other: [], feedLines: 0, live: [], errors: [] };
  if (!existsSync(runsDir) || !(days > 0)) return report;
  const remove = async (path: string) => {
    if (o.dryRun) return;
    try {
      await rm(path, { recursive: true, force: true });
    } catch (err) {
      report.errors.push(`could not delete ${path}: ${(err as Error).message}`);
    }
  };
  try {
    const recs = records(runsDir);
    // A run that is not final is live unless its process is gone (a crash or power loss left its record running) or it
    // never got one and started before the cut-off.
    const live = (r: RunRecord) => !isFinal(r.state) && (r.pid === null ? Date.parse(r.startedAt) >= cutoff : runProcessAlive(r));
    for (const [root, runs] of runTrees(recs)) {
      if (runs.some(live)) {
        if (runs.some((r) => endOf(r) < cutoff || Date.parse(r.startedAt) < cutoff)) report.live.push(root);
        continue;
      }
      const ended = Math.max(...runs.map(endOf));
      if (!(ended < cutoff)) continue;
      report.trees.push({ root, runs: runs.map((r) => r.id), endedAt: new Date(ended).toISOString() });
      // The children first, the root last: a reader that finds the root still finds a whole tree, or none of it.
      for (const r of [...runs].reverse()) await remove(join(runsDir, r.id));
    }
    // A folder with no run record (a run that never started, a copy left behind) and old snapshots.
    for (const e of readdirSync(runsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const path = join(runsDir, e.name);
      if (e.name === ".snapshots") {
        for (const s of readdirSync(path, { withFileTypes: true })) {
          const p = join(path, s.name);
          if (statSync(p).mtimeMs < cutoff) {
            report.other.push(`.snapshots/${s.name}`);
            await remove(p);
          }
        }
        continue;
      }
      if (e.name.startsWith(".") || recs.has(e.name) || existsSync(join(path, "run.json"))) continue;
      if (statSync(path).mtimeMs < cutoff) {
        report.other.push(e.name);
        await remove(path);
      }
    }
    const deleted = new Set(report.trees.flatMap((t) => t.runs));
    report.feedLines = pruneFeed(runsDir, cutoff, (id) => existsSync(join(runsDir, id)) && !deleted.has(id), !!o.dryRun);
  } catch (err) {
    report.errors.push(`could not prune ${runsDir}: ${(err as Error).message}`);
  }
  return report;
}

/**
 * Blank the feed lines older than `cutoff` in place (see the module comment), except those naming a run that `kept`
 * says is still there and the newest server.start. Returns how many lines were (or would be) blanked.
 */
export function pruneFeed(runsDir: string, cutoff: number, kept: (runId: string) => boolean, dryRun = false): number {
  const file = join(runsDir, FEED_FILE);
  if (!existsSync(file)) return 0;
  const buf = readFileSync(file);
  // Only whole lines: one being appended now is left for next time.
  const end = buf.lastIndexOf(0x0a) + 1;
  const lines: { start: number; end: number; ts: number; runId?: string; kind?: string }[] = [];
  for (let pos = 0; pos < end; ) {
    const nl = buf.indexOf(0x0a, pos);
    const text = buf.subarray(pos, nl).toString("utf8");
    let ts = NaN;
    let runId: string | undefined;
    let kind: string | undefined;
    if (text.trim()) {
      try {
        const o = JSON.parse(text) as { ts?: unknown; runId?: unknown; kind?: unknown };
        ts = typeof o.ts === "string" ? Date.parse(o.ts) : NaN;
        runId = typeof o.runId === "string" ? o.runId : undefined;
        kind = typeof o.kind === "string" ? o.kind : undefined;
      } catch {
        /* a torn line: it has no time, so it is kept */
      }
      lines.push({ start: pos, end: nl, ts, ...(runId ? { runId } : {}), ...(kind ? { kind } : {}) });
    }
    pos = nl + 1;
  }
  const lastServerStart = lines.findLast((l) => l.kind === "server.start");
  const expired = lines.filter((l) => {
    if (l === lastServerStart) return false;
    if (l.runId && kept(l.runId)) return false;
    return !Number.isNaN(l.ts) && l.ts < cutoff;
  });
  if (dryRun || expired.length === 0) return expired.length;
  const fd = openSync(file, "r+");
  try {
    for (const l of expired) writeSync(fd, Buffer.alloc(l.end - l.start, 0x20), 0, l.end - l.start, l.start);
  } finally {
    closeSync(fd);
  }
  return expired.length;
}
