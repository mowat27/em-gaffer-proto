/**
 * The one pi runner. It runs the argv and env that runtime/resolve.ts produced, in one of four modes:
 *
 *   headless     `pi --mode json -p`: pi's raw JSON lines to runs/<id>/log, the halt file stops pi at once, pi is
 *                killed at the budget. The final assistant text is read from the lines (non-JSON output is kept as
 *                text, so a stand-in for pi may print plain text).
 *   interactive  the pi TUI in the launching terminal (stdio inherited). A halt does not kill the TUI: the run ends
 *                when the person quits pi, and the halt file still decides the result.
 *   rpc          `pi --mode rpc`, JSON lines relayed over runs/<id>/control.sock: what a client writes goes to pi's
 *                stdin, every line pi writes goes to every connected client (and the log). The first message, if any,
 *                is sent as a prompt. The run ends when pi settles after done or halt, or settles with no client
 *                connected, or exits. A builder message (runtime/messaging.ts) from a client is handled by the
 *                relay's MessageDesk: journaled and handed to pi as a follow-up prompt.
 *   durable      rpc, long-lived: it does not end when pi settles. Its session is the agent's own state/sessions,
 *                resumed on restart. Messages reach it like an rpc run; its triggers (runtime/triggers.ts) start
 *                turns through the same desk, which the runner hands its caller (onRelay).
 *
 * Outcome protocol (shared/extensions/outcome.ts): $BUILDER_DONE_FILE and $BUILDER_HALT_FILE are in the run's folder.
 * `halt` writes `{ "reason": "..." }`: the run fails with that reason. `done` writes `{ "ok": true, ... }` once its
 * checks pass. A run with a dispatch (a job) whose agent has the done tool is done only when that file exists. Any
 * other run is done when pi exits cleanly, whether or not it has the done tool (an agent may enable outcome only so
 * its children inherit done and halt); done and halt still decide when it calls them.
 *
 * What the runner adds to the resolved argv:
 *   - pinned copies (runtime/pin.ts, D10, E1) of the skills, prompt templates and system prompt files instead of the
 *     agent tree's, with SYSTEM.md and APPEND_SYSTEM.md passed by flag, and PI_CODING_AGENT_DIR at a pinned agent
 *     directory (copies of settings.json and models.json): a definition changed while the run works never reaches it;
 *   - `-e shared:journal` first, right after the discovery-off flags, when the run has a journal, with
 *     $BUILDER_JOURNAL_SOCK (the run's journal socket) and $BUILDER_JOURNAL_FALLBACK. It is the builder's own copy,
 *     never an agent.yml entry, so no agent can drop it;
 *   - ops/pi-extension.ts after the agent's own extensions, when the run's resolved tools include an ops/core tool
 *     that is built (ops/core/index.ts): it registers the run's allowed core tools as pi tools;
 *   - the gate host last, after the agent's own extensions, when the resolved run has gates (runtime/resolve.ts
 *     gateHostFor: its args and env, and its gates file written into the run's folder), so gates judge the input
 *     after every other tool_call handler's rewrite.
 * It journals `agent.start`: the agent.yml and its hash, every resource loaded with its hash, the model and the tools.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isAvailableCoreTool } from "../ops/core/index.ts";
import { FALLBACK_FILE, type JournalWriter } from "./journal.ts";
import { MessageDesk } from "./messaging.ts";
import { pinResources } from "./pin.ts";
import { gateHostFor } from "./resolve.ts";
import { BUILDER_ROOT } from "./root.ts";
import type { Emit, Resolved, Resource, RunResult } from "./types.ts";

/** shared:journal, the builder's own copy: it imports the journal client this runtime speaks to. */
export const JOURNAL_EXTENSION = join(BUILDER_ROOT, "agentics", "shared", "extensions", "journal.ts");

/** The pi adapter of the tool core: loaded for a run whose tools include a built ops/core tool. */
export const PI_EXTENSION = join(BUILDER_ROOT, "ops", "pi-extension.ts");

/** A run that carries a dispatch (a job, or an agent started on one): BUILDER_JOB_ID is set from it (runtime/resolve.ts). */
export const hasDispatch = (r: Pick<Resolved, "env">): boolean => Boolean(r.env.BUILDER_JOB_ID);

/** A run that ends only through done or halt: a run with a dispatch whose agent has the done tool. */
export const requiresDoneFor = (r: Pick<Resolved, "env" | "tools">): boolean => hasDispatch(r) && r.tools.includes("done");

/** Whether the runner loads ops/pi-extension.ts for a run with these tools. */
export const needsCoreTools = (tools: readonly string[]): boolean => tools.some(isAvailableCoreTool);

const DISCOVERY_OFF = /^--no-(skills|extensions|prompt-templates|context-files|mcp|themes)$/;

/**
 * The argv pi runs with: the resolved argv with `first` (shared:journal) right after the discovery-off flags, `last`
 * (the gate host) after the agent's own extensions, and for a headless run `--mode json` before its `-p -- <message>`.
 *
 * Load order is handler order in pi: the journal comes first so it sees every call as the model made it (and still
 * sees calls a gate blocks), the gate host last so its tool_call handlers judge the input after every rewrite.
 */
export function runnerArgv(r: Resolved, first: string[] = [], last: string[] = []): string[] {
  const argv = [...r.argv];
  let lead = 0;
  while (lead < argv.length && DISCOVERY_OFF.test(argv[lead])) lead++;
  let afterExtensions = lead;
  for (let i = lead; i < argv.length - 1; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === "-e") afterExtensions = i + 2;
  }
  argv.splice(afterExtensions, 0, ...last);
  argv.splice(lead, 0, ...first);
  const p = argv.length - 3;
  if (r.mode === "headless" && argv[p] === "-p" && argv[p + 1] === "--") argv.splice(p, 0, "--mode", "json");
  return argv;
}

/** The final assistant text in pi's JSON lines, or null when there are none. */
export function finalText(line: string): string | null {
  if (!line.startsWith("{") || !line.includes('"message_end"')) return null;
  try {
    const e = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (e.type !== "message_end" || e.message?.role !== "assistant") return null;
    const content = e.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("\n");
  } catch {
    return null;
  }
}

/**
 * The error of an assistant turn in pi's JSON lines: the error message when the model call failed (stopReason
 * "error"), "" for a turn that ended normally, null for any other line.
 */
export function turnError(line: string): string | null {
  if (!line.startsWith("{") || !line.includes('"message_end"')) return null;
  try {
    const e = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (e.type !== "message_end" || e.message?.role !== "assistant") return null;
    if (e.message.stopReason !== "error") return "";
    return typeof e.message.errorMessage === "string" && e.message.errorMessage.trim() ? e.message.errorMessage.trim() : "the model call failed";
  } catch {
    return null;
  }
}

const fileHash = (path: string): string => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
};

/** Used when the agent directory's settings.json does not name them (today's defaults). */
export const PI_DEFAULTS = { provider: "openrouter", model: "anthropic/claude-sonnet-5.5", thinking: "low" };

export interface PiSettings {
  provider: string;
  model: string;
  /** off, minimal, low, medium, high, xhigh, max; empty = pi's default. */
  thinking: string;
}

export const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");

/** Pi's live settings file is the single source of provider/model/thinking truth. */
export function piSettings(dir: string): PiSettings {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    return {
      provider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : PI_DEFAULTS.provider,
      model: typeof raw.defaultModel === "string" ? raw.defaultModel : PI_DEFAULTS.model,
      thinking: typeof raw.defaultThinkingLevel === "string" ? raw.defaultThinkingLevel : PI_DEFAULTS.thinking,
    };
  } catch {
    return { ...PI_DEFAULTS };
  }
}

/** The reason in a halt file, or null when there is none yet. */
export function readHalt(file: string): string | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  try {
    const reason = (JSON.parse(raw) as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  } catch {
    /* not JSON: use the text */
  }
  return raw.trim() || "the agent halted the job without a reason";
}

/** Runtime settings a run process keeps; every other BUILDER_* variable it inherited belongs to another run. */
const RUNTIME_VARS = new Set(["BUILDER_RUNS_DIR", "BUILDER_PI_COMMAND", "BUILDER_CONFIG_FILES", "BUILDER_LIMIT", "BUILDER_AGENTICS_DIR"]);

/** The process environment without job variables inherited from an enclosing run, plus `env`. */
export function piEnv(env: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("BUILDER_") || RUNTIME_VARS.has(k)) out[k] = v;
  return { ...out, ...env };
}

/** Where the control socket listens: runs/<id>/control.sock, or a short path in the temp dir (linked from there) when that is too long for a Unix socket. */
export function controlSocketPaths(runDir: string): { listen: string; link?: string } {
  const direct = join(runDir, "control.sock");
  if (Buffer.byteLength(direct) <= 100) return { listen: direct };
  return { listen: join(tmpdir(), `builder-${createHash("sha1").update(runDir).digest("hex").slice(0, 12)}.sock`), link: direct };
}

export interface PiRunOptions {
  /** The pi executable. */
  command: string;
  resolved: Resolved;
  /** The run's folder: sessions/, halt.json, done.json and log live here. */
  runDir: string;
  cwd: string;
  /** pi's environment on top of the process's: the resolved env plus what is known only at start (BUILDER_BASE). */
  env: Record<string, string>;
  budgetMinutes?: number;
  /** Aborts when the run is stopped: pi gets SIGTERM, then SIGKILL after 3 s. */
  signal: AbortSignal;
  emit: Emit;
  /** rpc and durable: called with the socket path once clients can connect. */
  onSocket?(path: string): void;
  /** rpc and durable: the relay's message desk, once pi has been started (triggers deliver their turns through it). */
  onRelay?(desk: MessageDesk): void;
  /** The run's journal: loads shared:journal and receives agent.start. */
  journal?: JournalWriter | null;
}

interface PiExit {
  code: number | null;
  timedOut: boolean;
  halt: string | null;
  stopped: boolean;
  /** stderr and stdout lines that are not pi's JSON, in arrival order (the end of it explains a failure). */
  output: string;
  /** Headless: the last assistant message's text, when pi spoke JSON. */
  final: string | null;
  /** Headless: the error of the last assistant turn when the model call failed (stopReason "error"), else "". */
  turnError: string;
}

const show = (args: string[]) => args.map((a) => (/\s/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");

/**
 * What the runner adds for this run: extension flags (`first` before the agent's extensions, `last` after them),
 * environment, and the resources they load (for agent.start).
 */
function runnerExtras(o: PiRunOptions): { first: string[]; last: string[]; env: Record<string, string>; resources: Resource[] } {
  const first: string[] = [];
  const last: string[] = [];
  const env: Record<string, string> = {};
  const resources: Resource[] = [];
  if (o.journal) {
    first.push("-e", JOURNAL_EXTENSION);
    env.BUILDER_JOURNAL_FALLBACK = join(o.runDir, FALLBACK_FILE);
    if (o.journal.socketPath) env.BUILDER_JOURNAL_SOCK = o.journal.socketPath;
    resources.push({ kind: "extension", ref: "shared:journal", path: JOURNAL_EXTENSION, sha256: fileHash(JOURNAL_EXTENSION) });
  }
  if (o.resolved.agent && needsCoreTools(o.resolved.tools)) {
    last.push("-e", PI_EXTENSION);
    resources.push({ kind: "extension", ref: "ops:pi-extension", path: PI_EXTENSION, sha256: fileHash(PI_EXTENSION) });
  }
  // BUILDER_BASE is known only now (the workspace's HEAD at start): the gate context needs it.
  const host = gateHostFor({ ...o.resolved, env: { ...o.resolved.env, ...o.env } });
  if (host) {
    mkdirSync(dirname(host.file.path), { recursive: true });
    writeFileSync(host.file.path, JSON.stringify(host.file.json, null, 2) + "\n");
    last.push(...host.args);
    Object.assign(env, host.env);
    for (let i = 0; i < host.args.length - 1; i++) {
      if (host.args[i] === "-e") resources.push({ kind: "extension", ref: "runtime:gate-host", path: host.args[i + 1], sha256: fileHash(host.args[i + 1]) });
    }
  }
  return { first, last, env, resources };
}

/** Run pi once in the resolved mode and turn how it ended into the run's result. */
export async function runPi(o: PiRunOptions): Promise<RunResult> {
  const resolved = o.resolved;
  const live = resolved.settings ?? { ...PI_DEFAULTS };
  const haltFile = join(o.runDir, "halt.json");
  const doneFile = join(o.runDir, "done.json");
  const logFile = join(o.runDir, "log");
  // D10, E1: skills, prompts, the system prompt files and the agent's settings are read from copies made now.
  const pin = resolved.agent ? pinResources(resolved, o.runDir) : null;
  const base: Resolved = pin ? { ...resolved, argv: pin.argv } : resolved;
  const extras = runnerExtras({ ...o, resolved: base });
  const r: Resolved = { ...base, argv: runnerArgv(base, extras.first, extras.last) };
  const env = { ...o.env, ...(pin?.env ?? {}), ...extras.env };
  const shownArgs = r.mode === "headless" || r.mode === "interactive" ? r.argv.map((a, i) => (i === r.argv.length - 1 && a === r.message ? "<prompt>" : a)) : r.argv;
  o.emit("pi.start", `pi ${live.provider}/${live.model}${live.thinking ? ` (thinking ${live.thinking})` : ""}, ${r.mode}`, { command: o.command, args: shownArgs, mode: r.mode });
  if (r.agent) {
    o.journal?.append({
      kind: "agent.start",
      data: {
        agentYml: join(r.agent.dir, "agent.yml"),
        ymlHash: r.agent.ymlHash,
        defaults: r.agent.defaults,
        resources: [...(pin?.resources ?? r.resources), ...extras.resources].map((x: Resource & { pinned?: string; pinnedSha256?: string }) => ({
          kind: x.kind,
          ref: x.ref,
          path: x.path,
          sha256: x.sha256,
          ...(x.pinned ? { pinned: x.pinned, ...(x.pinnedSha256 ? { pinnedSha256: x.pinnedSha256 } : {}) } : {}),
        })),
        model: `${live.provider}/${live.model}`,
        thinking: live.thinking,
        tools: r.tools,
        mode: r.mode,
        cwd: o.cwd,
        command: o.command,
        args: shownArgs,
      },
    });
  }
  appendFileSync(logFile, `\n$ ${o.command} ${show(shownArgs)}\n(in ${o.cwd})\n--- prompt ---\n${r.message ?? "(none)"}\n--- output ---\n`);
  rmSync(haltFile, { force: true });
  rmSync(doneFile, { force: true });
  const log = (text: string) => {
    try {
      appendFileSync(logFile, text);
    } catch {
      /* ignore */
    }
  };

  const pi = await new Promise<PiExit>((resolveRun) => {
    let output = "";
    let final: string | null = null;
    let lastTurnError = "";
    let timedOut = false;
    let stopped = false;
    let halt: string | null = null;
    const interactive = r.mode === "interactive";
    const relay = r.mode === "rpc" || r.mode === "durable";
    const child: ChildProcess = spawn(expandHome(o.command), r.argv, {
      cwd: o.cwd,
      env: piEnv(env),
      stdio: interactive ? "inherit" : [relay ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const kill = (afterMs: number) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), afterMs).unref();
    };
    // The agent called the halt tool: stop pi now rather than waiting for it to finish its turn. A person at the TUI
    // ends an interactive run themselves.
    const watch = setInterval(() => {
      if (halt || interactive) return;
      halt = readHalt(haltFile);
      if (!halt) return;
      o.emit("pi.halt", `agent halted the job: ${halt.slice(0, 200)}`, { reason: halt });
      kill(5000);
    }, 500);

    const relayState = relay ? startRelay(o, child, log, () => halt !== null || existsSync(doneFile)) : null;
    // Headless: the log keeps pi's raw stdout. Its JSON lines give the final text (split on LF only: Unicode line
    // separators are valid inside JSON strings); anything else it prints, and stderr, is the run's text output.
    let partial = "";
    const onLine = (line: string) => {
      const text = finalText(line);
      if (text !== null) final = text;
      const err = turnError(line);
      if (err !== null) lastTurnError = err;
      else if (!(line.startsWith("{") && line.endsWith("}"))) output += `${line}\n`;
    };
    if (!relay && !interactive) {
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        log(text);
        partial += text;
        for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
          onLine(partial.slice(0, nl).replace(/\r$/, ""));
          partial = partial.slice(nl + 1);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output += text;
        log(text);
      });
    }
    const timer =
      o.budgetMinutes !== undefined
        ? setTimeout(
            () => {
              timedOut = true;
              kill(5000);
            },
            Math.max(1, o.budgetMinutes) * 60_000,
          )
        : undefined;
    const onStop = () => {
      stopped = true;
      kill(3000);
    };
    o.signal.addEventListener("abort", onStop, { once: true });
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(watch);
      relayState?.close();
      o.signal.removeEventListener("abort", onStop);
      // pi may write the file and exit between two polls.
      halt = halt ?? readHalt(haltFile);
      if (partial) onLine(partial);
      resolveRun({ code, timedOut, halt, stopped, output: relayState ? relayState.stderr() : output, final, turnError: lastTurnError });
    };
    child.on("error", (err) => {
      output += `\nspawn error: ${err.message}`;
      log(`\nspawn error: ${err.message}\n`);
      finish(-1);
    });
    // A halted or stopped pi is done when it exits: a leftover grandchild may hold the pipes open.
    child.on("exit", (code) => {
      if (halt || stopped || interactive) finish(code);
    });
    child.on("close", finish);
    if (o.signal.aborted) onStop();
  });

  // A halt is the agent's own verdict on the slice: it wins over however pi exited.
  if (pi.halt) return { outcome: "failed", reason: pi.halt, halted: true };
  if (pi.stopped) return { outcome: "failed", reason: "stopped" };
  if (pi.timedOut) return { outcome: "failed", reason: `pi timed out after ${o.budgetMinutes} min` };
  if (pi.code !== 0) return { outcome: "failed", reason: `pi exited ${pi.code}${pi.output.trim() ? `: ${pi.output.trim().slice(-400)}` : ""}` };
  const said = (pi.final ?? pi.output).trim();
  const lastLine = said.split("\n").pop()?.trim() ?? "";
  o.emit("pi.done", `pi finished: ${lastLine.slice(0, 120)}`, lastLine ? { said: lastLine.slice(0, 200) } : {});
  // A job hands the work over with done; without it there is no verdict to send. Any other run is done when pi exits
  // cleanly, whatever tools it has (an agent may enable outcome only for the children it starts).
  const requiresDone = requiresDoneFor(r);
  if (requiresDone && !existsSync(doneFile)) return { outcome: "failed", reason: "the agent finished without calling done" };
  // Any other run whose last model call failed did not finish its work, whatever pi's exit code says (G1).
  if (!requiresDone && !existsSync(doneFile) && pi.turnError) return { outcome: "failed", reason: `the model call failed: ${pi.turnError.slice(0, 400)}` };
  let done: unknown = null;
  try {
    done = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, "utf8")) : null;
  } catch {
    /* the file's existence is the verdict */
  }
  return { outcome: "done", data: { done, pi: live, ...(!requiresDone && r.mode === "headless" ? { output: said.slice(-4000) } : {}) } };
}

/**
 * The rpc relay: a Unix socket server for clients, pi's stdout split into JSON lines (on LF only: Unicode line
 * separators are valid inside JSON strings), the first message sent as a prompt, builder messages through the desk,
 * and the end-of-run rule.
 */
function startRelay(o: PiRunOptions, child: ChildProcess, log: (t: string) => void, outcomeGiven: () => boolean): { close(): void; stderr(): string } {
  const clients = new Set<Socket>();
  const paths = controlSocketPaths(o.runDir);
  let stderr = "";
  let ending = false;
  const toPi = (line: string) => {
    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  };
  const desk = new MessageDesk({ toPi, journal: o.journal ?? null });
  const end = (why: string) => {
    if (ending) return;
    ending = true;
    log(`\n[builder] ending the rpc run: ${why}\n`);
    child.stdin?.end();
    setTimeout(() => child.kill("SIGTERM"), 10_000).unref();
  };
  const server: Server = createServer((sock) => {
    clients.add(sock);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.trim() && !desk.fromClient(line, (answer) => sock.writable && sock.write(`${answer}\n`))) toPi(line);
      }
    });
    sock.on("close", () => clients.delete(sock));
    sock.on("error", () => clients.delete(sock));
  });
  rmSync(paths.listen, { force: true });
  server.listen(paths.listen, () => {
    if (paths.link) {
      rmSync(paths.link, { force: true });
      try {
        symlinkSync(paths.listen, paths.link);
      } catch {
        /* the record names the socket anyway */
      }
    }
    o.onSocket?.(paths.listen);
  });
  child.stdin?.on("error", () => {});
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
    for (let nl = out.indexOf("\n"); nl >= 0; nl = out.indexOf("\n")) {
      const line = out.slice(0, nl).replace(/\r$/, "");
      out = out.slice(nl + 1);
      log(`${line}\n`);
      desk.fromPi(line);
      for (const c of clients) c.write(`${line}\n`);
      if (o.resolved.mode !== "rpc" || !line.includes("agent_settled")) continue;
      let event: { type?: unknown } = {};
      try {
        event = JSON.parse(line) as { type?: unknown };
      } catch {
        continue;
      }
      if (event.type !== "agent_settled") continue;
      if (outcomeGiven()) end("the agent settled after done or halt");
      else if (clients.size === 0) end("the agent settled and no client is connected");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = (stderr + text).slice(-4000);
    log(text);
  });
  if (o.resolved.message !== undefined) toPi(JSON.stringify({ id: "builder-start", type: "prompt", message: o.resolved.message }));
  try {
    o.onRelay?.(desk);
  } catch {
    /* the caller's own bookkeeping */
  }
  return {
    close() {
      desk.close();
      for (const c of clients) c.end();
      server.close();
      rmSync(paths.listen, { force: true });
      if (paths.link) rmSync(paths.link, { force: true });
    },
    stderr: () => stderr,
  };
}
