/**
 * The journal's client side: how code inside a run's pi process (shared:journal, the gate host, shared:outcome) sends
 * an event to its run's journal writer (runtime/journal.ts).
 *
 * The runner sets two variables when the run has a journal:
 *   $BUILDER_JOURNAL_SOCK       the writer's Unix socket (absent when the writer could not listen)
 *   $BUILDER_JOURNAL_FALLBACK   a file events go to when the socket is unavailable or drops (E12); the writer merges it
 *                               at step end and at run end
 *
 * journalSend never throws and does nothing when neither is set, so a resource that journals works unchanged outside a
 * run (G7: observing never breaks anything). Every event is redacted before it leaves the process: values of
 * environment variables named *_KEY or *_TOKEN, and Authorization headers.
 *
 * Wire format: one JSON object per line, `{ kind, data, span?, parent?, step?, ts, cid }`. `cid` is unique per event
 * so the writer can drop a line it received twice (once on the socket, once from the fallback file). The writer adds
 * seq, runId and the agent.
 *
 * Delivery (E12, no event lost): the writer answers `{ "ack": [cid, ...] }` once a line is in journal.jsonl. A line
 * stays pending until it is acknowledged. When the socket drops (the writer half-closes it, it errors or it closes) and
 * when the process exits, every pending line goes to the fallback file; a line the writer did get is dropped again at
 * the merge by its cid. journalFlush waits for the acknowledgements (shared:journal calls it at session shutdown).
 *
 * pi may load this module once per extension that imports it: every copy shares one connection and one pending set
 * through a global, so a flush covers them all.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";

export interface JournalSendEvent {
  kind: string;
  data: Record<string, unknown>;
  span?: string;
  parent?: string;
  step?: string;
}

// ---- redaction ----

/** Environment variables whose values are secrets (design section 7). */
const SECRET_NAME = /_(KEY|TOKEN)$/i;
/** Shorter values are flags and counters, not secrets, and would redact ordinary text. */
const MIN_SECRET_LENGTH = 8;
const AUTH_KEY = /^(proxy-)?authorization$/i;
const AUTH_TEXT = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest)\s+)?([^\s"',;}]+)/gi;

export interface Secret {
  name: string;
  value: string;
}

/** The secret values in `env`, longest first so a value that contains another is replaced whole. */
export function secretsOf(env: NodeJS.ProcessEnv = process.env): Secret[] {
  const out: Secret[] = [];
  for (const [name, value] of Object.entries(env)) if (value && SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) out.push({ name, value });
  return out.sort((a, b) => b.value.length - a.value.length);
}

export function redactText(s: string, secrets: Secret[] = secretsOf()): string {
  let out = s;
  for (const { name, value } of secrets) if (out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
  return out.replace(AUTH_TEXT, (_m, key: string, sep: string, scheme: string | undefined) => `${key}${sep}${scheme ?? ""}[redacted]`);
}

/** A deep copy of `value` with secrets replaced in every string and every Authorization key's value hidden. */
export function redact<T>(value: T, secrets: Secret[] = secretsOf()): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactText(v, secrets);
    if (v === null || typeof v !== "object" || depth > 64) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = AUTH_KEY.test(k) && x !== null && x !== undefined ? "[redacted]" : walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

// ---- sending ----

interface ClientState {
  mode: "socket" | "fallback";
  sock: Socket | null;
  /** Lines sent on the socket and not yet acknowledged by the writer, by cid: they go to the fallback if it drops. */
  pending: Map<string, string>;
  /** Called whenever nothing is pending (journalFlush). */
  idle: (() => void)[];
  /** The writer's unfinished line. */
  buf: string;
  seq: number;
  instance: string;
  exitHook: boolean;
}

/** One state per process, shared by every copy of this module. */
const KEY = Symbol.for("gaffer.builder.journal-client");
const shared = globalThis as unknown as Record<symbol, ClientState | undefined>;
const state: ClientState = (shared[KEY] ??= { mode: "socket", sock: null, pending: new Map(), idle: [], buf: "", seq: 0, instance: randomBytes(4).toString("hex"), exitHook: false });

function toFallback(line: string): void {
  const file = process.env.BUILDER_JOURNAL_FALLBACK;
  if (!file) return;
  try {
    appendFileSync(file, line);
  } catch {
    /* nowhere left to write: the event is lost, the run is not */
  }
}

function settled(): void {
  if (state.pending.size) return;
  for (const done of state.idle.splice(0)) done();
}

/** Every line not acknowledged goes to the fallback file; so does everything sent from now on. */
function dropSocket(): void {
  const sock = state.sock;
  state.mode = "fallback";
  state.sock = null;
  const lines = [...state.pending.values()];
  state.pending.clear();
  for (const line of lines) toFallback(line);
  settled();
  try {
    // Half-close: the writer reads to here, then lets go.
    sock?.end();
  } catch {
    /* gone */
  }
}

/** The writer's acknowledgements: `{ "ack": [cid, ...] }` per line. */
function onAcks(chunk: string): void {
  state.buf += chunk;
  for (let nl = state.buf.indexOf("\n"); nl >= 0; nl = state.buf.indexOf("\n")) {
    const line = state.buf.slice(0, nl);
    state.buf = state.buf.slice(nl + 1);
    try {
      const ack = (JSON.parse(line) as { ack?: unknown }).ack;
      for (const cid of Array.isArray(ack) ? ack : [ack]) if (typeof cid === "string") state.pending.delete(cid);
    } catch {
      /* not an acknowledgement */
    }
  }
  settled();
}

function socket(path: string): Socket | null {
  if (state.sock) return state.sock;
  try {
    const sock = createConnection(path);
    sock.setEncoding("utf8");
    sock.on("data", onAcks);
    // The writer half-closed (it is dropping its clients), or the connection failed: fall back.
    sock.on("end", dropSocket);
    sock.on("error", dropSocket);
    sock.on("close", dropSocket);
    // The journal never keeps a process alive.
    sock.unref();
    state.sock = sock;
    state.buf = "";
    if (!state.exitHook) {
      state.exitHook = true;
      // pi may exit before the writer acknowledged its last lines: keep them (the merge drops what the writer has).
      process.on("exit", () => {
        for (const line of state.pending.values()) toFallback(line);
        state.pending.clear();
      });
    }
    return sock;
  } catch {
    return null;
  }
}

/** Resolves once the writer has acknowledged every line sent so far, or after `ms`. Never rejects. */
export function journalFlush(ms = 1000): Promise<void> {
  if (!state.pending.size) return Promise.resolve();
  return new Promise((resolveFlush) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      resolveFlush();
    }
    state.idle.push(done);
  });
}

/** Send one event to this run's journal. Never throws; does nothing outside a run with a journal. */
export function journalSend(e: JournalSendEvent): void {
  try {
    const sockPath = process.env.BUILDER_JOURNAL_SOCK;
    if (!sockPath && !process.env.BUILDER_JOURNAL_FALLBACK) return;
    const cid = `${process.pid}-${state.instance}-${++state.seq}`;
    const event = redact({ kind: e.kind, data: e.data ?? {}, ...(e.span ? { span: e.span } : {}), ...(e.parent ? { parent: e.parent } : {}), ...(e.step ? { step: e.step } : {}) });
    const line = JSON.stringify({ ...event, ts: new Date().toISOString(), cid }) + "\n";
    const sock = sockPath && state.mode === "socket" ? socket(sockPath) : null;
    if (!sock) return toFallback(line);
    // Pending until the writer acknowledges it.
    state.pending.set(cid, line);
    sock.write(line);
  } catch {
    /* observing never breaks the run */
  }
}
