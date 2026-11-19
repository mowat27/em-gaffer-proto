#!/usr/bin/env node
/**
 * Record how a builder handles every example dispatch, with the real server and the real agent, one at a time.
 *
 *   av node builder/test/baseline/record-dispatches.ts [options]
 *
 *   --builder <dir>     the builder tree to run (default: the builder/ this file is in)
 *   --out <dir>         where results go (default: tmp/build-refactor/baseline/dispatches at the repository root)
 *   --runs <dir>        the builder's runs (runs/<id>/run.json, log, workspace, sessions), kept for the verifier
 *                       (default: <out>/../runs)
 *   --examples <dir>    the dispatches (default: examples/dispatch at the repository root)
 *   --only <a,b>        record only these dispatches (names without .json); summary.json keeps the other rows
 *   --config <file>     a machine config layer (YAML or JSON) merged over the recorder's (see recorderConfig)
 *   --repo-url <url>    clone this instead of each dispatch's repo.url (its `repo:` requirement is rewritten to match)
 *   --wait-minutes <n>  how long to wait for one job's callback (default 60)
 *
 * Runs under `av`: the agent's model calls go through the Agent Vault proxy.
 *
 * Per dispatch, <out>/<name>.json holds the outcome, the reason (failed) or the patch (done), the files the patch
 * touches, the files the workspace changed, wall time and the agent's metrics (turns, tool calls, tool errors, tokens,
 * cost, model) from its pi session. <out>/<name>.patch, <name>.log (the job log) and <name>.session.jsonl are copies.
 * <out>/summary.json is the table, rewritten after every dispatch.
 *
 * The parts that depend on how a builder is configured, started and observed are small functions on their own:
 * recorderConfig, startServer, workspaceOf, jobLogOf and readMetrics. A refactored builder changes those, not the loop.
 * They follow the P1 layout, kept in P2: every job is a workflow run in runs/<id>/ (its run.json names the job), its
 * agent step is a child run whose pi session is in runs/<childId>/sessions/. P2 configures the server with a machine
 * config layer named by $GAFFER_CONFIG.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { metricsOf, parseSession, type Metrics } from "../../engine/pi-session.ts";
import { serverCommand } from "../harness/builder.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

// ---- options ----

const { values: opt } = parseArgs({
  options: {
    builder: { type: "string", default: resolve(HERE, "..", "..") },
    out: { type: "string", default: join(REPO_ROOT, "tmp", "build-refactor", "baseline", "dispatches") },
    runs: { type: "string" },
    examples: { type: "string", default: join(REPO_ROOT, "examples", "dispatch") },
    only: { type: "string" },
    config: { type: "string" },
    "repo-url": { type: "string" },
    "wait-minutes": { type: "string", default: "60" },
  },
});
const builderDir = resolve(opt.builder!);
const outDir = resolve(opt.out!);
const runsDir = resolve(opt.runs ?? join(outDir, "..", "runs"));
const examplesDir = resolve(opt.examples!);
const waitMs = Number(opt["wait-minutes"]) * 60_000;

// ---- the builder: configuration, start, where things land ----

/** `over` merged onto `under`: maps merge key by key, lists and values replace (as the machine config's layers do). */
function merge(under: unknown, over: unknown): unknown {
  const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isMap(under) || !isMap(over)) return over === undefined ? under : over;
  const out: Record<string, unknown> = { ...under };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}

/**
 * The machine config layer for the recorder's server (ops/config.ts): the production settings with the recorder's
 * own port, runs directory and events file, and every workspace kept for the verifier. The builder is the production
 * supabase-api builder: setup, base checks, the implement budget and provides come from its definition, provider,
 * model and thinking from agentics/agents/supabase-api/settings.json, and pi always keeps its session in the agent
 * run (runs/<id>/sessions). The top-level host and port mirror builder.server's for the rest of the script.
 */
function recorderConfig(port: number, dispatchCount: number): Record<string, unknown> {
  const base = {
    builder: {
      server: {
        host: "127.0.0.1",
        port,
        runsDir,
        jobTimeoutMinutes: 20,
        callbackRetries: 8,
        keepWorkspaces: Math.max(20, dispatchCount + 1),
        builder: "supabase-api",
      },
      pi: { command: "~/.pi/agent/bin/pi" },
    },
  };
  const layer = (opt.config ? merge(base, parseYaml(readFileSync(resolve(opt.config), "utf8"))) : base) as { builder: { server: { host: string; port: number } } };
  return { ...layer, host: layer.builder.server.host, port: layer.builder.server.port };
}

interface Server {
  url: string;
  stop(): Promise<void>;
}

/** Start the builder's server with this config layer ($GAFFER_CONFIG; JSON is YAML); its output goes to <out>/server.log. */
async function startServer(config: Record<string, unknown>): Promise<Server> {
  const configFile = join(outDir, "builder-config.yml");
  writeFileSync(configFile, JSON.stringify({ builder: config.builder }, null, 2));
  const log = createWriteStream(join(outDir, "server.log"), { flags: "a" });
  const child = spawn(process.execPath, serverCommand(builderDir), { cwd: builderDir, env: { ...process.env, GAFFER_CONFIG: configFile }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const url = `http://${config.host}:${config.port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`the builder exited ${child.exitCode} on start: see ${join(outDir, "server.log")}`);
    try {
      if ((await fetch(`${url}/health`)).status === 200) break;
    } catch {
      /* not listening yet */
    }
    await sleep(200);
  }
  return {
    url,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

interface RunFile {
  id: string;
  parent: string | null;
  kind: string;
  job?: { jobId: string };
}

function runs(): RunFile[] {
  if (!existsSync(runsDir)) return [];
  const out: RunFile[] = [];
  for (const id of readdirSync(runsDir)) {
    try {
      out.push(JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8")) as RunFile);
    } catch {
      /* not a run */
    }
  }
  return out;
}

/** The job's workflow run: the run whose run.json names the job. */
function jobRunOf(jobId: string): RunFile | null {
  return runs().find((r) => r.job?.jobId === jobId) ?? null;
}

/** The job's workspace, where its clone and the agent's changes stay. */
function workspaceOf(jobId: string): string | null {
  const run = jobRunOf(jobId);
  const ws = run ? join(runsDir, run.id, "workspace") : null;
  return ws && existsSync(ws) ? ws : null;
}

/** The job's log (setup output, then the agent run's log: the pi command line, the prompt and pi's output). */
function jobLogOf(jobId: string): string | null {
  const run = jobRunOf(jobId);
  const log = run ? join(runsDir, run.id, "log") : null;
  return log && existsSync(log) ? log : null;
}

interface AgentMetrics {
  source: "session" | "trailers" | "none";
  session: string | null;
  model: string | null;
  durationMs: number | null;
  turns: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  tokens: { input: number; output: number; cacheRead: number } | null;
  cost: number | null;
  topTools: [string, number][];
}

/**
 * The agent's metrics for a job: from the pi session of its agent run (runs/<agentRunId>/sessions/, the newest file),
 * or, for a done job without one, from the commit trailers the builder wrote (rounded). Returns the session file too.
 */
function readMetrics(jobId: string, _config: Record<string, unknown>, patch: string | null): { metrics: AgentMetrics; sessionFile: string | null } {
  const run = jobRunOf(jobId);
  const agentRun = run ? runs().find((r) => r.parent === run.id && r.kind === "agent") : undefined;
  const sessionsDir = agentRun ? join(runsDir, agentRun.id, "sessions") : null;
  const sessionName = sessionsDir && existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort().pop() : undefined;
  if (sessionsDir && sessionName) {
    const m: Metrics = metricsOf(parseSession(readFileSync(join(sessionsDir, sessionName), "utf8")));
    return {
      sessionFile: join(sessionsDir, sessionName),
      metrics: {
        source: "session",
        session: `${agentRun!.id}/${sessionName}`,
        model: m.model || null,
        durationMs: m.durationMs,
        turns: m.turns,
        toolCalls: m.toolCalls,
        toolErrors: m.toolErrors,
        tokens: { input: m.input, output: m.output, cacheRead: m.cacheRead },
        cost: m.cost,
        topTools: m.topTools,
      },
    };
  }
  const t = patch ? trailersOf(patch) : {};
  if (t["Agent-Turns"]) {
    const calls = /^(\d+) \((\d+) errors\)$/.exec(t["Agent-Tool-Calls"] ?? "");
    return {
      sessionFile: null,
      metrics: {
        source: "trailers",
        session: null,
        model: t["Agent"]?.replace(/^pi /, "") ?? null,
        durationMs: null,
        turns: Number(t["Agent-Turns"]),
        toolCalls: calls ? Number(calls[1]) : null,
        toolErrors: calls ? Number(calls[2]) : null,
        tokens: null,
        cost: t["Agent-Cost"] ? Number(t["Agent-Cost"].replace("$", "")) : null,
        topTools: [],
      },
    };
  }
  return { sessionFile: null, metrics: { source: "none", session: null, model: null, durationMs: null, turns: null, toolCalls: null, toolErrors: null, tokens: null, cost: null, topTools: [] } };
}

// ---- helpers ----

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((res, rej) => {
      const s = createNetServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        const p = typeof a === "object" && a ? a.port : 0;
        s.close(() => res(p));
      });
    });
    if (![8013, 8787, 8788].includes(port)) return port;
  }
}

function trailersOf(patch: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of patch.split("\n")) {
    if (line.startsWith("---")) break;
    const m = /^([A-Z][\w-]+): (.+)$/.exec(line);
    if (m && !["From", "Date", "Subject"].includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}

/** Paths a format-patch mbox touches. */
function patchFiles(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]))].sort();
}

/** Files the workspace changed since base (committed, staged, unstaged and untracked), as git sees them. */
function workspaceChanges(ws: string, base: string): string[] {
  try {
    const tracked = execFileSync("git", ["diff", "--name-only", base], { cwd: ws, encoding: "utf8" }).split("\n");
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ws, encoding: "utf8" }).split("\n");
    return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function gitHead(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** A listener for the callbacks: records each body by job id and answers 204. */
async function startListener(): Promise<{ url: string; result(jobId: string, timeoutMs: number): Promise<unknown>; stop(): void }> {
  const results = new Map<string, unknown>();
  const server = createHttpServer((req, res) => {
    const m = /^\/jobs\/([^/]+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        if (!results.has(m[1])) results.set(m[1], JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    result: async (jobId, timeoutMs) => {
      const until = Date.now() + timeoutMs;
      while (!results.has(jobId)) {
        if (Date.now() > until) throw new Error(`no callback for ${jobId} within ${timeoutMs / 60_000} min`);
        await sleep(1000);
      }
      return results.get(jobId);
    },
    stop: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** POST the dispatch, waiting out 503 busy answers. */
async function dispatch(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  for (;;) {
    const res = await fetch(`${url}/slices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    if (res.status !== 503) return { status: res.status, json };
    await sleep(Number(res.headers.get("retry-after") ?? "15") * 1000);
  }
}

function repoKey(url: string): string {
  let s = url.trim().replace(/\.git$/, "");
  const ssh = /^[^@]+@([^:]+):(.+)$/.exec(s);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return s.replace(/^[a-z]+:\/\//, "").replace(/^[^@]+@/, "");
}

// ---- the run ----

interface Row {
  dispatch: string;
  outcome: string;
  reason: string | null;
  files: number;
  wallMinutes: number;
  turns: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  cost: number | null;
  model: string | null;
  jobId: string;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const all = readdirSync(examplesDir)
    .filter((f) => f.endsWith(".json") && f !== "board.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  const only = opt.only ? opt.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const names = only ? all.filter((n) => only.includes(n)) : all;
  if (only && names.length !== only.length) throw new Error(`unknown dispatch in --only: ${only.filter((n) => !all.includes(n)).join(", ")}`);

  const config = recorderConfig(await freePort(), all.length);
  const listener = await startListener();
  const server = await startServer(config);
  // What the next job's agent uses (GET /status is gone since P5): `builder resolve supabase-api` in the tree.
  const status = (() => {
    try {
      const r = JSON.parse(execFileSync(process.execPath, [join(builderDir, "cli", "builder.ts"), "resolve", "supabase-api", "--message", "x", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { settings?: unknown };
      return { capabilities: null, pi: r.settings ?? null };
    } catch {
      return null;
    }
  })();
  const summaryFile = join(outDir, "summary.json");
  const previous = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, "utf8")) as { rows: Row[] }).rows : [];
  const rows = new Map(previous.map((r) => [r.dispatch, r]));
  const meta = {
    builderTree: builderDir,
    builderCommit: gitHead(builderDir),
    recordedAt: new Date().toISOString(),
    node: process.version,
    config: { ...config, port: undefined },
    // What the builder says it will use for the next job: provider, model, thinking after settings.json.
    builderStatus: status,
  };
  const writeSummary = () =>
    writeFileSync(summaryFile, JSON.stringify({ ...meta, rows: all.filter((n) => rows.has(n)).map((n) => rows.get(n)) }, null, 2) + "\n");

  console.log(`[record] builder ${builderDir} (${meta.builderCommit?.slice(0, 12) ?? "no git"}) at ${server.url}, ${names.length} dispatch(es), results in ${outDir}`);
  try {
    for (const name of names) {
      const d = JSON.parse(readFileSync(join(examplesDir, `${name}.json`), "utf8")) as Record<string, any>;
      const jobId = randomUUID();
      d.callback = `${listener.url}/jobs/${jobId}`;
      if (opt["repo-url"]) {
        const oldKey = repoKey(d.repo.url);
        d.repo.url = opt["repo-url"];
        d.requires = (d.requires as string[]).map((r) => (r === `repo:${oldKey}` ? `repo:${repoKey(opt["repo-url"]!)}` : r));
      }
      const startedAt = new Date();
      console.log(`[record] ${name}: job ${jobId} (${d.task.context}/${d.task.title}), started ${startedAt.toISOString()}`);
      const accepted = await dispatch(server.url, d);
      let body: Record<string, unknown>;
      if (accepted.status !== 202) {
        body = { outcome: "rejected", status: accepted.status, response: accepted.json };
      } else {
        body = (await listener.result(jobId, waitMs)) as Record<string, unknown>;
      }
      const endedAt = new Date();
      // Let the builder finish its cleanup (it is free again once it has stopped answering 503).
      await sleep(3000);
      const patch = typeof body.patch === "string" ? body.patch : null;
      const ws = workspaceOf(jobId);
      const { metrics, sessionFile } = readMetrics(jobId, config, patch);
      const record = {
        dispatch: name,
        jobId,
        slice: { context: d.task.context, title: d.task.title, sliceId: d.task.sliceId, verdict: d.changes?.verdict ?? null },
        base: d.repo.base,
        outcome: body.outcome,
        reason: typeof body.reason === "string" ? body.reason : null,
        rejected: body.outcome === "rejected" ? body : undefined,
        files: patch ? patchFiles(patch) : [],
        workspace: ws,
        workspaceChanges: ws ? workspaceChanges(ws, d.repo.base) : [],
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        wallMs: endedAt.getTime() - startedAt.getTime(),
        metrics,
        trailers: patch ? trailersOf(patch) : null,
        patch,
      };
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
      if (patch) writeFileSync(join(outDir, `${name}.patch`), patch);
      const log = jobLogOf(jobId);
      if (log) copyFileSync(log, join(outDir, `${name}.log`));
      if (sessionFile) copyFileSync(sessionFile, join(outDir, `${name}.session.jsonl`));
      rows.set(name, {
        dispatch: name,
        outcome: String(body.outcome),
        reason: record.reason ? record.reason.slice(0, 300) : null,
        files: record.files.length,
        wallMinutes: Math.round(record.wallMs / 600) / 100,
        turns: metrics.turns,
        toolCalls: metrics.toolCalls,
        toolErrors: metrics.toolErrors,
        tokensIn: metrics.tokens?.input ?? null,
        tokensOut: metrics.tokens?.output ?? null,
        cacheRead: metrics.tokens?.cacheRead ?? null,
        cost: metrics.cost,
        model: metrics.model,
        jobId,
      });
      writeSummary();
      console.log(`[record] ${name}: ${body.outcome}${record.reason ? ` (${record.reason.slice(0, 160)})` : ""} in ${(record.wallMs / 60_000).toFixed(1)} min, ${metrics.turns ?? "?"} turns, ${metrics.toolCalls ?? "?"} tool calls`);
    }
  } finally {
    await server.stop();
    listener.stop();
  }
  writeSummary();
  console.log(`[record] done: ${summaryFile}`);
}

await main();
