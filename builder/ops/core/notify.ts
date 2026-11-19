/**
 * notify: feedback to the operator (design section 10, E21).
 *
 *   notify_operator     a severity (info, warn, error), a summary, an optional run id and an optional link (a change set,
 *                       a pushed branch). The notification is appended to control/notifications.jsonl (beside the runs
 *                       directory, as the control inbox is), written to the machine feed as a `notification` event (so
 *                       it is on `builder events` and every run's `GET /events`), then sent to every sink in the
 *                       machine config's `notify:`. With no sink it is still recorded (E21). A sink that fails is logged
 *                       on stderr (the run's log, the CLI's terminal) and named in the result, and the other sinks still
 *                       get it: the call fails only when the notification could not be recorded.
 *   notifications_list  the recorded notifications, newest first: after a seq or since a time, at most `limit`.
 *
 * Sinks (ops/config.ts NotifySink), the notification as JSON in each:
 *   tsf      POST <url>/api/layers/builder/action/notification with `{ input: <notification> }`: the TSF's builder layer
 *            keeps it for its Ops tab. `Authorization: Bearer <token>` when the sink names an env: token. 5 s timeout.
 *   file     append it as one JSON line to `path`.
 *   command  `sh -c <command>` beside the runs directory (builder/ by default), the notification's JSON on stdin; 10 s
 *            timeout, a non-zero exit is an error.
 *
 * A notification's seq is its line number in notifications.jsonl, assigned by the reader (as the feed's), so
 * `since: <seq>` resumes exactly. Secrets are redacted before anything is written or sent (G7).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { appendFeed, parseSince } from "../../runtime/feed.ts";
import { redact } from "../../runtime/journal-client.ts";
import { jobOf } from "../../runtime/run.ts";
import { controlDir } from "../../server/control.ts";
import { secret, type NotifySink } from "../config.ts";
import { findRun, runsDirOf } from "./common.ts";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

export const SEVERITIES = ["info", "warn", "error"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const NOTIFICATIONS_FILE = "notifications.jsonl";

export interface Notification {
  id: string;
  ts: string;
  severity: Severity;
  summary: string;
  /** The run it is about. */
  runId?: string;
  jobId?: string;
  /** A change set, a pushed branch, a page. */
  link?: string;
  /** Who sent it: `agent <id> (run <id>)`, `api (run <id>)` or `cli`. */
  from: string;
  instance: string | null;
}

export interface SinkResult {
  sink: string;
  ok: boolean;
  error?: string;
}

/** control/notifications.jsonl for a runs directory. */
export const notificationsPath = (runsDir: string): string => join(controlDir(runsDir), NOTIFICATIONS_FILE);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function sender(ctx: ToolContext): string {
  const c = ctx.caller;
  if (c.kind === "agent") return `agent ${c.agent ?? "?"}${c.runId ? ` (run ${c.runId})` : ""}`;
  if (c.kind === "api") return `api${c.runId ? ` (run ${c.runId})` : ""}`;
  return "cli";
}

/** POST to the TSF's builder layer. */
async function toTsf(s: NotifySink, n: Notification, env: NodeJS.ProcessEnv): Promise<void> {
  const url = `${(s.url ?? "").replace(/\/+$/, "")}/api/layers/builder/action/notification`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s.token) headers.authorization = `Bearer ${secret(s.token, env)}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ input: n }), signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`POST ${url}: ${res.status}${body ? ` ${body}` : ""}`);
  }
}

function toFile(s: NotifySink, n: Notification): void {
  mkdirSync(dirname(s.path!), { recursive: true });
  appendFileSync(s.path!, JSON.stringify(n) + "\n");
}

function toCommand(s: NotifySink, n: Notification, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", s.command!], { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${s.command}: no exit within 10 s`));
    }, 10_000);
    child.stderr?.on("data", (d: Buffer) => (err = (err + d.toString("utf8")).slice(-500)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${s.command}: exit ${code}${err.trim() ? `: ${err.trim()}` : ""}`));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(n) + "\n");
  });
}

/** Send to one sink. Never throws: what went wrong is in the result and on stderr. */
export async function sendToSink(s: NotifySink, n: Notification, o: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<SinkResult> {
  try {
    if (s.sink === "tsf") await toTsf(s, n, o.env ?? process.env);
    else if (s.sink === "file") toFile(s, n);
    else if (s.sink === "command") await toCommand(s, n, o.cwd);
    else throw new Error(`unknown sink ${s.sink}`);
    return { sink: s.sink, ok: true };
  } catch (err) {
    const error = messageOf(err);
    try {
      console.error(`[builder] notify sink ${s.sink} failed: ${error}`);
    } catch {
      /* stderr gone */
    }
    return { sink: s.sink, ok: false, error };
  }
}

const notifyOperator = defineTool({
  name: "notify_operator",
  group: "notify",
  description:
    "Tell the operator something: severity (info, warn, error), a one-paragraph summary, the run it is about and a link (a pushed branch, a change set). It is recorded in control/notifications.jsonl and the machine feed and sent to every notify sink in the machine config. End every investigation with one.",
  params: Type.Object(
    {
      severity: Type.Union(SEVERITIES.map((s) => Type.Literal(s))),
      summary: Type.String({ minLength: 1, maxLength: 4000, description: "What happened and what was done, with the evidence" }),
      runId: Type.Optional(Type.String({ description: "The run it is about: a run id, a job id or name, latest or self" })),
      link: Type.Optional(Type.String({ maxLength: 2000, description: "A change set, a pushed branch or a page" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { severity: Severity; summary: string; runId?: string; link?: string }, ctx: ToolContext) => {
    const runsDir = runsDirOf(ctx);
    // The run it is about, by any of its names; one that is not found is kept as written (a notification is never lost).
    let runId = a.runId?.trim() || undefined;
    let jobId: string | undefined;
    if (runId) {
      try {
        const rec = findRun(ctx, runId);
        runId = rec.id;
        jobId = jobOf(ctx.runtime, rec)?.jobId;
      } catch {
        /* kept as written */
      }
    }
    const n = redact({
      id: `n-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      ts: new Date().toISOString(),
      severity: a.severity,
      summary: a.summary.trim(),
      ...(runId ? { runId } : {}),
      ...(jobId ? { jobId } : {}),
      ...(a.link?.trim() ? { link: a.link.trim() } : {}),
      from: sender(ctx),
      instance: ctx.config.instance,
    }) as Notification;
    const file = notificationsPath(runsDir);
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(n) + "\n");
    } catch (err) {
      throw new ToolError("failed", `the notification was not recorded in ${file}: ${messageOf(err)}`);
    }
    appendFeed(runsDir, {
      kind: "notification",
      ...(n.runId ? { runId: n.runId } : {}),
      ...(n.jobId ? { jobId: n.jobId } : {}),
      data: { id: n.id, severity: n.severity, summary: n.summary, ...(n.link ? { link: n.link } : {}), from: n.from, instance: n.instance },
    });
    const sinks = await Promise.all(ctx.config.notify.map((s) => sendToSink(s, n, { cwd: dirname(runsDir) })));
    return { notification: n, recorded: file, sinks };
  },
});

export interface NotificationFilter {
  /** A seq (digits: after it), a time (ISO) or a duration (10m, 2h, 1d: since then). */
  since?: string;
  limit?: number;
}

/** The recorded notifications, each with its seq (its line number), newest first. A missing file reads as none. */
export function readNotifications(runsDir: string, f: NotificationFilter = {}): (Notification & { seq: number })[] {
  const file = notificationsPath(runsDir);
  if (!existsSync(file)) return [];
  const since = f.since !== undefined ? parseSince(f.since) : undefined;
  const out: (Notification & { seq: number })[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      const seq = i + 1;
      if (since && "seq" in since && seq <= since.seq) return;
      try {
        const n = JSON.parse(line) as Notification;
        if (typeof n.summary !== "string" || typeof n.ts !== "string") return;
        if (since && "time" in since && !(Date.parse(n.ts) >= since.time)) return;
        out.push({ seq, ...n });
      } catch {
        /* a torn line keeps its number */
      }
    });
  return out.reverse().slice(0, f.limit ?? 50);
}

const notificationsList = defineTool({
  name: "notifications_list",
  group: "notify",
  description: "The notifications sent to the operator (notify_operator), newest first, each with its seq: since a seq, a time or a duration (10m, 2h, 1d).",
  params: Type.Object(
    {
      since: Type.Optional(Type.String({ description: "A seq (only later ones), an ISO time, or a duration such as 1d" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "At most this many (default 50)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { since?: string; limit?: number }, ctx: ToolContext) => {
    const runsDir = runsDirOf(ctx);
    let notifications: (Notification & { seq: number })[];
    try {
      notifications = readNotifications(runsDir, a);
    } catch (err) {
      throw new ToolError("invalid", messageOf(err));
    }
    return { file: notificationsPath(runsDir), count: notifications.length, notifications };
  },
});

export const tools: ToolDef[] = [notifyOperator, notificationsList];
