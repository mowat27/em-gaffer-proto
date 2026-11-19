/**
 * Messaging between runs (design section 9, D20; it replaces the dev bus): a user message to a live run, over that
 * run's control socket (runtime/pi.ts relays it). One rule and one wire for every sender: run_send (ops/core/
 * messaging.ts, any adapter), POST /messages (runtime/api.ts), `builder attach` (through run_send) and the run's own
 * triggers (runtime/triggers.ts, in-process).
 *
 * Who takes messages (messageRefusal): a live agent run in rpc or durable mode, never a run inside a server job. Both
 * modes have a control socket and pi reads rpc commands there; a headless or interactive pi reads none. A run is named
 * by its id or by the `name` in its spec (at most one live run has a given name, runtime/run.ts).
 *
 * The wire: a sender writes one line on the target's control socket
 *
 *   { "type": "builder_message", "id": "<id>", "message": "<text>", "via": "run_send" | "api" | ..., "from": {...} }
 *
 * and the target's own process (MessageDesk, in the relay) hands pi
 *
 *   { "id": "<id>", "type": "prompt", "message": "<text>", "streamingBehavior": "followUp" }
 *
 * which starts a turn when pi is idle and is queued as a follow-up while a turn runs (pi's own queue: a message never
 * interrupts a turn). pi's answer `{ id, type: "response", success, data: { disposition } }` reaches every client of
 * the socket, the sender included. When it comes the desk journals `message.received` in the target's journal: id, via,
 * from, the message, accepted and disposition (started or queued). A line any other client writes goes to pi as it is.
 *
 * The sender journals `message.sent` in its own journal (ops/core/messaging.ts).
 */
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { JournalSink } from "./journal.ts";
import { isFinal, type RunRecord } from "./types.ts";

export const MESSAGE_TYPE = "builder_message";

/** Who sent a message: the caller of run_send, the API, a trigger. */
export interface MessageFrom {
  kind?: string;
  runId?: string;
  agent?: string;
}

export interface MessageMeta {
  /** Unique per message: pi's response carries it. Default: one is made. */
  id?: string;
  /** How it came: run_send, api, trigger, ... */
  via: string;
  from?: MessageFrom;
}

/** What became of a message: pi accepted it (started or queued), refused it, or did not answer (null). */
export interface Delivery {
  id: string;
  accepted: boolean | null;
  disposition?: string;
  error?: string;
}

export const newMessageId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** The job a run belongs to: its own, or the nearest ancestor's. */
function jobAbove(rec: RunRecord, get: (id: string) => RunRecord | null): RunRecord["job"] | null {
  let cur: RunRecord | null = rec;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.job) return cur.job;
    cur = cur.parent ? get(cur.parent) : null;
  }
  return null;
}

/** Why `rec` takes no messages, or null when it does (it may still be starting: see `socket`). */
export function messageRefusal(rec: RunRecord, get: (id: string) => RunRecord | null): string | null {
  const mode = rec.resolved?.mode ?? "headless";
  if (rec.kind !== "agent") return `run ${rec.id} is a ${rec.kind} run: only rpc and durable agent runs take messages`;
  if (mode !== "rpc" && mode !== "durable") return `run ${rec.id} runs ${mode}: only rpc and durable runs take messages`;
  const job = jobAbove(rec, get);
  if (job) return `run ${rec.id} belongs to server job ${job.jobId}: server jobs take no messages`;
  if (isFinal(rec.state)) return `run ${rec.id} has ended (${rec.state})`;
  return null;
}

/** A message could not be handed to the run: its socket is gone or pi did not answer in time. */
export class MessageError extends Error {
  readonly reason: "socket" | "timeout";
  constructor(reason: "socket" | "timeout", message: string) {
    super(message);
    this.name = "MessageError";
    this.reason = reason;
  }
}

/** Send a message over a run's control socket and wait for pi's answer to it. Throws MessageError. */
export function sendMessage(socketPath: string, message: string, meta: MessageMeta, timeoutMs = 15_000): Promise<Delivery> {
  const id = meta.id ?? newMessageId("msg");
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new MessageError("timeout", `pi did not answer the message within ${timeoutMs / 1000} s`))), timeoutMs);
    sock.once("error", (err) => done(() => reject(new MessageError("socket", `the run's control socket: ${err.message}`))));
    sock.once("connect", () => sock.write(`${JSON.stringify({ type: MESSAGE_TYPE, id, message, via: meta.via, ...(meta.from ? { from: meta.from } : {}) })}\n`));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const answer = responseTo(line, id);
        if (answer) return done(() => resolve(answer));
      }
    });
    sock.once("close", () => done(() => reject(new MessageError("socket", "the run's control socket closed before pi answered (the run ended)"))));
  });
}

/** pi's response to the command with this id, as a Delivery; null for any other line. */
function responseTo(line: string, id: string): Delivery | null {
  if (!line.includes('"response"') || !line.includes(id)) return null;
  try {
    const e = JSON.parse(line) as { type?: unknown; id?: unknown; success?: unknown; error?: unknown; data?: { disposition?: unknown } };
    if (e.type !== "response" || e.id !== id) return null;
    const disposition = typeof e.data?.disposition === "string" ? e.data.disposition : undefined;
    return { id, accepted: e.success !== false, ...(disposition ? { disposition } : {}), ...(e.success === false ? { error: String(e.error ?? "no reason given") } : {}) };
  } catch {
    return null;
  }
}

export interface DeskOptions {
  /** Write one command line to pi's stdin. */
  toPi(line: string): void;
  /** The run's journal: message.received goes there. */
  journal?: JournalSink | null;
}

/**
 * The receiving end, in the run's own process (the relay in runtime/pi.ts): builder messages from clients, and turns
 * the run's triggers start (deliver). It hands each to pi as a follow-up prompt and matches pi's answer to it.
 */
export class MessageDesk {
  private readonly o: DeskOptions;
  private readonly pending = new Map<string, (d: Delivery) => void>();
  private closed = false;

  constructor(o: DeskOptions) {
    this.o = o;
  }

  /**
   * A line a client wrote. True when it was a builder message (the desk handles it; `reply` answers that client when
   * it is malformed), false when it goes to pi as it is.
   */
  fromClient(line: string, reply: (line: string) => void): boolean {
    if (!line.includes(MESSAGE_TYPE)) return false;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!m || m.type !== MESSAGE_TYPE) return false;
    const id = typeof m.id === "string" && m.id ? m.id : newMessageId("msg");
    const message = typeof m.message === "string" ? m.message : "";
    if (!message.trim()) {
      reply(JSON.stringify({ id, type: "response", command: "prompt", success: false, error: "a builder message needs a message" }));
      return true;
    }
    const from = m.from && typeof m.from === "object" ? (m.from as MessageFrom) : undefined;
    void this.deliver(message, { id, via: typeof m.via === "string" && m.via ? m.via : "socket", ...(from ? { from } : {}) });
    return true;
  }

  /**
   * Hand pi a user message: it starts a turn, or is queued as a follow-up while one runs. Resolves with pi's answer
   * (accepted null when none came within `timeoutMs`, or the run ended first). `journal: false` leaves the journaling
   * to the caller (a trigger journals trigger.fired); otherwise message.received is journaled once pi answered.
   */
  deliver(message: string, meta: MessageMeta, o: { timeoutMs?: number; journal?: boolean } = {}): Promise<Delivery> {
    const id = meta.id ?? newMessageId(meta.via);
    if (this.closed) return Promise.resolve({ id, accepted: null, error: "the run has ended" });
    const answered = new Promise<Delivery>((resolve) => {
      const timeoutMs = o.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, accepted: null, error: `pi did not answer within ${timeoutMs / 1000} s` });
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, (d) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(d);
      });
    });
    this.o.toPi(JSON.stringify({ id, type: "prompt", message, streamingBehavior: "followUp" }));
    if (o.journal !== false) {
      void answered.then((d) =>
        this.o.journal?.append({
          kind: "message.received",
          data: { id, via: meta.via, ...(meta.from ? { from: meta.from } : {}), message, accepted: d.accepted, ...(d.disposition ? { disposition: d.disposition } : {}), ...(d.error ? { error: d.error } : {}) },
        }),
      );
    }
    return answered;
  }

  /** A line pi wrote: the answer to a message waits here. */
  fromPi(line: string): void {
    if (!this.pending.size || !line.includes('"response"')) return;
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown }).id;
    } catch {
      return;
    }
    if (typeof id !== "string") return;
    const settle = this.pending.get(id);
    const answer = settle ? responseTo(line, id) : null;
    if (settle && answer) settle(answer);
  }

  /** The run is ending: every message still waiting gets no answer. */
  close(): void {
    this.closed = true;
    for (const [id, settle] of [...this.pending]) settle({ id, accepted: null, error: "the run ended before pi answered" });
  }
}
