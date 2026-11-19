/**
 * The api adapter (design section 10, D8, D12): a run whose agent.yml has `api: { listen, token: env:NAME }` serves
 * HTTP from its own run process for as long as the run lives (runtime/main.ts starts it before the agent's pi). It adds
 * no logic of its own: tools go through callTool, events come from the machine feed, the run's journal and its control
 * socket. Access is the bearer token and the network; only POST /tools is bound by the agent's tools.
 *
 *   POST /messages       { "message": "..." }: a user message for an rpc or durable run, sent over its control socket as
 *                        run_send sends one (runtime/messaging.ts): an rpc prompt (a follow-up while a turn runs), which
 *                        starts a turn. 202 { id, disposition }. 409 for a run that takes no messages.
 *   GET  /events         server-sent events: `feed` (the machine feed, runtime/feed.ts), `journal` (this run's journal,
 *                        when it keeps one) and `agent` (pi's rpc lines, for rpc and durable runs). Each event's id is
 *                        `<feed seq>:<journal seq>`, so a client that reconnects with Last-Event-ID resumes both.
 *                        ?since=<seq|time|10m> (feed) and ?after=<seq> (journal) say where to start; without them the
 *                        last 100 of each are replayed (?last=n). ?streams=feed,journal,agent picks the streams.
 *   POST /tools/<name>   one of the agent's tools (what the run resolved, within the live machine limit) through
 *                        callTool with the caller `api`: the body is the arguments, the answer the tool's value as JSON.
 *                        An error is { error: { code, message } }: unknown 404, invalid 400, refused 403, unavailable
 *                        501, failed 422.
 *   GET  /instance       instance_get (the instance id, version, the merged config with secrets hidden and the layer of
 *                        each value), and this run: id, agent, mode, state, tools.
 *
 * Every request needs `Authorization: Bearer <token>` (401 otherwise). The token is the value of the variable that
 * `token: env:NAME` names, never a value in YAML. A run that cannot serve its API (the variable unset or empty, the
 * address taken) fails before its pi starts and says why (G1). Where it listens is in run.json (`api`). A run with a
 * journal journals api.start and each tool call (api.tool); its relay journals each message (message.received).
 *
 * An rpc run ends when pi settles with no client on its control socket. POST /messages connects only to send, so an rpc
 * run stays for its API while a GET /events client follows its `agent` stream. A durable run stays regardless.
 *
 * The tool core is loaded when the API starts (runtime/resolve.ts imports apiSettings from here).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { isMap, secret } from "../ops/config.ts";
import type { ToolContext, ToolErrorCode } from "../ops/core/tool.ts";
import { followFeed, parseSince, readFeed } from "./feed.ts";
import { readJournal, type JournalSink } from "./journal.ts";
import { MessageError, messageRefusal, sendMessage, type Delivery } from "./messaging.ts";
import type { LocalRuntime } from "./run.ts";

/** agent.yml `api:`, checked: where to listen and the env: reference that holds the token. */
export interface ApiSettings {
  host: string;
  /** 0: a free port, found in run.json once the API listens. */
  port: number;
  /** `env:NAME` */
  token: string;
}

const LISTEN = /^(?:(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+)):)?:?(\d{1,5})$/;

/** Check an agent.yml's `api:` and normalise it. Throws `api.<key> ...`. The host defaults to 127.0.0.1. */
export function apiSettings(raw: unknown): ApiSettings {
  if (!isMap(raw)) throw new Error("api must be a map: { listen: <host:port>, token: env:<NAME> }");
  for (const k of Object.keys(raw)) if (k !== "listen" && k !== "token") throw new Error(`unknown key api.${k}`);
  const listen = typeof raw.listen === "number" ? String(raw.listen) : raw.listen;
  const m = typeof listen === "string" ? LISTEN.exec(listen.trim()) : null;
  const port = m ? Number(m[3]) : Number.NaN;
  if (!m || !(port >= 0 && port <= 65535)) throw new Error(`api.listen must be [host:]port, e.g. 127.0.0.1:8090 (not ${JSON.stringify(raw.listen ?? null)})`);
  if (typeof raw.token !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(raw.token)) throw new Error("api.token must be an env: reference (env:NAME): a token is never a value in YAML");
  return { host: m[1] ?? m[2] ?? "127.0.0.1", port, token: raw.token };
}

export interface ApiOptions {
  settings: ApiSettings;
  /** The serving run (an agent run). */
  runId: string;
  runDir: string;
  /** Reads its run.json (mode, control socket) and records where the API listens. */
  runtime: LocalRuntime;
  /** The run's journal, when it keeps one. */
  journal?: JournalSink | null;
  env?: NodeJS.ProcessEnv;
}

export interface ApiServer {
  url: string;
  close(): Promise<void>;
}

/** An answer the handlers throw: its status and `{ error: { code, message } }`. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** A ToolError's code as an HTTP status. */
const TOOL_STATUS: Record<ToolErrorCode, number> = { unknown: 404, invalid: 400, refused: 403, unavailable: 501, failed: 422 };
const MAX_BODY = 1024 * 1024;
const REPLAY = 100;
const STREAMS = ["feed", "journal", "agent"] as const;

const digest = (s: string) => createHash("sha256").update(s).digest();
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(`${JSON.stringify(value ?? null)}\n`);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "invalid", `the body is over ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, "invalid", `the body is not JSON: ${(err as Error).message}`);
  }
}

/** Start serving the API for a run. Throws (and serves nothing) when the token is not set or the address is taken. */
export async function startApi(o: ApiOptions): Promise<ApiServer> {
  const env = o.env ?? process.env;
  let token: string;
  try {
    token = secret(o.settings.token, env);
  } catch (err) {
    throw new Error(`api: the token ${(err as Error).message}`);
  }
  if (!token) throw new Error(`api: the token ${o.settings.token} is empty`);
  const want = digest(token);

  const { AgentTools, apiContext } = await import("../ops/core/context.ts");
  const { callTool, isToolError, registry } = await import("../ops/core/index.ts");
  const agent = AgentTools.fromEnv({ ...env, BUILDER_RUN_DIR: o.runDir });
  if (!agent) throw new Error(`api: run ${o.runId} is not an agent run`);
  /** The caller `api`: the run's own tools within the live machine limit, read again on every call. */
  const context = (): ToolContext => {
    const c = agent.context();
    return apiContext(c.config, c.runtime, { runId: o.runId, ...(c.caller.agent ? { agent: c.caller.agent } : {}), allowed: c.caller.allowed });
  };
  const runsDir = o.runtime.options.runsDir;
  const open = new Set<AbortController>();
  let messages = 0;
  let url = "";

  const authorized = (req: IncomingMessage): boolean => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    return !!m && timingSafeEqual(digest(m[1].trim()), want);
  };

  const instance = async (res: ServerResponse) => {
    const ctx = context();
    const info = (await registry().get("instance_get")!.run({}, ctx)) as Record<string, unknown>;
    const rec = o.runtime.get(o.runId);
    send(res, 200, { ...info, run: { id: o.runId, agent: rec?.spec.agent ?? null, mode: rec?.resolved?.mode ?? null, state: rec?.state ?? null, api: url, tools: [...ctx.caller.allowed] } });
  };

  const tool = async (name: string, req: IncomingMessage, res: ServerResponse) => {
    const args = await readBody(req);
    const started = Date.now();
    try {
      const value = await callTool(name, args, context());
      o.journal?.append({ kind: "api.tool", data: { tool: name, input: args, ok: true, ms: Date.now() - started } });
      send(res, 200, value);
    } catch (err) {
      const code: ToolErrorCode = isToolError(err) ? err.code : "failed";
      const message = err instanceof Error ? err.message : String(err);
      o.journal?.append({ kind: "api.tool", data: { tool: name, input: args, ok: false, code, error: message, ms: Date.now() - started } });
      send(res, TOOL_STATUS[code], { error: { code, message } });
    }
  };

  // One rule and one wire for every sender (runtime/messaging.ts): the relay's desk journals message.received.
  const message = async (req: IncomingMessage, res: ServerResponse) => {
    const rec = o.runtime.get(o.runId);
    const refusal = rec ? messageRefusal(rec, (id) => o.runtime.get(id)) : `no run ${o.runId}`;
    if (refusal) throw new HttpError(409, "refused", refusal);
    const b = await readBody(req);
    const text = isMap(b) && typeof b.message === "string" ? b.message : "";
    if (!text.trim()) throw new HttpError(400, "invalid", 'the body is { "message": "<text>" }');
    if (!rec?.socket) throw new HttpError(503, "unavailable", `run ${o.runId} has no control socket yet`, { "retry-after": "1" });
    const id = `api-${++messages}-${Date.now().toString(36)}`;
    let answer: Delivery;
    try {
      answer = await sendMessage(rec.socket, text, { id, via: "api", from: { kind: "api" } }, 10_000);
    } catch (err) {
      if (err instanceof MessageError && err.reason === "timeout") throw new HttpError(504, "failed", err.message);
      throw new HttpError(503, "unavailable", (err as Error).message, { "retry-after": "1" });
    }
    if (answer.accepted === false) throw new HttpError(409, "refused", `pi refused the message: ${answer.error ?? "no reason given"}`);
    send(res, 202, { id, disposition: answer.disposition ?? null });
  };

  const events = (req: IncomingMessage, res: ServerResponse, u: URL) => {
    const streams = new Set((u.searchParams.get("streams") ?? STREAMS.join(",")).split(",").map((s) => s.trim()).filter(Boolean));
    const bad = [...streams].filter((s) => !(STREAMS as readonly string[]).includes(s));
    if (bad.length) throw new HttpError(400, "invalid", `unknown stream ${bad.join(", ")}: streams is any of ${STREAMS.join(", ")}`);
    const lastParam = u.searchParams.get("last");
    const last = lastParam === null ? REPLAY : Number(lastParam);
    if (!Number.isInteger(last) || last < 0) throw new HttpError(400, "invalid", "last is a number of events");
    const resume = /^(\d+):(\d+)$/.exec(String(req.headers["last-event-id"] ?? ""));
    // Where each stream starts, as the seq just before the first event to send.
    let f: number;
    let j: number;
    if (resume) {
      f = Number(resume[1]);
      j = Number(resume[2]);
    } else {
      const feed = readFeed(runsDir);
      const since = u.searchParams.get("since");
      if (since !== null) {
        let s: ReturnType<typeof parseSince>;
        try {
          s = parseSince(since);
        } catch (err) {
          throw new HttpError(400, "invalid", (err as Error).message);
        }
        f = "seq" in s ? s.seq : (feed.filter((e) => !(Date.parse(e.ts) >= s.time)).at(-1)?.seq ?? 0);
      } else f = feed.length > last ? feed[feed.length - last - 1].seq : 0;
      const after = u.searchParams.get("after");
      if (after !== null) {
        j = Number(after);
        if (!Number.isInteger(j) || j < 0) throw new HttpError(400, "invalid", "after is a journal seq");
      } else {
        const journal = readJournal(o.runDir);
        j = journal.length > last ? journal[journal.length - last - 1].seq : 0;
      }
    }
    const ac = new AbortController();
    const signal = ac.signal;
    open.add(ac);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": builder api events\n\n");
    const write = (event: string, json: string) => {
      if (!signal.aborted) res.write(`id: ${f}:${j}\nevent: ${event}\ndata: ${json}\n\n`);
    };
    const heartbeat = setInterval(() => signal.aborted || res.write(": keepalive\n\n"), 15_000);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(heartbeat);
        open.delete(ac);
        res.end();
      },
      { once: true },
    );
    req.once("close", () => ac.abort());
    res.once("close", () => ac.abort());
    if (streams.has("feed")) {
      void followFeed(runsDir, { since: { seq: f } }, (e) => {
        f = e.seq;
        write("feed", JSON.stringify(e));
      }, signal).catch(() => {});
    }
    if (streams.has("journal")) {
      void (async () => {
        while (!signal.aborted) {
          for (const e of readJournal(o.runDir, { after: j })) {
            j = e.seq;
            write("journal", JSON.stringify(e));
          }
          await sleep(500, signal);
        }
      })();
    }
    const mode = o.runtime.get(o.runId)?.resolved?.mode;
    if (streams.has("agent") && (mode === "rpc" || mode === "durable")) {
      void (async () => {
        let socket: string | undefined;
        while (!signal.aborted && !(socket = o.runtime.get(o.runId)?.socket)) await sleep(200, signal);
        if (!socket || signal.aborted) return;
        const sock = connect(socket);
        signal.addEventListener("abort", () => sock.destroy(), { once: true });
        sock.on("error", () => {});
        let buf = "";
        sock.on("data", (d: Buffer) => {
          buf += d.toString("utf8");
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.trim()) write("agent", line.startsWith("{") ? line : JSON.stringify({ text: line }));
          }
        });
      })();
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req)) throw new HttpError(401, "unauthorized", "a bearer token is required: Authorization: Bearer <token>", { "www-authenticate": 'Bearer realm="builder"' });
    const u = new URL(req.url ?? "/", "http://api.local");
    const t = /^\/tools\/([^/]+)$/.exec(u.pathname);
    const route: [string, () => unknown] | null =
      u.pathname === "/instance" ? ["GET", () => instance(res)]
      : u.pathname === "/events" ? ["GET", () => events(req, res, u)]
      : u.pathname === "/messages" ? ["POST", () => message(req, res)]
      : t ? ["POST", () => tool(decodeURIComponent(t[1]), req, res)]
      : null;
    if (!route) throw new HttpError(404, "unknown", `no endpoint ${req.method} ${u.pathname} (POST /messages, GET /events, POST /tools/<name>, GET /instance)`);
    if (req.method !== route[0]) throw new HttpError(405, "invalid", `${u.pathname} takes ${route[0]}`, { allow: route[0] });
    await route[1]();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
      send(res, 500, { error: { code: "failed", message: err instanceof Error ? err.message : String(err) } });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(o.settings.port, o.settings.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    throw new Error(`api: cannot listen on ${o.settings.host}:${o.settings.port}: ${(err as Error).message}`);
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.settings.port;
  url = `http://${o.settings.host.includes(":") ? `[${o.settings.host}]` : o.settings.host}:${port}`;
  o.runtime.update(o.runId, { api: url });
  o.journal?.append({ kind: "api.start", data: { url, token: o.settings.token, endpoints: ["POST /messages", "GET /events", "POST /tools/<name>", "GET /instance"] } });
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ac of open) ac.abort();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
