/**
 * The builder layer's work, all through the builder CLI with --json (design section 13, D22): the same path as a
 * terminal, and it works with nothing else running. The layer keeps no settings and owns no process: the build server
 * is started and stopped with `builder server start|stop|restart`, its settings live in the machine config layers
 * (`builder config` shows them, the operator edits them), and each agent's model lives in its settings.json.
 *
 *   status        the machine feed: `builder events --json -f` (replay, then follow), kept in memory. The server's
 *                 state is its last server.start, server.state and server.stop; a server.start whose pid is gone
 *                 without a server.stop reads as stopped.
 *   runs, logs    `builder runs`, `builder logs <run>`, `builder tool <name>`
 *   model picker  `builder resolve agent:<id>` reads an agent's model; `builder tool agent_get` and `agent_update`
 *                 change its settings.json, a versioned definition change (not a server setting)
 *   notifications `builder tool notifications_list` (control/notifications.jsonl), plus those a builder's `tsf`
 *                 notify sink posted to this TSF (kept in memory: a builder on another machine), newest first
 *
 * Node built-ins only. Nothing in builder/ imports this layer.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { LayerContext } from "../../app/src/agent/layer-context.ts";
import type { Json } from "../../app/src/shared/types.ts";

/** One line of `builder events --json`: the machine feed (builder/runtime/feed.ts). */
export interface FeedEvent {
  seq: number;
  ts: string;
  kind: string;
  runId?: string;
  jobId?: string;
  step?: string;
  data: Record<string, unknown>;
}

/** A feed event as the screens show it (the web app's FactoryEvent). */
export interface ShownEvent {
  seq: number;
  ts: string;
  source: string;
  kind: string;
  msg: string;
  jobId?: string;
  runId?: string;
  step?: string;
  name?: string;
  slice?: string;
}

/** The agent the model picker changes by default: the agent of supabase-api's implement step. */
export const MODEL_AGENT = "supabase-api";
/** Feed events kept in memory (the screens show the newest few hundred). */
const KEEP = 1000;
/** Notifications posted by a tsf sink, kept in memory. */
const KEEP_NOTIFICATIONS = 200;

/** A notification as notify_operator records it (builder/ops/core/notify.ts). */
export interface Notification {
  id: string;
  ts: string;
  severity: string;
  summary: string;
  runId?: string;
  jobId?: string;
  link?: string;
  from?: string;
  instance?: string | null;
  seq?: number;
}

const asNotification = (v: unknown): Notification | null => {
  const o = v as Partial<Notification> | null;
  return o && typeof o === "object" && typeof o.id === "string" && typeof o.ts === "string" && typeof o.summary === "string" && typeof o.severity === "string" ? (o as Notification) : null;
};

/** The CLI's error codes as the app's error codes (HTTP statuses for the screens). */
const APP_CODE: Record<string, string> = { usage: "invalid", invalid: "invalid", unknown: "not_found", refused: "forbidden", unavailable: "unavailable" };

/**
 * A CLI command that failed: its `{ error: { code, message } }` (`cliCode`: usage, unknown, invalid, refused,
 * unavailable, failed). Named ServiceError with an app code, so the screens show its message (the layer imports types
 * only and cannot throw the app's class).
 */
export class CliError extends Error {
  readonly code: string;
  readonly cliCode: string;
  constructor(cliCode: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.cliCode = cliCode;
    this.code = APP_CODE[cliCode] ?? "upstream";
  }
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const clip = (s: string, n = 160): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What a feed event says, in a few words. */
export function describe(e: FeedEvent): string {
  const d = e.data;
  switch (e.kind) {
    case "server.start":
      return `build server on http://${str(d.host)}:${str(d.port)} (pid ${str(d.pid)}), builder ${str(d.builder)}`;
    case "server.state":
      return d.state === "busy" ? `busy: ${str(d.name) || str(d.jobId)}${d.step ? ` at ${str(d.step)}` : ""}` : str(d.state);
    case "server.stop":
      return `stopped (${str(d.signal) || "exit"})${d.abandoned ? `, job ${str(d.abandoned)} abandoned` : ""}`;
    case "run.start":
      return `${d.agent ? `agent ${str(d.agent)}` : d.workflow ? `workflow ${str(d.workflow)}` : str(d.kind)}, ${str(d.mode)}${d.model ? `, pi ${str(d.model)}${d.thinking ? ` (thinking ${str(d.thinking)})` : ""}` : ""}${d.step ? `, step ${str(d.step)}` : ""}${d.parent ? `, child of ${str(d.parent)}` : ""}`;
    case "run.end":
      return `${str(d.state) || str(d.outcome)}${d.reason ? `: ${clip(str(d.reason), 200)}` : ""}${d.said ? `, pi finished: ${clip(str(d.said), 120)}` : ""}`;
    case "job.result":
      return `${str(d.outcome)}${d.reason ? `: ${clip(str(d.reason), 200)}` : ""}${typeof d.commits === "number" ? `, ${d.commits} commit(s)` : ""}${typeof d.patchBytes === "number" ? `, patch ${d.patchBytes} bytes` : ""}`;
    case "step.start":
      return `${str(d.stepKind)}${d.agent ? ` agent ${str(d.agent)}` : ""}${d.childRunId ? `, run ${str(d.childRunId)}` : ""}`;
    case "step.end":
      return `${str(d.status)}${typeof d.ms === "number" ? ` in ${Math.round(d.ms / 1000)}s` : ""}${d.reason ? `: ${clip(str(d.reason), 200)}` : ""}`;
    case "job.accepted":
      return `${str(d.slice)}, attempt ${str(d.attempt)}, builder ${str(d.builder)}`;
    case "control.received":
    case "control.applied":
      return `${str(d.action)}${d.by ? ` from ${str(d.by)}` : ""}`;
    case "config.loaded":
      return d.ok === false ? `failed: ${clip(str(d.error))}` : `${Array.isArray(d.layers) ? d.layers.length : "?"} layer(s)`;
    case "notification":
      return `${str(d.severity)}: ${clip(str(d.summary))}`;
    default:
      return clip(d.msg !== undefined ? str(d.msg) : JSON.stringify(d));
  }
}

export function shown(e: FeedEvent): ShownEvent {
  const name = typeof e.data.name === "string" ? e.data.name : undefined;
  const slice = typeof e.data.slice === "string" ? e.data.slice : undefined;
  return {
    seq: e.seq,
    ts: e.ts,
    source: "feed",
    kind: e.kind,
    msg: describe(e),
    ...(e.jobId ? { jobId: e.jobId } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.step ? { step: e.step } : {}),
    ...(name ? { name } : {}),
    ...(slice ? { slice } : {}),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const asFeedEvent = (v: unknown): FeedEvent | null => {
  const o = v as Partial<FeedEvent> | null;
  return o && typeof o === "object" && typeof o.seq === "number" && typeof o.kind === "string" && typeof o.ts === "string" ? ({ ...o, data: o.data && typeof o.data === "object" ? o.data : {} } as FeedEvent) : null;
};

export class BuilderLayer {
  /** builder/ */
  readonly root: string;
  readonly cliPath: string;
  private feed: FeedEvent[] = [];
  /** The server's own events (server.*), kept apart so a long feed never pushes its last start out. */
  private server: FeedEvent[] = [];
  private lastSeq = 0;
  private followError: string | null = null;
  private renderTimer: NodeJS.Timeout | null = null;
  private readonly models = new Map<string, { at: number; value: Json }>();
  /** Notifications a builder's tsf sink posted (notification action), newest last. */
  private received: Notification[] = [];

  private readonly ctx: LayerContext;

  constructor(ctx: LayerContext) {
    this.ctx = ctx;
    this.root = ctx.paths.projectRoot;
    this.cliPath = join(this.root, "cli", "builder.ts");
  }

  /** Run `builder <args> --json`: its JSON answer (one document, or one value per line with `lines`). */
  cli(args: string[], o: { lines?: boolean; timeoutMs?: number } = {}): Promise<Json> {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [this.cliPath, ...args, "--json"], { cwd: this.root, env: process.env, timeout: o.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = String(stdout).trim();
        let value: unknown;
        try {
          value = o.lines ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown) : text ? JSON.parse(text) : null;
        } catch {
          value = undefined;
        }
        const e = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
        if (e && typeof e === "object" && !Array.isArray(value)) return reject(new CliError(String(e.code ?? "error"), `builder ${args[0]}: ${String(e.message ?? "failed")}`));
        if (err && value === undefined) return reject(new CliError("error", `builder ${args.join(" ")}: ${String(stderr).trim().split("\n").slice(-3).join(" ") || err.message}`));
        resolve((value ?? null) as Json);
      });
    });
  }

  /** `builder tool <name> <args>`. */
  tool(name: string, args: Record<string, unknown> = {}): Promise<Json> {
    return this.cli(["tool", name, JSON.stringify(args)]);
  }

  private add(events: FeedEvent[]): void {
    let changed = false;
    for (const e of events) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      this.feed.push(e);
      if (e.kind.startsWith("server.") && !this.server.some((x) => x.seq === e.seq)) this.server.push(e);
      changed = true;
    }
    if (this.feed.length > KEEP) this.feed = this.feed.slice(-KEEP);
    if (this.server.length > 50) this.server = this.server.slice(-50);
    if (changed) this.scheduleRender();
  }

  /**
   * Follow the machine feed: the server's recent events once, then `builder events --json -f` replaying the newest
   * KEEP and following. A follower that ends is started again after 5 s from the last seq it saw.
   */
  follow(): () => void {
    let stopped = false;
    let child: ChildProcess | null = null;
    let retry: NodeJS.Timeout | null = null;
    const start = () => {
      if (stopped) return;
      const from = this.lastSeq ? ["--since", String(this.lastSeq)] : ["--last", String(KEEP)];
      child = spawn(process.execPath, [this.cliPath, "events", "--json", "-f", ...from], { cwd: this.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const got: FeedEvent[] = [];
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const e = asFeedEvent(JSON.parse(line));
            if (e) got.push(e);
          } catch {
            /* not a feed line */
          }
        }
        if (got.length) {
          this.followError = null;
          this.add(got);
        }
      });
      child.stderr?.on("data", (d: Buffer) => (err = (err + d.toString("utf8")).slice(-1000)));
      child.on("error", (e) => (err = e.message));
      child.on("exit", (code) => {
        child = null;
        if (stopped) return;
        this.followError = `builder events stopped (exit ${code}): ${err.trim().split("\n").pop() ?? ""}`;
        this.scheduleRender();
        retry = setTimeout(start, 5000);
      });
    };
    void this.cli(["events", "--kind", "server.*", "--last", "20"], { lines: true })
      .then((v) => {
        const seed = (Array.isArray(v) ? v : []).map(asFeedEvent).filter((e): e is FeedEvent => !!e);
        this.server = seed;
      })
      .catch((e: unknown) => (this.followError = (e as Error).message))
      .finally(start);
    // A server that dies without its server.stop: its pid is checked every few seconds.
    let wasRunning = false;
    const pidTimer = setInterval(() => {
      const running = this.serverState().running;
      if (running !== wasRunning) {
        wasRunning = running;
        this.scheduleRender();
      }
    }, 3000);
    // The follower ends with the factory, not at the next feed line it can no longer write.
    const kill = () => child?.kill();
    process.once("exit", kill);
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clearInterval(pidTimer);
      process.off("exit", kill);
      kill();
    };
  }

  private serverState(): { running: boolean; start: FeedEvent | null; state: FeedEvent | null; stop: FeedEvent | null } {
    let start: FeedEvent | null = null;
    let state: FeedEvent | null = null;
    let stop: FeedEvent | null = null;
    for (const e of [...this.server].sort((a, b) => a.seq - b.seq)) {
      if (e.kind === "server.start") {
        start = e;
        state = null;
        stop = null;
      } else if (e.kind === "server.state") state = e;
      else if (e.kind === "server.stop") stop = e;
    }
    const pid = start && !stop ? Number(start.data.pid) : NaN;
    return { running: Number.isInteger(pid) && pid > 0 && alive(pid), start, state, stop };
  }

  /** The builder's state from the feed: the server, its current job and the last one. */
  status(): Json {
    const { running, start, state } = this.serverState();
    const s = running ? (typeof state?.data.state === "string" ? state.data.state : "idle") : "stopped";
    const accepted = (jobId: string) => [...this.feed].reverse().find((e) => e.kind === "job.accepted" && e.jobId === jobId);
    const d = state?.data ?? {};
    const current = running && typeof d.jobId === "string" ? d.jobId : null;
    const a = current ? accepted(current) : undefined;
    const job = current
      ? { jobId: current, name: str(d.name), runId: str(d.runId), step: str(d.step), slice: str(a?.data.slice), attempt: a?.data.attempt ?? null, startedAt: a?.ts ?? state?.ts ?? null }
      : null;
    const result = [...this.feed].reverse().find((e) => e.kind === "job.result");
    const lastJob = result
      ? { jobId: result.jobId ?? null, name: str(accepted(result.jobId ?? "")?.data.name) || null, slice: str(accepted(result.jobId ?? "")?.data.slice) || null, outcome: str(result.data.outcome), reason: str(result.data.reason) || null, endedAt: result.ts }
      : null;
    const last = this.feed.at(-1);
    const url = running && start ? `http://${str(start.data.host)}:${str(start.data.port)}` : null;
    const summary = `Builder ${s === "stopped" ? "stopped" : s === "busy" && job ? `busy: ${job.name || job.jobId} at ${job.step}` : s}${last ? ` · ${last.kind}` : ""}`;
    return {
      running,
      state: s,
      pid: running && start ? Number(start.data.pid) : null,
      url,
      builder: start ? str(start.data.builder) : null,
      runsDir: start ? str(start.data.runsDir) : null,
      job,
      lastJob,
      lastEvent: last ? shown(last) : null,
      followError: this.followError,
      summary,
    } as unknown as Json;
  }

  /** The newest feed events first, as the screens show them (what `builder events -f` has delivered so far). */
  events(limit = 120, kind?: string): ShownEvent[] {
    const match = (e: FeedEvent) => !kind || (kind.endsWith("*") ? e.kind.startsWith(kind.slice(0, -1)) : e.kind === kind);
    return this.feed.filter(match).slice(-limit).reverse().map(shown);
  }

  /** An agent's model as its next run would use it (`builder resolve`), read again after 30 s or a change. */
  async model(agent = MODEL_AGENT): Promise<Json> {
    const cached = this.models.get(agent);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const r = (await this.cli(["resolve", `agent:${agent}`, "--workspace", "none"])) as { agent?: { dir?: string }; settings?: { provider?: string; model?: string; thinking?: string } } | null;
    const s = r?.settings ?? {};
    const value: Json = { agent, provider: s.provider ?? "", model: s.model ?? "", thinking: s.thinking ?? "", dir: r?.agent?.dir ?? null };
    this.models.set(agent, { at: Date.now(), value });
    return value;
  }

  /**
   * Change an agent's model: its settings.json with defaultProvider, defaultModel and defaultThinkingLevel replaced, as
   * a versioned definition change (`agent_get` for the file and its version, `agent_update` with it as expectedVersion).
   */
  async setModel(input: { agent?: string; provider?: string; model?: string; thinking?: string }): Promise<Json> {
    const agent = input.agent || MODEL_AGENT;
    const got = (await this.tool("agent_get", { id: agent, file: "settings.json" }).catch((err: unknown) => {
      // An agent without a settings.json yet: start one (agent_get still gives the version).
      if (err instanceof CliError && /settings\.json is not in/.test(err.message)) return this.tool("agent_get", { id: agent });
      throw err;
    })) as { version?: unknown; content?: unknown } | null;
    let settings: Record<string, unknown> = {};
    try {
      if (typeof got?.content === "string") settings = JSON.parse(got.content) as Record<string, unknown>;
    } catch {
      throw new CliError("failed", `agent ${agent}: its settings.json is not JSON`);
    }
    if (input.provider !== undefined) settings.defaultProvider = input.provider;
    if (input.model !== undefined) settings.defaultModel = input.model;
    if (input.thinking !== undefined) {
      if (input.thinking) settings.defaultThinkingLevel = input.thinking;
      else delete settings.defaultThinkingLevel;
    }
    const out = await this.tool("agent_update", {
      id: agent,
      expectedVersion: typeof got?.version === "string" ? got.version : null,
      files: { "settings.json": `${JSON.stringify(settings, null, 2)}\n` },
      reason: "model picker in the builder TSF",
    });
    this.models.delete(agent);
    this.scheduleRender();
    return out;
  }

  /** A notification a builder's tsf notify sink posted. */
  receive(input: unknown): Json {
    const n = asNotification(input);
    if (!n) throw new CliError("invalid", "notification: the input is not a notification (id, ts, severity, summary)");
    if (!this.received.some((x) => x.id === n.id)) this.received = [...this.received, n].slice(-KEEP_NOTIFICATIONS);
    this.scheduleRender();
    return { ok: true, id: n.id };
  }

  /** The operator's notifications, newest first: this machine's (`notifications_list`) and those posted to this TSF. */
  async notifications(limit = 100): Promise<Json> {
    let recorded: Notification[] = [];
    let error: string | null = null;
    try {
      const r = (await this.tool("notifications_list", { limit })) as { notifications?: unknown[] } | null;
      recorded = (r?.notifications ?? []).map(asNotification).filter((n): n is Notification => !!n);
    } catch (err) {
      error = (err as Error).message;
    }
    const seen = new Set(recorded.map((n) => n.id));
    const all = [...recorded, ...this.received.filter((n) => !seen.has(n.id))].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
    return { count: all.length, error, notifications: all } as unknown as Json;
  }

  scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.ctx.bus.publish({ type: "layer.changed", layer: "builder", by: "system" });
    }, 400);
  }
}

export function text(v: unknown, max = 4000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}
