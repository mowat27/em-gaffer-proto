/**
 * The machine feed: runs/index.jsonl, one append-only file per machine (per runs directory). It is the one source for
 * monitoring the builder (design section 7, D22): the server writes its own state, the runtime writes every run's
 * start and end, the engine every workflow step, and the operate and definitions tools what they change. Tool calls
 * stay in each run's journal, so the feed stays small.
 *
 * One JSON object per line: `{ ts, kind, runId?, jobId?, step?, data }`. Many processes append to it; each line is
 * one write in append mode, so lines never interleave. A line's seq is its line number (from 1), assigned by the
 * reader: the file is append-only, so a seq never changes and `--since <seq>` resumes exactly where a reader stopped.
 *
 * Read with `builder events [--since <seq|time>] [-f] [--json]`, or `GET /events` on a run that serves the API.
 * Writing never throws: observing never breaks a build (G7).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./journal-client.ts";

export const FEED_FILE = "index.jsonl";

/** What the feed carries (design section 7). control.* are the control inbox's messages (E14). */
export type FeedKind =
  | "server.start"
  | "server.state"
  | "server.stop"
  | "run.start"
  | "run.end"
  | "step.start"
  | "step.end"
  | "job.accepted"
  | "job.result"
  | "callback.ok"
  | "callback.gone"
  | "callback.abandoned"
  | "control.received"
  | "control.applied"
  | "notification"
  | "definition.changed"
  | "definition.invalid"
  | "config.loaded";

export const FEED_KINDS: readonly FeedKind[] = [
  "server.start",
  "server.state",
  "server.stop",
  "run.start",
  "run.end",
  "step.start",
  "step.end",
  "job.accepted",
  "job.result",
  "callback.ok",
  "callback.gone",
  "callback.abandoned",
  "control.received",
  "control.applied",
  "notification",
  "definition.changed",
  "definition.invalid",
  "config.loaded",
];

export interface FeedInput {
  kind: FeedKind;
  runId?: string;
  jobId?: string;
  step?: string;
  data?: Record<string, unknown>;
}

export interface FeedEvent {
  /** The line number, from 1 (assigned when read). */
  seq: number;
  ts: string;
  kind: string;
  runId?: string;
  jobId?: string;
  step?: string;
  data: Record<string, unknown>;
}

export const feedPath = (runsDir: string): string => join(runsDir, FEED_FILE);

/** Append one event to the machine feed of `runsDir`. Never throws. */
export function appendFeed(runsDir: string, e: FeedInput): void {
  try {
    const line = {
      ts: new Date().toISOString(),
      kind: e.kind,
      ...(e.runId ? { runId: e.runId } : {}),
      ...(e.jobId ? { jobId: e.jobId } : {}),
      ...(e.step ? { step: e.step } : {}),
      data: redact(e.data ?? {}),
    };
    mkdirSync(runsDir, { recursive: true });
    appendFileSync(feedPath(runsDir), JSON.stringify(line) + "\n");
  } catch {
    /* the feed only observes */
  }
}

/** Where to start reading: after a seq, or at a time (ms since the epoch). */
export type Since = { seq: number } | { time: number };

/**
 * `--since`: a seq (digits: events after it), a relative time (`30s`, `10m`, `2h`, `1d`: events since then) or an ISO
 * time (events at or after it). Throws on anything else.
 */
export function parseSince(s: string, now = Date.now()): Since {
  const t = s.trim();
  if (/^\d+$/.test(t)) return { seq: Number(t) };
  const rel = /^(\d+)\s*([smhd])$/.exec(t);
  if (rel) return { time: now - Number(rel[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"] };
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`--since ${s}: a seq (digits), a time (ISO 8601) or a duration such as 10m, 2h, 1d`);
  return { time: ms };
}

export interface FeedFilter {
  since?: Since;
  /** A kind, or a prefix ending in `*` (`server.*`). */
  kind?: string;
  runId?: string;
  jobId?: string;
  /** Only the last n matching events. */
  last?: number;
}

const matches = (e: FeedEvent, f: FeedFilter): boolean => {
  if (f.since && "seq" in f.since && e.seq <= f.since.seq) return false;
  if (f.since && "time" in f.since && !(Date.parse(e.ts) >= f.since.time)) return false;
  if (f.kind && !(f.kind.endsWith("*") ? e.kind.startsWith(f.kind.slice(0, -1)) : e.kind === f.kind)) return false;
  if (f.runId && e.runId !== f.runId) return false;
  if (f.jobId && e.jobId !== f.jobId) return false;
  return true;
};

/** Complete lines from `bytes`, numbered from `firstSeq`; a line not yet ended by a newline is left for later. */
function parseLines(text: string, firstSeq: number): { events: FeedEvent[]; consumed: number; lines: number } {
  const events: FeedEvent[] = [];
  let pos = 0;
  let seq = firstSeq;
  for (let nl = text.indexOf("\n", pos); nl >= 0; nl = text.indexOf("\n", pos)) {
    const line = text.slice(pos, nl);
    pos = nl + 1;
    seq++;
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Omit<FeedEvent, "seq">;
      if (typeof o.kind === "string" && typeof o.ts === "string") events.push({ seq, ...o, data: o.data && typeof o.data === "object" ? o.data : {} });
    } catch {
      /* a torn line: it keeps its number */
    }
  }
  return { events, consumed: Buffer.byteLength(text.slice(0, pos)), lines: seq - firstSeq };
}

/** Read from byte `offset` to the end. */
function readFrom(file: string, offset: number): string {
  if (!existsSync(file)) return "";
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return "";
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The feed's events, filtered, in order. A missing feed reads as no events. */
export function readFeed(runsDir: string, f: FeedFilter = {}): FeedEvent[] {
  const all = parseLines(readFrom(feedPath(runsDir), 0), 0).events.filter((e) => matches(e, f));
  return f.last !== undefined ? all.slice(Math.max(0, all.length - f.last)) : all;
}

/**
 * Replay the feed from `f.since` and then follow it: `onEvent` gets every matching event as it is appended, until the
 * signal aborts. Polls the file (every `everyMs`), reading only what was added.
 */
export async function followFeed(runsDir: string, f: FeedFilter, onEvent: (e: FeedEvent) => void, signal: AbortSignal, everyMs = 250): Promise<void> {
  const file = feedPath(runsDir);
  let offset = 0;
  let seq = 0;
  let replay = f.last !== undefined;
  while (!signal.aborted) {
    const text = readFrom(file, offset);
    if (text) {
      const got = parseLines(text, seq);
      offset += got.consumed;
      seq += got.lines;
      let events = got.events.filter((e) => matches(e, f));
      // `last` applies to the replay only.
      if (replay) events = events.slice(Math.max(0, events.length - (f.last ?? 0)));
      for (const e of events) onEvent(e);
    }
    replay = false;
    await new Promise<void>((r) => {
      const t = setTimeout(r, everyMs);
      signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
  }
}
