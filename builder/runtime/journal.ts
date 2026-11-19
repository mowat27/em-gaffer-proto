/**
 * The journal: one append-only file per run, runs/<id>/journal.jsonl, one JSON event per line, numbered by one writer.
 *
 * Who has one: server job runs and workflow runs always, their child runs always, a run started directly only with
 * `journal: true` (runtime/run.ts pins the decision in run.json). Who writes:
 *   - the run's own process owns the writer: in-process callers (the runtime: run.start, agent.start, run.end; the
 *     engine: step.*, job.start, listener events) call append(); code inside pi (shared:journal, the gate host,
 *     shared:outcome) sends lines over runs/<id>/journal.sock (runtime/journal-client.ts);
 *   - when the socket is unavailable or drops, the client writes runs/<id>/journal.fallback.jsonl and the writer
 *     merges it at step end and run end (E12), dropping lines it already received;
 *   - after the run ended, the server appends job.result and callback.* directly with a new writer, which continues
 *     the run's seq.
 *
 * Payloads: any top-level data field over 8 KB moves to runs/<id>/blobs/<sha256> and is replaced in the event by
 * `{ blob: "sha256:<hex>", bytes, preview }` with a 2 KB preview (payloadOf reads it back). Once the journal passes its
 * size cap, fields over 512 bytes go to blobs with a 256-character preview (E17), so the journal stays small. Blobs
 * are kept with the rest of the run's folder for the retention period (runtime/retention.ts).
 *
 * Links: a child run's run.start carries its parent run id in `parent`, and the parent's step events carry
 * `childRunId`, so a reader can walk the tree from any run.
 *
 * close() writes runs/<id>/summary.json: event counts, the run's metrics (journalMetrics), step durations, the totals
 * of its whole tree when it has children, and what listeners contributed (summarize).
 *
 * The journal only observes: no method throws, and a write that fails loses an event, never the run (G7).
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact } from "./journal-client.ts";

export interface JournalEvent {
  /** Assigned by the writer, per run, from 1. */
  seq: number;
  /** ISO time the event happened (a client's own time for events sent from pi). */
  ts: string;
  runId: string;
  /** The workflow step, or the step an agent run serves. */
  step?: string;
  /** The agent id. */
  agent?: string;
  /** Tool call ("t-…"), turn ("u-…") or step ("s-…"). */
  span?: string;
  /** The parent span, or for run.start the parent run id. */
  parent?: string;
  kind: string;
  data: Record<string, unknown>;
}

export type JournalInput = Omit<JournalEvent, "seq" | "ts" | "runId">;

/** What in-process code needs of a journal: the engine and the runtime take this, so they work without one. */
export interface JournalSink {
  append(e: JournalInput): JournalEvent | null;
  /** Merge events the run's pi process wrote to the fallback file (E12). */
  mergeFallback?(): void;
  /** Add a value to the run's summary.json. */
  summarize?(key: string, value: unknown): void;
}

export const JOURNAL_FILE = "journal.jsonl";
export const FALLBACK_FILE = "journal.fallback.jsonl";
export const SUMMARY_FILE = "summary.json";
export const BLOBS_DIR = "blobs";
export const JOURNAL_SOCKET = "journal.sock";

/** A field over this many bytes moves to a blob. */
export const BLOB_THRESHOLD = 8 * 1024;
export const PREVIEW_CHARS = 2048;
/** The journal's size cap per run (E17): past it, payloads are clipped harder. */
export const DEFAULT_CAP_BYTES = 16 * 1024 * 1024;
const CAPPED_THRESHOLD = 512;
const CAPPED_PREVIEW = 256;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Where a run's Unix socket listens: runs/<id>/<name>, or a short path in the temp dir (linked from there) when that is too long for a Unix socket. */
export function socketPaths(runDir: string, name: string): { listen: string; link?: string } {
  const direct = join(runDir, name);
  if (Buffer.byteLength(direct) <= 100) return { listen: direct };
  const stem = name.replace(/\.sock$/, "");
  return { listen: join(tmpdir(), `builder-${stem}-${createHash("sha1").update(runDir).digest("hex").slice(0, 12)}.sock`), link: direct };
}

/** The last seq in a journal file and its size, reading only its tail. */
function tailOf(file: string): { seq: number; bytes: number } {
  if (!existsSync(file)) return { seq: 0, bytes: 0 };
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    let chunk = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
      // The first line of a partial read may be cut; any later complete line is whole.
      for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
        try {
          const seq = (JSON.parse(lines[i]) as { seq?: unknown }).seq;
          if (typeof seq === "number") return { seq, bytes: size };
        } catch {
          /* a torn line: look further back */
        }
      }
      if (start === 0) return { seq: 0, bytes: size };
      chunk *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

export interface WriterOptions {
  /** The size cap (E17). Default 16 MB. */
  capBytes?: number;
}

export class JournalWriter implements JournalSink {
  readonly runDir: string;
  readonly runId: string;
  readonly file: string;
  readonly fallbackFile: string;
  /** Where clients connect, once listen() succeeded. */
  socketPath: string | null = null;
  /** Called with every event this writer appends (the engine's listener host). Its errors are ignored. */
  onEvent: ((e: JournalEvent) => void) | null = null;
  private readonly ids: { agent?: string; step?: string };
  private readonly capBytes: number;
  private seq: number;
  private bytes: number;
  private clipped = false;
  private readonly seen = new Set<string>();
  private server: Server | null = null;
  private socketLink: string | undefined;
  private readonly clients = new Set<Socket>();
  /** drain() callers, woken when the last client is gone. */
  private readonly drained: (() => void)[] = [];
  private readonly extra: Record<string, unknown> = {};
  private closed = false;

  constructor(runDir: string, ids: { runId: string; agent?: string; step?: string }, o: WriterOptions = {}) {
    this.runDir = runDir;
    this.runId = ids.runId;
    this.ids = { ...(ids.agent ? { agent: ids.agent } : {}), ...(ids.step ? { step: ids.step } : {}) };
    this.file = join(runDir, JOURNAL_FILE);
    this.fallbackFile = join(runDir, FALLBACK_FILE);
    this.capBytes = o.capBytes ?? DEFAULT_CAP_BYTES;
    let tail = { seq: 0, bytes: 0 };
    try {
      mkdirSync(runDir, { recursive: true });
      tail = tailOf(this.file);
    } catch {
      /* a fresh journal */
    }
    this.seq = tail.seq;
    this.bytes = tail.bytes;
    this.clipped = tail.bytes > this.capBytes;
  }

  /** Append one event (in-process callers). Returns it as written, or null when it could not be written. */
  append(e: JournalInput): JournalEvent | null {
    return this.write(e);
  }

  private write(e: JournalInput, ts?: string): JournalEvent | null {
    try {
      const capped = this.bytes > this.capBytes;
      if (capped) this.clipped = true;
      const event: JournalEvent = {
        seq: this.seq + 1,
        ts: ts && !Number.isNaN(Date.parse(ts)) ? ts : new Date().toISOString(),
        runId: this.runId,
        ...(e.step ?? this.ids.step ? { step: e.step ?? this.ids.step } : {}),
        ...(e.agent ?? this.ids.agent ? { agent: e.agent ?? this.ids.agent } : {}),
        ...(e.span ? { span: e.span } : {}),
        ...(e.parent ? { parent: e.parent } : {}),
        kind: e.kind,
        data: this.payloads(redact(e.data ?? {}), capped),
      };
      const line = JSON.stringify(event) + "\n";
      appendFileSync(this.file, line);
      this.seq = event.seq;
      this.bytes += Buffer.byteLength(line);
      try {
        this.onEvent?.(event);
      } catch {
        /* a listener host's problem, not the journal's */
      }
      return event;
    } catch {
      return null;
    }
  }

  /** Move large top-level fields to blobs. */
  private payloads(data: Record<string, unknown>, capped: boolean): Record<string, unknown> {
    const limit = capped ? CAPPED_THRESHOLD : BLOB_THRESHOLD;
    const preview = capped ? CAPPED_PREVIEW : PREVIEW_CHARS;
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(data)) {
      if (v === null || typeof v === "number" || typeof v === "boolean") continue;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      if (text === undefined || Buffer.byteLength(text) <= limit) continue;
      const hex = sha256(text);
      const dir = join(this.runDir, BLOBS_DIR);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, hex);
      if (!existsSync(path)) writeFileSync(path, text);
      out ??= { ...data };
      out[k] = { blob: `sha256:${hex}`, bytes: Buffer.byteLength(text), preview: text.length > preview ? `${text.slice(0, preview)}…` : text };
    }
    return out ?? data;
  }

  /**
   * Received from a client (socket or fallback file): one parsed line. `new` once it is in the journal, `seen` when a
   * line with its cid already is (dropped), `bad` when it is not an event or could not be written.
   */
  private receive(raw: unknown): "new" | "seen" | "bad" {
    if (!raw || typeof raw !== "object") return "bad";
    const m = raw as Record<string, unknown>;
    if (typeof m.kind !== "string" || !m.kind) return "bad";
    const cid = typeof m.cid === "string" ? m.cid : null;
    if (cid && this.seen.has(cid)) return "seen";
    const data = m.data && typeof m.data === "object" && !Array.isArray(m.data) ? (m.data as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const span = str(m.span);
    const parent = str(m.parent);
    const step = str(m.step);
    // Only a line that is in the journal counts as had: one that failed to write is kept by the client.
    if (!this.write({ kind: m.kind, data, ...(span ? { span } : {}), ...(parent ? { parent } : {}), ...(step ? { step } : {}) }, str(m.ts))) return "bad";
    if (cid) this.seen.add(cid);
    return "new";
  }

  /** Listen on the run's journal socket. Resolves with the path clients connect to, or null when it cannot listen. */
  listen(): Promise<string | null> {
    if (this.server || this.closed) return Promise.resolve(this.socketPath);
    const paths = socketPaths(this.runDir, JOURNAL_SOCKET);
    return new Promise((resolveListen) => {
      try {
        rmSync(paths.listen, { force: true });
        // A client may half-close and still read our acknowledgements; we half-close it when dropping it.
        const server = createServer({ allowHalfOpen: true }, (sock) => {
          this.clients.add(sock);
          let buf = "";
          sock.on("data", (d: Buffer) => {
            buf += d.toString("utf8");
            const acks: string[] = [];
            for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line.trim()) continue;
              try {
                const m = JSON.parse(line) as { cid?: unknown };
                if (this.receive(m) !== "bad" && typeof m.cid === "string") acks.push(m.cid);
              } catch {
                /* not a journal line */
              }
            }
            // Acknowledge what is in the journal: the client keeps everything else for the fallback file (E12).
            if (acks.length && sock.writable) sock.write(JSON.stringify({ ack: acks }) + "\n");
          });
          // The client is done sending: finish our side too.
          sock.on("end", () => sock.end());
          const gone = () => {
            this.clients.delete(sock);
            if (this.clients.size === 0) for (const done of this.drained.splice(0)) done();
          };
          sock.on("close", gone);
          sock.on("error", gone);
        });
        server.on("error", () => resolveListen(null));
        server.listen(paths.listen, () => {
          this.server = server;
          this.socketPath = paths.listen;
          if (paths.link) {
            this.socketLink = paths.link;
            try {
              rmSync(paths.link, { force: true });
              symlinkSync(paths.listen, paths.link);
            } catch {
              /* clients get the real path from the runner */
            }
          }
          // The journal never keeps a process alive.
          server.unref();
          resolveListen(paths.listen);
        });
      } catch {
        resolveListen(null);
      }
    });
  }

  /**
   * Drop every client and stop listening: clients switch to the fallback file, which is merged at step end and run
   * end (E12). The run process does this on SIGUSR2, so an operator (or a test) can exercise the fallback path.
   *
   * Gracefully: each connection is half-closed and still read until the client half-closes it too (it puts what was
   * not acknowledged in the fallback file first), or destroyed after `graceMs`.
   */
  dropClients(graceMs = 2000): void {
    for (const c of this.clients) {
      if (graceMs <= 0) {
        c.destroy();
        continue;
      }
      try {
        c.end();
      } catch {
        /* gone */
      }
      setTimeout(() => c.destroy(), graceMs).unref();
    }
    this.stopListening();
  }

  private stopListening(): void {
    try {
      this.server?.close();
    } catch {
      /* closed */
    }
    this.server = null;
    for (const p of [this.socketPath, this.socketLink]) {
      if (!p) continue;
      try {
        rmSync(p, { force: true });
      } catch {
        /* gone */
      }
    }
  }

  /**
   * Resolves once no client is connected (each has sent everything and hung up), or after `ms`. It is woken by the
   * last client's close, and its timer keeps the process alive meanwhile: a run process awaits it at top level, and an
   * empty event loop there would end the process with the await unsettled (exit code 13).
   */
  drain(ms = 2000): Promise<void> {
    if (this.clients.size === 0) return Promise.resolve();
    return new Promise((resolveDrain) => {
      const done = () => {
        clearTimeout(timer);
        resolveDrain();
      };
      const timer = setTimeout(done, ms);
      this.drained.push(done);
    });
  }

  /** Merge runs/<id>/journal.fallback.jsonl into the journal (E12), dropping lines already received on the socket. */
  mergeFallback(): void {
    try {
      if (!existsSync(this.fallbackFile) || statSync(this.fallbackFile).size === 0) return;
      // A client still writing appends to a new file, merged next time.
      const merging = `${this.fallbackFile}.${process.pid}.merging`;
      renameSync(this.fallbackFile, merging);
      let merged = 0;
      let skipped = 0;
      for (const line of readFileSync(merging, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          if (this.receive(JSON.parse(line)) === "new") merged++;
          else skipped++;
        } catch {
          skipped++;
        }
      }
      rmSync(merging, { force: true });
      this.write({ kind: "journal.merged", data: { from: FALLBACK_FILE, events: merged, skipped } });
    } catch {
      /* tried again at the next merge */
    }
  }

  /** Add `value` under `key` in the run's summary.json (listeners contribute their totals this way). */
  summarize(key: string, value: unknown): void {
    this.extra[key] = value;
  }

  /** Stop the socket, merge the fallback file and write summary.json. The writer can still append afterwards. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    for (const done of this.drained.splice(0)) done();
    this.stopListening();
    this.mergeFallback();
    try {
      writeSummary(this.runDir, { clipped: this.clipped, ...(Object.keys(this.extra).length ? { listeners: this.extra } : {}) });
    } catch {
      /* the journal is still there */
    }
  }
}

// ---- reading ----

export interface JournalFilter {
  /** A kind, or a prefix ending in `*` ("tool.*"). */
  kind?: string;
  step?: string;
  /** data.tool */
  tool?: string;
  /** Case-insensitive, anywhere in the event. */
  text?: string;
  /** Only events with a larger seq. */
  after?: number;
  limit?: number;
}

/** A run's journal events in seq order, filtered. A missing journal reads as no events. */
export function readJournal(runDir: string, filter: JournalFilter = {}): JournalEvent[] {
  const file = join(runDir, JOURNAL_FILE);
  if (!existsSync(file)) return [];
  const needle = filter.text?.toLowerCase();
  const kind = filter.kind;
  const kindMatch = (k: string) => !kind || (kind.endsWith("*") ? k.startsWith(kind.slice(0, -1)) : k === kind);
  const out: JournalEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    if (needle && !line.toLowerCase().includes(needle)) continue;
    let e: JournalEvent;
    try {
      e = JSON.parse(line) as JournalEvent;
    } catch {
      continue;
    }
    if (!kindMatch(e.kind)) continue;
    if (filter.step && e.step !== filter.step) continue;
    if (filter.tool && e.data?.tool !== filter.tool) continue;
    if (filter.after !== undefined && e.seq <= filter.after) continue;
    out.push(e);
  }
  out.sort((a, b) => a.seq - b.seq);
  return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
}

/** A field as written: the value itself, or for a blob marker the full text from blobs/ (its preview when the blob is gone). */
export function payloadOf(runDir: string, value: unknown): unknown {
  const m = value as { blob?: unknown; preview?: unknown } | null;
  if (!m || typeof m !== "object" || typeof m.blob !== "string" || !m.blob.startsWith("sha256:")) return value;
  const path = join(runDir, BLOBS_DIR, m.blob.slice("sha256:".length));
  return existsSync(path) ? readFileSync(path, "utf8") : m.preview;
}

export interface JournalMetrics {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokens: { input: number; output: number; cacheRead: number };
  cost: number;
  model?: string;
  durationMs: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function metricsOf(events: JournalEvent[]): JournalMetrics {
  const m: JournalMetrics = { turns: 0, toolCalls: 0, toolErrors: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, cost: 0, durationMs: 0 };
  let start: number | null = null;
  let end: number | null = null;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (e.kind === "turn.end") m.turns++;
    else if (e.kind === "tool.end") {
      m.toolCalls++;
      if (e.data.isError === true) m.toolErrors++;
    } else if (e.kind === "model.usage") {
      m.tokens.input += num(e.data.input);
      m.tokens.output += num(e.data.output);
      m.tokens.cacheRead += num(e.data.cacheRead);
      m.cost += num(e.data.cost);
      if (typeof e.data.model === "string") m.model = e.data.model;
    } else if (e.kind === "agent.start" && typeof e.data.model === "string" && !m.model) m.model = e.data.model;
    else if (e.kind === "run.start" && !Number.isNaN(t)) start = t;
    else if (e.kind === "run.end" && !Number.isNaN(t)) end = t;
  }
  const stamps = events.map((e) => Date.parse(e.ts)).filter((t) => !Number.isNaN(t));
  const from = start ?? (stamps.length ? Math.min(...stamps) : 0);
  const to = end ?? (stamps.length ? Math.max(...stamps) : 0);
  m.durationMs = Math.max(0, to - from);
  return m;
}

/** A run's own metrics from its journal: turns, tool calls, tokens, cost, the model and how long the run took. */
export function journalMetrics(runDir: string): JournalMetrics {
  return metricsOf(readJournal(runDir));
}

/** The runs a run's journal links to as children (childRunId in its step events), in order. */
export function childRuns(runDir: string): string[] {
  const out: string[] = [];
  for (const e of readJournal(runDir, { kind: "step.*" })) {
    const id = e.data.childRunId;
    if (typeof id === "string" && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Metrics over a run and every run below it (siblings in the same runs directory), durations summed per run. */
export function treeMetrics(runDir: string, depth = 0): JournalMetrics & { runs: number } {
  const own = journalMetrics(runDir);
  const total = { ...own, tokens: { ...own.tokens }, runs: 1 };
  if (depth > 8) return total;
  for (const id of childRuns(runDir)) {
    const c = treeMetrics(join(dirname(runDir), id), depth + 1);
    total.turns += c.turns;
    total.toolCalls += c.toolCalls;
    total.toolErrors += c.toolErrors;
    total.tokens.input += c.tokens.input;
    total.tokens.output += c.tokens.output;
    total.tokens.cacheRead += c.tokens.cacheRead;
    total.cost += c.cost;
    total.model ??= c.model;
    total.runs += c.runs;
  }
  return total;
}

/** Each finished step's duration, in the order the steps ended: from the step.end events. */
export function stepDurations(runDir: string): { step: string; status: string; ms: number; childRunId?: string }[] {
  return readJournal(runDir, { kind: "step.end" })
    .filter((e) => typeof e.step === "string")
    .map((e) => ({ step: e.step!, status: String(e.data.status ?? ""), ms: num(e.data.ms), ...(typeof e.data.childRunId === "string" ? { childRunId: e.data.childRunId } : {}) }));
}

function writeSummary(runDir: string, extra: Record<string, unknown>): void {
  const events = readJournal(runDir);
  const kinds: Record<string, number> = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const children = childRuns(runDir);
  const summary = {
    runId: basename(runDir),
    events: events.length,
    lastSeq: events.length ? events[events.length - 1].seq : 0,
    kinds,
    metrics: metricsOf(events),
    steps: stepDurations(runDir),
    ...(children.length ? { children, tree: treeMetrics(runDir) } : {}),
    ...extra,
  };
  const file = join(runDir, SUMMARY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(summary, null, 2) + "\n");
  renameSync(tmp, file);
}
