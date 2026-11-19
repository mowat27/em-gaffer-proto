/**
 * The server's control inbox (E14): how anything that is not the server (the CLI, an agent's control_send, a UI)
 * tells it to drain, resume or cancel, through files only (G8). Nothing connects to the running server.
 *
 *   control/inbox/<ts>-<id>.json     { action: "drain" | "resume" | "cancel", jobId?, by }   written atomically
 *   control/outbox/<ts>-<id>.json    the message with its id, receivedAt, appliedAt and result
 *
 * control/ is beside the runs directory (builder/control for builder/runs), so a machine config that moves the runs
 * moves the inbox with them, and every builder on a host has its own. It is gitignored.
 *
 * The server polls the inbox every second. It claims a message by renaming it (so two pollers never apply one twice),
 * applies it, writes the outbox file and removes the claim. A sender that waits for the outbox and gets no answer
 * withdraws its message the same way (control_send), so a server started later never applies a stale one.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ControlAction = "drain" | "resume" | "cancel";
export const CONTROL_ACTIONS: readonly ControlAction[] = ["drain", "resume", "cancel"];

export interface ControlMessage {
  action: ControlAction;
  /** cancel: the job to cancel (default: the running job). */
  jobId?: string;
  /** Who sent it: "cli (adrian)", "agent ops (run …)". */
  by?: string;
}

export interface ControlResult {
  ok: boolean;
  /** The server's state after the message, and its job (server.state's fields). */
  state?: "idle" | "busy" | "draining";
  jobId?: string;
  name?: string;
  runId?: string;
  step?: string;
  error?: string;
}

/** An outbox file: the message (no action when it did not parse) and what became of it. */
export interface ControlRecord extends Partial<ControlMessage> {
  id: string;
  sentAt?: string;
  receivedAt: string;
  appliedAt: string;
  result: ControlResult;
}

export const controlDir = (runsDir: string): string => join(dirname(runsDir), "control");
const inbox = (dir: string) => join(dir, "inbox");
const outbox = (dir: string) => join(dir, "outbox");

/** `20261118T101502123Z`: sorts by time. */
const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, "");

/** Put a message in the inbox. Returns its id and file. */
export function writeControl(dir: string, msg: ControlMessage): { id: string; file: string } {
  if (!CONTROL_ACTIONS.includes(msg.action)) throw new Error(`action ${String(msg.action)}: one of ${CONTROL_ACTIONS.join(", ")}`);
  mkdirSync(inbox(dir), { recursive: true });
  const id = `${stamp()}-${randomBytes(3).toString("hex")}`;
  const file = join(inbox(dir), `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...msg, sentAt: new Date().toISOString() }, null, 2) + "\n");
  renameSync(tmp, file);
  return { id, file };
}

/** The outbox record of a message, once the server applied it. */
export function readOutbox(dir: string, id: string): ControlRecord | null {
  try {
    return JSON.parse(readFileSync(join(outbox(dir), `${id}.json`), "utf8")) as ControlRecord;
  } catch {
    return null;
  }
}

/** Take a message back before any server claimed it. False when one already did. */
export function withdrawControl(dir: string, id: string): boolean {
  const file = join(inbox(dir), `${id}.json`);
  try {
    renameSync(file, `${file}.withdrawn`);
    rmSync(`${file}.withdrawn`, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A parsed inbox message, or why it is not one. */
function parseMessage(text: string): ControlMessage | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `not JSON: ${(err as Error).message}`;
  }
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== "object" || !CONTROL_ACTIONS.includes(m.action as ControlAction)) return `action must be one of ${CONTROL_ACTIONS.join(", ")}`;
  if (m.jobId !== undefined && typeof m.jobId !== "string") return "jobId must be a string";
  return { action: m.action as ControlAction, ...(typeof m.jobId === "string" ? { jobId: m.jobId } : {}), ...(typeof m.by === "string" ? { by: m.by } : {}), ...(typeof m.sentAt === "string" ? { sentAt: m.sentAt } : {}) } as ControlMessage;
}

export interface Poller {
  /** Handle what is in the inbox now (the timer calls it every interval). */
  poll(): Promise<void>;
  stop(): void;
}

/**
 * Poll the inbox: each message, oldest first, goes to `handle` with its id; its result goes to the outbox. A message
 * that does not parse goes to the outbox with ok: false. `handle` never runs twice at once.
 */
export function startInboxPoller(dir: string, handle: (msg: ControlMessage, id: string) => Promise<ControlResult>, everyMs = 1000): Poller {
  let running: Promise<void> | null = null;
  const once = async () => {
    const box = inbox(dir);
    if (!existsSync(box)) return;
    const names = readdirSync(box)
      .filter((n) => n.endsWith(".json"))
      .sort();
    for (const name of names) {
      const id = name.slice(0, -5);
      const file = join(box, name);
      const claimed = `${file}.${process.pid}.claimed`;
      try {
        renameSync(file, claimed);
      } catch {
        continue; // withdrawn, or another poller has it
      }
      const receivedAt = new Date().toISOString();
      let msg: ControlMessage | string;
      try {
        msg = parseMessage(readFileSync(claimed, "utf8"));
      } catch (err) {
        msg = (err as Error).message;
      }
      let result: ControlResult;
      if (typeof msg === "string") result = { ok: false, error: msg };
      else {
        try {
          result = await handle(msg, id);
        } catch (err) {
          result = { ok: false, error: (err as Error).message };
        }
      }
      const record: ControlRecord = { ...(typeof msg === "string" ? {} : msg), id, receivedAt, appliedAt: new Date().toISOString(), result };
      try {
        mkdirSync(outbox(dir), { recursive: true });
        const out = join(outbox(dir), name);
        writeFileSync(`${out}.tmp`, JSON.stringify(record, null, 2) + "\n");
        renameSync(`${out}.tmp`, out);
      } finally {
        rmSync(claimed, { force: true });
      }
    }
  };
  const poll = (): Promise<void> => {
    running ??= once()
      .catch(() => {
        /* tried again at the next poll */
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void poll(), everyMs);
  timer.unref();
  return { poll, stop: () => clearInterval(timer) };
}
