#!/usr/bin/env node
/**
 * The build server (Appendix A, "Builder implementation notes"), prototype edition: runs locally, one job at a time.
 *
 *   POST /slices   dispatch (202 accepted, 400 malformed, 422 { missing }, 503 + Retry-After while busy)
 *   GET  /status   what it is doing, and the pi configuration it will use for the next job
 *   GET  /health   200 ok
 *
 * Each job: a fresh clone of the target repository at `repo.base` under <workspaceDir>/<jobId>, the app directory
 * (`appDir`, where package.json and src/ are) set up, the `pi` agent run in the app directory, a commit on top of
 * base, `git format-patch <base>..HEAD` sent to the callback. The builder has read access to the repository only and
 * no board access.
 *
 * Setup: before pi starts, the builder runs `setupCommands` (npm ci) and then `baseCheckCommands` (npx tsc --noEmit)
 * in the app directory. A base without package.json, package-lock.json or tsconfig.json there, or one where a command
 * fails, fails the job with "target repository is not set up: ..." and pi never starts. The agent never installs.
 *
 * Workspaces: the newest `keepWorkspaces` job workspaces are kept after a job, for debugging (the log of every job
 * is kept regardless); older ones are deleted.
 *
 * Halting: pi gets $BUILDER_HALT_FILE, a path outside the workspace. The agent's `halt` tool writes
 * `{ "reason": "..." }` there when the slice cannot be built. The builder stops pi as soon as the file appears and
 * sends `{ "outcome": "failed", "reason": <reason> }` instead of a patch.
 *
 * Finishing: pi gets $BUILDER_DONE_FILE and $BUILDER_BASE. The agent's `done` tool (pi-agent/extensions/done/) runs
 * the build kit's slice commit-scope checks, in the app directory, on the changes since base and writes the done file
 * when they pass. The builder sends a patch only when that file exists, and runs the same checks again first.
 * `.slice.json` (written into the app directory), `node_modules/` and `.scratch/` (the agent's throwaway scripts) are
 * excluded through .git/info/exclude, so they never land in the patch.
 *
 * Job context: pi also gets the job's facts as BUILDER_* variables (job id, slice id, title, context, attempt, slice
 * file, base). The job-context extension adds them to the agent's system prompt. The /build arguments
 * still carry the same values.
 *
 * Configuration is the JSON file named by $BUILDER_CONFIG (the factory's builder layer writes it from its settings).
 * The file is re-read at the start of every job, so a changed pi configuration applies to the next build. Progress is
 * appended as JSON lines to `eventsFile`. Runs on Node 24 type stripping: only erasable TypeScript syntax is used.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { jobLabel, jobName } from "./job-name.ts";
import { allChanges, builderExceptions, formatViolations, runChecks, SLICE_FILE } from "./pi-agent/extensions/done/checks.ts";

export interface PiConfig {
  /** The pi executable ("pi", or an absolute path). */
  command: string;
  /**
   * pi's agent directory (PI_CODING_AGENT_DIR): settings.json, AGENTS.md, prompts/, extensions/, skills/.
   * Empty = pi's default ~/.pi/agent. Standing instructions and the prompt template live as plain files in this
   * directory, edited directly (read/edit/write) like any other project file: no settings blob, no page copy.
   */
  agentDir: string;
  provider: string;
  model: string;
  /** off, minimal, low, medium, high, xhigh, max; empty = pi's default. */
  thinking: string;
  /** Extra flags, shell-style (quotes respected), placed before -p. */
  args: string;
  timeoutMinutes: number;
}

export interface BuilderConfig {
  host: string;
  port: number;
  workspaceDir: string;
  /** `requires` entries this builder satisfies besides `repo:*` (for example "stack:stub"). */
  capabilities: string[];
  jobTimeoutMinutes: number;
  /** The app inside the clone, where package.json, tsconfig.json and src/ are; pi runs here ("" or "." = the clone root). */
  appDir: string;
  /** Run in the app directory before pi starts, in order. A failure fails the job. */
  setupCommands: string[];
  /** Run in the app directory after setup: the base must pass them. A failure fails the job. */
  baseCheckCommands: string[];
  setupTimeoutMinutes: number;
  /** How many job workspaces to keep after a job (the newest). 0 deletes each workspace when its job ends. */
  keepWorkspaces: number;
  /** How many times to retry the callback (backoff 1, 2, 4 ... seconds, capped at 30). */
  callbackRetries: number;
  eventsFile?: string;
  pi: PiConfig;
}

interface Dispatch {
  requires: string[];
  repo: { url: string; base: string };
  task: { sliceId: string; title: string; context: string; handover: boolean; attempt: number };
  slice: unknown;
  callback: string;
}

interface Job {
  jobId: string;
  title: string;
  context: string;
  attempt: number;
  startedAt: number;
  step: string;
  workspace: string;
  logFile: string;
  /** Where the agent's halt tool writes `{ reason }` to halt the job (outside the workspace). */
  haltFile: string;
  /** Where the agent's done tool writes `{ ok: true }` once the checks pass (outside the workspace). */
  doneFile: string;
}

export function defaultConfig(): BuilderConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    workspaceDir: "builder/jobs",
    capabilities: ["stack:stub"],
    jobTimeoutMinutes: 20,
    appDir: ".",
    setupCommands: ["npm ci"],
    baseCheckCommands: ["npx tsc --noEmit"],
    setupTimeoutMinutes: 10,
    keepWorkspaces: 3,
    callbackRetries: 8,
    pi: {
      // The pi binary itself: the factory already runs under the vault wrapper, and the `pi` shell wrapper (av pi)
      // nested inside it swallows the agent's output.
      command: "~/.pi/agent/bin/pi",
      // builder/pi-agent/models.json puts Sonnet 5.5 on OpenRouter's OpenAI-compatible API, so the key travels as
      // Authorization: Bearer and the vault proxy can swap the real one in (the anthropic-messages API uses x-api-key).
      agentDir: "builder/pi-agent",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      thinking: "low",
      // Context files, prompt templates, extensions and skills stay on: AGENTS.md, prompts/build.md and
      // anything dropped into extensions/ or skills/ in the agent dir are meant to load.
      args: "--no-session --no-mcp --no-themes",
      timeoutMinutes: 10,
    },
  };
}

const configFile = process.env.BUILDER_CONFIG ? resolve(process.env.BUILDER_CONFIG) : "";

function loadConfig(): BuilderConfig {
  const d = defaultConfig();
  if (!configFile || !existsSync(configFile)) return d;
  const raw = JSON.parse(readFileSync(configFile, "utf8")) as Partial<BuilderConfig> & { pi?: Partial<PiConfig> };
  return { ...d, ...raw, pi: { ...d.pi, ...(raw.pi ?? {}) } };
}

let cfg = loadConfig();
let current: Job | null = null;
let lastJob: (Job & { outcome: string; endedAt: number }) | null = null;

function emit(kind: string, msg: string, data: Record<string, unknown> = {}): void {
  console.log(`[builder] ${msg}`);
  if (!cfg.eventsFile) return;
  const event = { ts: new Date().toISOString(), source: "builder", kind, msg, jobId: current?.jobId, name: current ? jobName(current.jobId) : undefined, slice: current?.title, ...data };
  try {
    appendFileSync(cfg.eventsFile, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error(`[builder] could not append to ${cfg.eventsFile}: ${(err as Error).message}`);
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** `git@github.com:org/app.git` or `https://github.com/org/app.git` -> `github.com/org/app`. */
function repoKey(url: string): string {
  let s = url.trim().replace(/\.git$/, "");
  const ssh = /^[^@]+@([^:]+):(.+)$/.exec(s);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.replace(/^[^@]+@/, "");
  return s;
}

/** Shell-style split: whitespace separates, single or double quotes group. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function validate(body: unknown): { ok: true; d: Dispatch } | { ok: false; error: string } {
  const b = body as Partial<Dispatch> | null;
  if (!b || typeof b !== "object") return { ok: false, error: "body must be a JSON object" };
  if (!Array.isArray(b.requires) || !b.requires.every((r) => typeof r === "string")) return { ok: false, error: "requires must be a string array" };
  if (!b.repo || typeof b.repo.url !== "string" || typeof b.repo.base !== "string" || !/^[0-9a-f]{7,40}$/.test(b.repo.base)) {
    return { ok: false, error: "repo.url and repo.base (a commit sha) are required" };
  }
  const t = b.task;
  if (!t || typeof t.sliceId !== "string" || typeof t.title !== "string" || typeof t.context !== "string") {
    return { ok: false, error: "task.sliceId, task.title and task.context are required" };
  }
  if (typeof b.callback !== "string" || !/^https?:\/\/.+\/jobs\/[^/]+$/.test(b.callback)) return { ok: false, error: "callback must be an http(s) URL ending in /jobs/<jobId>" };
  return {
    ok: true,
    d: {
      requires: b.requires,
      repo: { url: b.repo.url, base: b.repo.base },
      task: { sliceId: t.sliceId, title: t.title, context: t.context, handover: !!t.handover, attempt: Number(t.attempt ?? 1) || 1 },
      slice: b.slice ?? null,
      callback: b.callback,
    },
  };
}

function missingRequirements(d: Dispatch): string[] {
  const missing: string[] = [];
  const key = repoKey(d.repo.url);
  for (const r of d.requires) {
    if (r.startsWith("repo:")) {
      if (r.slice(5).replace(/\.git$/, "") !== key) missing.push(r);
    } else if (!cfg.capabilities.includes(r)) missing.push(r);
  }
  const probe = spawnSync("git", ["ls-remote", "--exit-code", "--heads", d.repo.url], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) missing.push(`repo:${key} (cannot reach ${d.repo.url}: ${(probe.stderr || "").trim().slice(0, 200)})`);
  return missing;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout || "").trim().slice(0, 500)}`);
  return (res.stdout || "").trim();
}

/** The app inside a job's clone: where setup runs, pi runs and the checks run. */
function appRootOf(job: Job): string {
  return join(job.workspace, cfg.appDir);
}

/** Run a shell command without blocking the server; its output goes to the job log. */
function runShell(command: string, cwd: string, timeoutMs: number, logFile: string): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
  return new Promise((resolveRun) => {
    let tail = "";
    let timedOut = false;
    appendFileSync(logFile, `\n$ ${command}  (in ${cwd})\n`);
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-2000);
      try {
        appendFileSync(logFile, text);
      } catch {
        /* ignore */
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: -1, timedOut, tail: `${tail}\nspawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, timedOut, tail });
    });
  });
}

/**
 * Get the app directory ready for the agent: it has the files a Node app needs, its dependencies install, and the
 * base passes the base checks. Throws "target repository is not set up: ..." otherwise, so pi never starts on a base
 * that cannot build.
 */
async function setupApp(job: Job, d: Dispatch): Promise<void> {
  const appRoot = appRootOf(job);
  const short = d.repo.base.slice(0, 12);
  const where = cfg.appDir && cfg.appDir !== "." ? `${cfg.appDir}/` : "";
  if (!existsSync(appRoot)) throw new Error(`target repository is not set up: ${where || "the app directory"} missing at base ${short}`);
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
    if (!existsSync(join(appRoot, file))) throw new Error(`target repository is not set up: ${where}${file} missing at base ${short}`);
  }
  emit("setup.start", `setting up ${where || "."}: ${[...cfg.setupCommands, ...cfg.baseCheckCommands].join(", ")}`);
  for (const command of [...cfg.setupCommands, ...cfg.baseCheckCommands]) {
    const res = await runShell(command, appRoot, Math.max(1, cfg.setupTimeoutMinutes) * 60_000, job.logFile);
    if (res.code !== 0) {
      const why = res.timedOut ? `timed out after ${cfg.setupTimeoutMinutes} min` : `failed`;
      const reason = `target repository is not set up: \`${command}\` ${why} at base ${short}: ${res.tail.trim().slice(-400)}`;
      emit("setup.fail", reason, { command });
      throw new Error(reason);
    }
  }
  emit("setup.ok", "dependencies installed and the base builds");
}

/**
 * Keep the newest `keep` job workspaces (the current one counts); delete the rest. The logs directory is never touched.
 * Deleting is asynchronous: a workspace holds node_modules, and removing it must not stall the server's HTTP answers.
 */
function pruneWorkspaces(wsRoot: string, current: string, keep: number): void {
  try {
    const drop = (path: string) => void rm(path, { recursive: true, force: true }).catch((err: Error) => emit("cleanup.warn", `could not delete ${path}: ${err.message}`));
    if (keep <= 0) {
      drop(current);
      return;
    }
    const others = readdirSync(wsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "logs" && join(wsRoot, e.name) !== current)
      .map((e) => ({ path: join(wsRoot, e.name), mtime: statSync(join(wsRoot, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of others.slice(keep - 1)) drop(old.path);
  } catch (err) {
    emit("cleanup.warn", `could not prune workspaces: ${(err as Error).message}`);
  }
}

/** Shell-like quoting for a `/build` argument: pi's prompt-template parser respects quotes the same way a shell does. */
function quoteArg(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}


/** Pi's live settings file is the single source of provider/model/thinking truth. */
function livePiSettings(pi: PiConfig): Pick<PiConfig, "provider" | "model" | "thinking"> {
  const dir = pi.agentDir ? resolve(pi.agentDir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : "";
  try {
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    return {
      provider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : pi.provider,
      model: typeof raw.defaultModel === "string" ? raw.defaultModel : pi.model,
      thinking: typeof raw.defaultThinkingLevel === "string" ? raw.defaultThinkingLevel : pi.thinking,
    };
  } catch {
    return { provider: pi.provider, model: pi.model, thinking: pi.thinking };
  }
}

/** The reason in a halt file, or null when there is none yet. */
function readHalt(file: string): string | null {
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

function runPi(job: Job, d: Dispatch): Promise<{ code: number | null; timedOut: boolean; halt: string | null; output: string }> {
  const pi = cfg.pi;
  const command = pi.command.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  const agentDir = pi.agentDir ? resolve(pi.agentDir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : "";
  const live = livePiSettings(pi);
  // The full slice spec (commands, events, readmodels, screens, specifications) as sent by the gaffer: written into
  // the app directory so the agent can read it with a plain relative path (pi's cwd is the app directory). Removed
  // first so a tracked file or symlink of that name is replaced, never written through.
  const sliceFile = join(appRootOf(job), SLICE_FILE);
  rmSync(sliceFile, { force: true });
  writeFileSync(sliceFile, JSON.stringify(d.slice ?? null, null, 2));
  // The `/build` prompt template (builder/pi-agent/prompts/build.md, a real file, edited directly) expands $1..
  // itself; this is the same `/name arg1 arg2` a human types in an interactive pi session.
  const prompt = [
    "/build",
    // The slice spec is deliberately first: it is the primary input to every build.
    quoteArg(SLICE_FILE),
    quoteArg(d.task.title),
    quoteArg(d.task.context),
    quoteArg(d.task.sliceId),
    quoteArg(String(d.task.attempt)),
    quoteArg(d.repo.base),
    quoteArg(pi.model),
    quoteArg(new Date().toISOString()),
  ].join(" ");
  const args = [...splitArgs(pi.args), "--provider", live.provider, "--model", live.model, ...(live.thinking ? ["--thinking", live.thinking] : []), "-p", "--", prompt];
  emit("pi.start", `pi ${live.provider}/${live.model}${live.thinking ? ` (thinking ${live.thinking})` : ""}`, {
    command: pi.command,
    args: args.slice(0, -1),
  });
  appendFileSync(job.logFile, `\n$ ${pi.command} ${args.slice(0, -1).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")} -- <prompt>\n--- prompt ---\n${prompt}\n--- output ---\n`);
  rmSync(job.haltFile, { force: true });
  rmSync(job.doneFile, { force: true });
  return new Promise((resolveRun) => {
    let output = "";
    let timedOut = false;
    let halt: string | null = null;
    const child = spawn(command, args, {
      cwd: appRootOf(job),
      env: {
        ...process.env,
        PI_NO_UPDATE_CHECK: "1",
        BUILDER_HALT_FILE: job.haltFile,
        BUILDER_DONE_FILE: job.doneFile,
        // Job context: pi-agent/extensions/job-context.ts puts these in the agent's system prompt.
        BUILDER_JOB_ID: job.jobId,
        BUILDER_SLICE_ID: d.task.sliceId,
        BUILDER_SLICE_TITLE: d.task.title,
        BUILDER_SLICE_CONTEXT: d.task.context,
        BUILDER_ATTEMPT: String(d.task.attempt),
        BUILDER_SLICE_FILE: SLICE_FILE,
        BUILDER_BASE: d.repo.base,
        ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The agent called the halt tool: stop pi now rather than waiting for it to finish its turn.
    const watch = setInterval(() => {
      if (halt) return;
      halt = readHalt(job.haltFile);
      if (!halt) return;
      emit("pi.halt", `agent halted the job: ${halt.slice(0, 200)}`, { reason: halt });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, 500);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      try {
        appendFileSync(job.logFile, text);
      } catch {
        /* ignore */
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      },
      Math.max(1, pi.timeoutMinutes) * 60_000,
    );
    child.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(watch);
      output += `\nspawn error: ${err.message}`;
      resolveRun({ code: -1, timedOut, halt, output });
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      clearInterval(watch);
      // pi may write the file and exit between two polls.
      halt = halt ?? readHalt(job.haltFile);
      resolveRun({ code, timedOut, halt, output });
    };
    // A halted pi is done when it exits: a leftover grandchild (a bash tool command) may hold the pipes open.
    child.on("exit", (code) => {
      if (halt) finish(code);
    });
    child.on("close", finish);
  });
}

async function postCallback(job: Job, url: string, body: unknown): Promise<void> {
  for (let i = 0; i <= cfg.callbackRetries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 204) {
        emit("callback.ok", "result accepted by the gaffer (204)");
        return;
      }
      if (res.status === 410) {
        emit("callback.gone", "gaffer answered 410: result discarded");
        return;
      }
      emit("callback.retry", `callback answered HTTP ${res.status}, retrying`, { status: res.status, try: i + 1 });
    } catch (err) {
      emit("callback.retry", `callback failed: ${(err as Error).message}, retrying`, { try: i + 1 });
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** i)));
  }
  emit("callback.abandoned", `callback to ${url} abandoned after ${cfg.callbackRetries + 1} tries`);
}

async function runJob(job: Job, d: Dispatch): Promise<void> {
  const deadline = job.startedAt + cfg.jobTimeoutMinutes * 60_000;
  const step = (s: string) => {
    job.step = s;
  };
  let result: { outcome: "done"; patch: string } | { outcome: "failed"; reason: string };
  try {
    step("clone");
    rmSync(job.workspace, { recursive: true, force: true });
    mkdirSync(job.workspace, { recursive: true });
    emit("clone", `cloning ${repoKey(d.repo.url)} at ${d.repo.base.slice(0, 12)}`);
    git(job.workspace, ["clone", "-q", d.repo.url, "."]);
    try {
      git(job.workspace, ["checkout", "-q", d.repo.base]);
    } catch (err) {
      throw new Error(`base ${d.repo.base} is not in the repository: ${(err as Error).message}`);
    }
    git(job.workspace, ["checkout", "-q", "-B", "job", d.repo.base]);
    git(job.workspace, ["config", "user.name", "builder"]);
    git(job.workspace, ["config", "user.email", "builder@gaffer.local"]);
    // Never in the patch: the slice spec written for the agent, installed dependencies, the agent's scratch scripts.
    appendFileSync(join(job.workspace, ".git", "info", "exclude"), `\n${SLICE_FILE}\nnode_modules/\n.scratch/\n`);

    step("setup");
    await setupApp(job, d);
    if (Date.now() > deadline) throw new Error(`job exceeded ${cfg.jobTimeoutMinutes} min during setup`);

    step("pi");
    const pi = await runPi(job, d);
    // A halt is the agent's own verdict on the slice: it wins over however pi exited, and any changes are dropped.
    if (pi.halt) throw new Error(pi.halt);
    if (pi.timedOut) throw new Error(`pi timed out after ${cfg.pi.timeoutMinutes} min`);
    if (pi.code !== 0) throw new Error(`pi exited ${pi.code}: ${pi.output.trim().slice(-400)}`);
    emit("pi.done", `pi finished: ${pi.output.trim().split("\n").pop()?.slice(0, 120) ?? ""}`);
    if (Date.now() > deadline) throw new Error(`job exceeded ${cfg.jobTimeoutMinutes} min`);
    // The agent hands the work over with its done tool; without it there is no verdict to send.
    if (!existsSync(job.doneFile)) throw new Error("the agent finished without calling done");
    step("checks");
    const violations = runChecks(appRootOf(job), allChanges(appRootOf(job), d.repo.base), builderExceptions());
    if (violations.length) throw new Error(`slice commit-scope checks failed after done:\n${formatViolations(violations)}`);

    step("commit");
    const dirty = git(job.workspace, ["status", "--porcelain"]);
    if (dirty) {
      git(job.workspace, ["add", "-A"]);
      git(job.workspace, ["commit", "-q", "-m", `build: ${d.task.context}/${d.task.title} (stub, attempt ${d.task.attempt})`]);
    }
    const count = Number(git(job.workspace, ["rev-list", "--count", `${d.repo.base}..HEAD`]));
    if (!count) throw new Error("the agent produced no changes");
    const patch = git(job.workspace, ["format-patch", "--stdout", `${d.repo.base}..HEAD`]);
    emit("patch", `${count} commit(s), patch ${patch.length} bytes`, { commits: count, bytes: patch.length });
    result = { outcome: "done", patch };
  } catch (err) {
    const reason = (err as Error).message;
    emit("job.failed", reason, { reason });
    result = { outcome: "failed", reason };
  }

  step("callback");
  emit("callback", `POST ${d.callback} (${result.outcome})`);
  await postCallback(job, d.callback, result);

  step("cleanup");
  pruneWorkspaces(resolve(cfg.workspaceDir), job.workspace, cfg.keepWorkspaces);
  rmSync(job.haltFile, { force: true });
  rmSync(job.doneFile, { force: true });
  lastJob = { ...job, outcome: result.outcome, endedAt: Date.now() };
  current = null;
  emit("job.end", `job ${jobLabel(job.jobId)} ${result.outcome} in ${Math.round((Date.now() - job.startedAt) / 1000)}s`, { outcome: result.outcome, name: jobName(job.jobId) });
}

function status(): Record<string, unknown> {
  // Report the configuration the next job will use, not the one the last job loaded.
  if (!current) cfg = loadConfig();
  const pi = cfg.pi;
  return {
    ok: true,
    busy: !!current,
    job: current ? { jobId: current.jobId, name: jobName(current.jobId), title: current.title, context: current.context, attempt: current.attempt, step: current.step, startedAt: current.startedAt } : null,
    lastJob: lastJob ? { jobId: lastJob.jobId, name: jobName(lastJob.jobId), title: lastJob.title, outcome: lastJob.outcome, endedAt: lastJob.endedAt } : null,
    capabilities: cfg.capabilities,
    pi: { command: pi.command, agentDir: pi.agentDir, ...livePiSettings(pi), args: pi.args },
    workspaceDir: resolve(cfg.workspaceDir),
    pid: process.pid,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/status") return json(res, 200, status());
  if (req.method === "POST" && url.pathname === "/slices") {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
    const v = validate(body);
    if (!v.ok) {
      emit("reject", `400: ${v.error}`);
      return json(res, 400, { error: v.error });
    }
    if (current) {
      emit("busy", `503: busy with job ${jobLabel(current.jobId)}`);
      return json(res, 503, { error: "busy", jobId: current.jobId }, { "retry-after": "15" });
    }
    cfg = loadConfig();
    const missing = missingRequirements(v.d);
    if (missing.length) {
      emit("reject", `422: cannot meet ${missing.join(", ")}`, { missing });
      return json(res, 422, { missing });
    }
    const jobId = v.d.callback.split("/").pop() as string;
    const wsRoot = resolve(cfg.workspaceDir);
    mkdirSync(join(wsRoot, "logs"), { recursive: true });
    const job: Job = {
      jobId,
      title: v.d.task.title,
      context: v.d.task.context,
      attempt: v.d.task.attempt,
      startedAt: Date.now(),
      step: "accepted",
      workspace: join(wsRoot, jobId),
      logFile: join(wsRoot, "logs", `${jobId}.log`),
      haltFile: join(wsRoot, "logs", `${jobId}.halt.json`),
      doneFile: join(wsRoot, "logs", `${jobId}.done.json`),
    };
    writeFileSync(job.logFile, `job ${jobName(jobId)} (${jobId}): ${v.d.task.context}/${v.d.task.title} attempt ${v.d.task.attempt}, base ${v.d.repo.base}\n`);
    current = job;
    emit("accepted", `202: job ${jobLabel(jobId)} for ${v.d.task.context}/${v.d.task.title} (attempt ${v.d.task.attempt})`, {
      sliceId: v.d.task.sliceId,
      base: v.d.repo.base,
      attempt: v.d.task.attempt,
    });
    json(res, 202, { jobId });
    void runJob(job, v.d);
    return;
  }
  json(res, 404, { error: "not found" });
});

server.listen(cfg.port, cfg.host, () => {
  emit("listening", `build server listening on http://${cfg.host}:${cfg.port}`, { host: cfg.host, port: cfg.port, pid: process.pid });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    emit("stopping", `build server stopping (${sig})${current ? `, abandoning job ${jobLabel(current.jobId)}` : ""}`);
    server.close();
    process.exit(0);
  });
}
