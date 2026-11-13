#!/usr/bin/env node
/**
 * The build server (Appendix A, "Builder implementation notes"), prototype edition: runs locally, one job at a time.
 *
 *   POST /slices   dispatch (202 accepted, 400 malformed, 422 { missing }, 503 + Retry-After while busy)
 *   GET  /status   what it is doing, and the pi configuration it will use for the next job
 *   GET  /health   200 ok
 *
 * Each job: a fresh clone of the target repository at `repo.base` under <workspaceDir>/<jobId>, the stub `pi` agent
 * run in it (it appends an entry to the logbook file), a commit on top of base, `git format-patch <base>..HEAD` sent
 * to the callback, workspace deleted. The builder has read access to the repository only and no board access.
 *
 * Configuration is the JSON file named by $BUILDER_CONFIG (the factory's builder layer writes it from its settings).
 * The file is re-read at the start of every job, so a changed pi configuration applies to the next build. Progress is
 * appended as JSON lines to `eventsFile`. Runs on Node 24 type stripping: only erasable TypeScript syntax is used.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

export interface PiConfig {
  /** The pi executable ("pi", or an absolute path). */
  command: string;
  /** pi's agent directory (PI_CODING_AGENT_DIR: models.json, settings.json); empty = pi's default ~/.pi/agent. */
  agentDir: string;
  provider: string;
  model: string;
  /** off, minimal, low, medium, high, xhigh, max; empty = pi's default. */
  thinking: string;
  /** Extra flags, shell-style (quotes respected), placed before -p. */
  args: string;
  /** Extension files or builtin:<name>, one per line or comma-separated; each becomes -e <ext>. */
  extensions: string;
  /** The prompt template; placeholders {{title}} {{context}} {{sliceId}} {{attempt}} {{logbook}} {{sliceJson}} {{base}}. */
  prompt: string;
  timeoutMinutes: number;
}

export interface BuilderConfig {
  host: string;
  port: number;
  workspaceDir: string;
  /** `requires` entries this builder satisfies besides `repo:*` (for example "stack:stub"). */
  capabilities: string[];
  jobTimeoutMinutes: number;
  logbookFile: string;
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
}

export const DEFAULT_PROMPT = [
  "You are a stub build agent. The repository in the current directory is the target application.",
  'Your only job: append exactly one line to the file {{logbook}} in the form "- {{now}} | {{context}}/{{title}} | attempt {{attempt}} | built by pi stub ({{model}})".',
  "Keep every existing line as it is. Do not create, change or delete any other file. Do not run git commands. Do not ask questions.",
  "When the line is appended, reply with the single word DONE.",
].join("\n");

export function defaultConfig(): BuilderConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    workspaceDir: "builder/jobs",
    capabilities: ["stack:stub"],
    jobTimeoutMinutes: 20,
    logbookFile: "LOGBOOK.md",
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
      args: "--no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-themes",
      extensions: "",
      prompt: DEFAULT_PROMPT,
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
  const event = { ts: new Date().toISOString(), source: "builder", kind, msg, jobId: current?.jobId, slice: current?.title, ...data };
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

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => (k in vars ? vars[k] : `{{${k}}}`));
}

function runPi(job: Job, d: Dispatch): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  const pi = cfg.pi;
  const vars = {
    title: d.task.title,
    context: d.task.context,
    sliceId: d.task.sliceId,
    attempt: String(d.task.attempt),
    logbook: cfg.logbookFile,
    base: d.repo.base,
    model: pi.model,
    now: new Date().toISOString(),
    sliceJson: JSON.stringify(d.slice ?? null, null, 2),
  };
  const prompt = render(pi.prompt, vars);
  const exts = pi.extensions
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const args = [
    ...splitArgs(pi.args),
    "--provider",
    pi.provider,
    "--model",
    pi.model,
    ...(pi.thinking ? ["--thinking", pi.thinking] : []),
    ...exts.flatMap((e) => ["-e", e]),
    "-p",
    "--",
    prompt,
  ];
  emit("pi.start", `pi ${pi.provider}/${pi.model}${pi.thinking ? ` (thinking ${pi.thinking})` : ""}${exts.length ? `, ${exts.length} extension(s)` : ""}`, {
    command: pi.command,
    args: args.slice(0, -1),
  });
  appendFileSync(job.logFile, `\n$ ${pi.command} ${args.slice(0, -1).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")} -- <prompt>\n--- prompt ---\n${prompt}\n--- output ---\n`);
  return new Promise((resolveRun) => {
    let output = "";
    let timedOut = false;
    const command = pi.command.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    const agentDir = pi.agentDir ? resolve(pi.agentDir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : "";
    const child = spawn(command, args, {
      cwd: job.workspace,
      env: { ...process.env, PI_NO_UPDATE_CHECK: "1", ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      output += `\nspawn error: ${err.message}`;
      resolveRun({ code: -1, timedOut, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, timedOut, output });
    });
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

    step("pi");
    const pi = await runPi(job, d);
    if (pi.timedOut) throw new Error(`pi timed out after ${cfg.pi.timeoutMinutes} min`);
    if (pi.code !== 0) throw new Error(`pi exited ${pi.code}: ${pi.output.trim().slice(-400)}`);
    emit("pi.done", `pi finished: ${pi.output.trim().split("\n").pop()?.slice(0, 120) ?? ""}`);
    if (Date.now() > deadline) throw new Error(`job exceeded ${cfg.jobTimeoutMinutes} min`);

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
  rmSync(job.workspace, { recursive: true, force: true });
  lastJob = { ...job, outcome: result.outcome, endedAt: Date.now() };
  current = null;
  emit("job.end", `job ${job.jobId.slice(0, 8)} ${result.outcome} in ${Math.round((Date.now() - job.startedAt) / 1000)}s`, { outcome: result.outcome });
}

function status(): Record<string, unknown> {
  // Report the configuration the next job will use, not the one the last job loaded.
  if (!current) cfg = loadConfig();
  const pi = cfg.pi;
  return {
    ok: true,
    busy: !!current,
    job: current ? { jobId: current.jobId, title: current.title, context: current.context, attempt: current.attempt, step: current.step, startedAt: current.startedAt } : null,
    lastJob: lastJob ? { jobId: lastJob.jobId, title: lastJob.title, outcome: lastJob.outcome, endedAt: lastJob.endedAt } : null,
    capabilities: cfg.capabilities,
    pi: { command: pi.command, agentDir: pi.agentDir, provider: pi.provider, model: pi.model, thinking: pi.thinking, args: pi.args, extensions: pi.extensions },
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
      emit("busy", `503: busy with job ${current.jobId.slice(0, 8)}`);
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
    };
    writeFileSync(job.logFile, `job ${jobId}: ${v.d.task.context}/${v.d.task.title} attempt ${v.d.task.attempt}, base ${v.d.repo.base}\n`);
    current = job;
    emit("accepted", `202: job ${jobId.slice(0, 8)} for ${v.d.task.context}/${v.d.task.title} (attempt ${v.d.task.attempt})`, {
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
    emit("stopping", `build server stopping (${sig})${current ? `, abandoning job ${current.jobId.slice(0, 8)}` : ""}`);
    server.close();
    process.exit(0);
  });
}
