#!/usr/bin/env node
/**
 * gaffer.ts: the eventmodelers shared runner's `--exec` command (Appendix A, "gaffer.js implementation notes").
 *
 * Runs once per turn with cwd = the gaffer's clone of the target repository. On a build turn it turns the slice into a
 * builder job over HTTP, waits for the builder's callback, applies the patch, gates, merges, pushes and records the
 * outcome with `eventmodelers slice-status`. Every other turn (board-change tasks, learnings cleanup) exits 0.
 *
 * Configuration: the JSON file named by $GAFFER_CONFIG, else ../gaffer.json next to the clone. Progress is appended as
 * JSON lines to `eventsFile` (the factory's gaffer layer renders them). The board token arrives in the environment and
 * is never logged.
 *
 * Runs on Node 24 type stripping: only erasable TypeScript syntax is used.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface GafferConfig {
  name: string;
  repoUrl: string;
  /** Target branch to build and fast-forward. */
  branch: string;
  builderUrl: string;
  callbackHost: string;
  callbackPort: number;
  /** Advertised callback host (what the builder connects to); defaults to callbackHost. */
  callbackPublicHost?: string;
  requires: string[];
  /** Shell command run in the clone after the patch is applied; empty = no gate. */
  gate?: string;
  turnTimeoutMinutes: number;
  eventsFile?: string;
  /** When set, the full slice sent to the builder is also written here as `<title>-slice.json` (for reference). */
  sliceDumpDir?: string;
}

interface Task {
  status: string;
  title: string;
  sliceId: string;
  context: string;
  handover: boolean;
}

type Callback = { outcome: "done"; patch: string } | { outcome: "failed"; reason: string };

const cwd = process.cwd();
const startedAt = Date.now();

function loadConfig(): GafferConfig {
  const file = process.env.GAFFER_CONFIG || resolve(cwd, "..", "gaffer.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GafferConfig>;
  if (!raw.builderUrl) throw new Error(`gaffer config ${file} has no builderUrl`);
  return {
    name: raw.name ?? "gaffer",
    repoUrl: raw.repoUrl ?? "",
    branch: raw.branch ?? "main",
    builderUrl: raw.builderUrl.replace(/\/+$/, ""),
    callbackHost: raw.callbackHost ?? "127.0.0.1",
    callbackPort: Number(raw.callbackPort ?? 8787),
    callbackPublicHost: raw.callbackPublicHost,
    requires: Array.isArray(raw.requires) ? raw.requires : [],
    gate: raw.gate ?? "",
    turnTimeoutMinutes: Number(raw.turnTimeoutMinutes ?? 60),
    eventsFile: raw.eventsFile,
    sliceDumpDir: raw.sliceDumpDir,
  };
}

/**
 * Exit code of a build turn that failed. It is 0 on purpose: the shared runner retries a non-zero exit in place,
 * for ever, with growing backoff, and never counts it. A turn that exits 0 without recording a status is a failed
 * attempt: the runner puts the slice back to Planned, counts the attempt and sets the slice to Blocked, with a
 * comment, after 5. The reason is in the events file and in the note posted on the slice.
 */
const FAILED_ATTEMPT = 0;

let cfg: GafferConfig;
let jobId = "";
let task: Task | null = null;

function emit(kind: string, msg: string, data: Record<string, unknown> = {}): void {
  const line = `[gaffer] ${msg}`;
  console.log(line);
  if (!cfg?.eventsFile) return;
  const event = { ts: new Date().toISOString(), source: "gaffer", kind, msg, jobId: jobId || undefined, slice: task?.title, ...data };
  try {
    appendFileSync(cfg.eventsFile, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error(`[gaffer] could not append to ${cfg.eventsFile}: ${(err as Error).message}`);
  }
}

function git(args: string[], opts: { allowFail?: boolean } = {}): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout || "").trim()}`);
  }
  return (res.stdout || "").trim();
}

const PUSH_TRIES = 4;
/** A target branch missing from origin is created from this branch and pushed as its upstream. */
const FROM_BRANCH = "main";

function remoteHasBranch(branch: string): boolean {
  return git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]) !== "";
}

/**
 * Bring the branch level with origin, then push it so the builder can fetch the base, and return the base. Fetch
 * first: the branch may not exist locally yet (checkout creates it from origin), and origin may have moved since setup.
 * A branch missing from origin is created from origin/main, replacing any local branch of that name, and the push
 * creates it on origin with its upstream set.
 * The remote can still move, or look older than it is, between the fetch and the push (a person or another gaffer
 * pushing the same branch, a fetch answered from a lagging replica), and the push is then rejected as non-fast-forward.
 * Fetch, fast-forward and push again, up to PUSH_TRIES times with a growing pause, and recompute the base each time.
 * A branch that has really diverged fails at the fast-forward, with git's own message.
 */
async function syncAndPushBranch(): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    git(["fetch", "-q", "origin"]);
    if (remoteHasBranch(cfg.branch)) {
      git(["checkout", "-q", cfg.branch]);
      git(["merge", "-q", "--ff-only", `origin/${cfg.branch}`]);
    } else {
      git(["checkout", "-q", "-B", cfg.branch, `origin/${FROM_BRANCH}`]);
      emit("branch.create", `${cfg.branch} is not on origin: created from origin/${FROM_BRANCH}`, { branch: cfg.branch, from: FROM_BRANCH });
    }
    const base = git(["rev-parse", "HEAD"]);
    emit("base", `base ${base.slice(0, 12)} on ${cfg.branch}`, { base, branch: cfg.branch });
    try {
      git(["push", "-q", "-u", "origin", cfg.branch]);
      return base;
    } catch (err) {
      const message = (err as Error).message;
      if (attempt >= PUSH_TRIES || !/rejected|fetch first|non-fast-forward/i.test(message)) throw err;
      emit("push.retry", `push rejected because the remote moved: fetching again (try ${attempt + 1} of ${PUSH_TRIES})`, { attempt });
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
}

function em(args: string[]): void {
  const res = spawnSync("eventmodelers", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (out) console.log(out.split("\n").map((l) => `[eventmodelers] ${l}`).join("\n"));
  if (res.status !== 0) throw new Error(`eventmodelers ${args[0]} exited ${res.status}`);
}

function parseTask(prompt: string): Task | null {
  const m = /Your task now: build the (\S+) slice "(.*?)" \(id=([^,)]+), context="([^"]*)"\)/.exec(prompt);
  if (!m) return null;
  const h = /^Handover:\s*(on|off)\s*$/m.exec(prompt);
  return { status: m[1], title: m[2], sliceId: m[3].trim(), context: m[4], handover: h?.[1] === "on" };
}

function findSlice(sliceId: string): { file: string; slice: unknown } | null {
  const root = join(cwd, ".build-kit", ".slices");
  if (!existsSync(root)) return null;
  for (const ctx of readdirSync(root)) {
    const idx = join(root, ctx, "index.json");
    if (!existsSync(idx)) continue;
    let entries: { id?: string; folder?: string }[] = [];
    try {
      entries = (JSON.parse(readFileSync(idx, "utf8")).slices ?? []) as { id?: string; folder?: string }[];
    } catch {
      continue;
    }
    const e = entries.find((x) => x.id === sliceId);
    if (!e?.folder) continue;
    const file = join(root, ctx, e.folder, "slice.json");
    if (!existsSync(file)) return null;
    return { file, slice: JSON.parse(readFileSync(file, "utf8")) };
  }
  return null;
}

interface BoardConfig {
  token: string;
  organizationId: string;
  boardId: string;
  baseUrl: string;
}

/** Board credentials from the clone's `.eventmodelers/config.json`; `EVENTMODELERS_TOKEN` wins over the file. */
function loadBoardConfig(): BoardConfig {
  const file = join(cwd, ".eventmodelers", "config.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BoardConfig>;
  const token = process.env.EVENTMODELERS_TOKEN || raw.token;
  if (!token || !raw.organizationId || !raw.boardId || !raw.baseUrl) {
    throw new Error(`${file} must hold token (or EVENTMODELERS_TOKEN), organizationId, boardId and baseUrl`);
  }
  return { token, organizationId: raw.organizationId, boardId: raw.boardId, baseUrl: raw.baseUrl.replace(/\/+$/, "") };
}

async function boardGet(board: BoardConfig, path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = `${board.baseUrl}/api/org/${board.organizationId}/boards/${board.boardId}${path}?${new URLSearchParams(query)}`;
  const headers: Record<string, string> = { "x-token": board.token };
  if (process.env.EVENTMODELERS_AGENT_ID) headers["x-agent-id"] = process.env.EVENTMODELERS_AGENT_ID;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
    const text = (await res.text()).slice(0, 300);
    // The board limits a token to 120 requests a minute (HTTP 429, with the wait it wants); a short wait clears it.
    // Everything else sharing the token (the runner, the factory's polling) counts against the same limit.
    if (attempt < BOARD_TRIES && [429, 502, 503, 504].includes(res.status)) {
      const wait = retryWaitMs(res, text);
      emit("board.retry", `board GET ${path} answered HTTP ${res.status}: waiting ${Math.round(wait / 1000)}s (try ${attempt + 1} of ${BOARD_TRIES})`, { status: res.status });
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new Error(`board GET ${path} answered HTTP ${res.status}: ${text}`);
  }
}

const BOARD_TRIES = 4;

/** How long the board asked us to wait: Retry-After, else context.retryAfterSeconds in the body, plus a second. At most 15s. */
function retryWaitMs(res: Response, body: string): number {
  let seconds = Number(res.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    try {
      seconds = Number((JSON.parse(body) as { context?: { retryAfterSeconds?: unknown } }).context?.retryAfterSeconds);
    } catch {
      seconds = NaN;
    }
  }
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = 2;
  return Math.min(15, seconds + 1) * 1000;
}

type BoardSlice = { id?: string; title?: string; contextName?: string; contextId?: string; [k: string]: unknown };

/**
 * load-slice, run by the gaffer over REST: the full definition of one slice from the board, never the summary stub.
 * One summary call finds the slice's chapter (the stub on disk may lack `contextId`), then one full fetch by
 * `contextId` (exact) with `contextName` as the fallback. Chapters can share a title and a name resolves to the first
 * match only, so the id is preferred. Throws when the slice cannot be fetched in full.
 */
async function loadFullSlice(t: Task, stub: BoardSlice): Promise<BoardSlice> {
  const board = loadBoardConfig();
  const listed = ((await boardGet(board, "/slicedata/slices")).slices ?? []) as BoardSlice[];
  const entry = listed.find((s) => s.id === t.sliceId);
  if (!entry) throw new Error(`slice ${t.sliceId} is not on the board`);
  const contextId = entry.contextId ?? stub.contextId;
  const contextName = entry.contextName ?? stub.contextName ?? t.context;

  const attempts: Record<string, string>[] = [];
  if (contextId) attempts.push({ contextId, sliceId: t.sliceId });
  if (contextName) attempts.push({ contextName, sliceId: t.sliceId });
  let lastError = "no chapter id or name to fetch the slice with";
  for (const query of attempts) {
    try {
      const full = (((await boardGet(board, "/slicedata", query)).slices ?? []) as BoardSlice[]).find((s) => s.id === t.sliceId);
      if (full) return full;
      lastError = `slice not returned for ${Object.keys(query)[0]}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new Error(`could not load the full slice ${t.sliceId} from the board: ${lastError}`);
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "slice";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The callback listener: accepts exactly one result for the current jobId, answers 410 to anything else. */
function startListener(onResult: (cb: Callback) => void): Promise<Server> {
  let settled = false;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      return;
    }
    if (m[1] !== jobId || settled) {
      emit("callback.stale", `stale callback for job ${m[1]} answered 410`);
      res.writeHead(410).end();
      return;
    }
    let body: Callback;
    try {
      body = JSON.parse(await readBody(req)) as Callback;
      if (body.outcome !== "done" && body.outcome !== "failed") throw new Error("outcome must be done or failed");
      if (body.outcome === "done" && typeof body.patch !== "string") throw new Error("done needs a patch");
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    settled = true;
    res.writeHead(204).end();
    onResult(body);
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(cfg.callbackPort, cfg.callbackHost, () => resolveServer(server));
  });
}

async function dispatch(body: unknown, deadline: number): Promise<void> {
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${cfg.builderUrl}/slices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`builder unreachable at ${cfg.builderUrl}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 202) {
      emit("dispatch.accepted", `builder accepted job ${jobId}`, { response: text.slice(0, 200) });
      return;
    }
    if (res.status === 503) {
      const retryAfter = Math.max(1, Number(res.headers.get("retry-after") ?? 10) || 10);
      if (Date.now() + retryAfter * 1000 > deadline) throw new Error("builder stayed busy until the turn deadline");
      emit("dispatch.busy", `builder busy, retrying in ${retryAfter}s`, { retryAfter });
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 422) throw new Error(`builder cannot meet the requirements: ${text.slice(0, 500)}`);
    if (res.status === 400) throw new Error(`builder rejected the request as malformed: ${text.slice(0, 500)}`);
    throw new Error(`builder answered HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

function note(reason: string): void {
  try {
    em(["info", reason, "--kind", "note"]);
  } catch (err) {
    console.error(`[gaffer] could not comment on the slice: ${(err as Error).message}`);
  }
}

async function buildTurn(t: Task): Promise<number> {
  task = t;
  jobId = randomUUID();
  emit("turn.start", `build turn: ${t.context}/${t.title} (attempt job ${jobId.slice(0, 8)})`, {
    sliceId: t.sliceId,
    context: t.context,
    handover: t.handover,
  });

  const found = findSlice(t.sliceId);
  if (!found) {
    emit("turn.fail", `slice.json for ${t.sliceId} not found under .build-kit/.slices`);
    return FAILED_ATTEMPT;
  }

  // The slice.json on disk is a summary stub. The builder gets the full definition from the board.
  let fullSlice: BoardSlice;
  try {
    fullSlice = await loadFullSlice(t, found.slice as BoardSlice);
  } catch (err) {
    const reason = (err as Error).message;
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return FAILED_ATTEMPT;
  }
  emit("slice.loaded", `full slice loaded from the board (${Object.keys(fullSlice).length} fields)`, { fields: Object.keys(fullSlice) });
  if (cfg.sliceDumpDir) {
    const file = join(cfg.sliceDumpDir, `${slug(t.title)}-slice.json`);
    try {
      mkdirSync(cfg.sliceDumpDir, { recursive: true });
      writeFileSync(file, JSON.stringify(fullSlice, null, 2) + "\n");
      emit("slice.dumped", `full slice written to ${file}`, { file });
    } catch (err) {
      emit("slice.dump.fail", `could not write ${file}: ${(err as Error).message}`);
    }
  }

  // 1. base = HEAD of the selected branch, pushed so the builder can fetch it.
  const base = await syncAndPushBranch();
  emit("push", `${cfg.branch} pushed before dispatch`);

  const requires = Array.from(new Set([`repo:${repoKey(cfg.repoUrl || git(["remote", "get-url", "origin"]))}`, ...cfg.requires]));
  const publicHost = cfg.callbackPublicHost || cfg.callbackHost;
  const callback = `http://${publicHost}:${cfg.callbackPort}/jobs/${jobId}`;
  const attempt = Number(process.env.GAFFER_ATTEMPT ?? 1) || 1;
  const request = {
    requires,
    repo: { url: cfg.repoUrl || git(["remote", "get-url", "origin"]), base },
    task: { sliceId: t.sliceId, title: t.title, context: t.context, handover: t.handover, attempt },
    slice: fullSlice,
    callback,
  };

  // 2. Listener first, then dispatch, then wait (timeout just under the runner's turn limit).
  const timeoutMs = Math.max(60_000, cfg.turnTimeoutMinutes * 60_000 - 120_000);
  const deadline = startedAt + timeoutMs;
  let resolveResult!: (cb: Callback) => void;
  const result = new Promise<Callback>((r) => (resolveResult = r));
  const server = await startListener(resolveResult);
  emit("listener", `callback listener on ${cfg.callbackHost}:${cfg.callbackPort}`, { callback });

  try {
    emit("dispatch", `POST ${cfg.builderUrl}/slices`, { requires, base });
    await dispatch(request, deadline);
    emit("waiting", `waiting for the builder (up to ${Math.round((deadline - Date.now()) / 60_000)} min)`);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())));
    const cb = await Promise.race([result, timeout]);
    if (!cb) {
      emit("turn.fail", "timed out waiting for the builder's callback");
      note(`gaffer: timed out after ${Math.round(timeoutMs / 60_000)} min waiting for the builder (job ${jobId})`);
      return FAILED_ATTEMPT;
    }
    if (cb.outcome === "failed") {
      emit("result.failed", `builder failed: ${cb.reason}`, { reason: cb.reason });
      note(`builder failed: ${cb.reason}`);
      return FAILED_ATTEMPT;
    }
    emit("result.done", `builder returned a patch (${cb.patch.length} bytes)`, { bytes: cb.patch.length });
    return applyAndMerge(t, base, cb.patch);
  } catch (err) {
    const reason = (err as Error).message;
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return FAILED_ATTEMPT;
  } finally {
    server.close();
  }
}

function applyAndMerge(t: Task, base: string, patch: string): number {
  const branch = `feature/${slug(t.title)}`;
  const dir = mkdtempSync(join(tmpdir(), "gaffer-"));
  const patchFile = join(dir, "job.patch");
  writeFileSync(patchFile, patch);
  try {
    git(["branch", "-D", branch], { allowFail: true });
    git(["checkout", "-q", "-b", branch, base]);
    emit("apply", `git am -3 on ${branch}`);
    try {
      git(["am", "-3", patchFile]);
    } catch (err) {
      git(["am", "--abort"], { allowFail: true });
      throw new Error(`git am failed: ${(err as Error).message}`);
    }
    const commits = git(["rev-list", "--count", `${base}..HEAD`]);
    emit("applied", `${commits} commit(s) applied`, { commits: Number(commits) });

    if (cfg.gate && cfg.gate.trim()) {
      emit("gate", `running gate: ${cfg.gate}`);
      const res = spawnSync("sh", ["-c", cfg.gate], { cwd, encoding: "utf8" });
      const out = `${res.stdout || ""}${res.stderr || ""}`.trim().slice(-2000);
      if (res.status !== 0) throw new Error(`gate failed (exit ${res.status}): ${out}`);
      emit("gate.ok", "gate passed");
    } else {
      emit("gate.ok", "no gate configured: passing");
    }

    git(["checkout", "-q", cfg.branch]);
    git(["merge", "--ff-only", branch]);
    git(["push", "-q", "origin", cfg.branch]);
    const head = git(["rev-parse", "HEAD"]);
    emit("merged", `${cfg.branch} fast-forwarded to ${head.slice(0, 12)} and pushed`, { head, branch: cfg.branch });
    git(["branch", "-D", branch], { allowFail: true });

    const status = t.handover ? "Waiting" : "Done";
    em(["slice-status", status]);
    emit("settled", `slice recorded as ${status}`, { status });
    emit("turn.end", `turn finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return 0;
  } catch (err) {
    const reason = (err as Error).message;
    git(["checkout", "-q", "-f", cfg.branch], { allowFail: true });
    git(["branch", "-D", branch], { allowFail: true });
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return FAILED_ATTEMPT;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  cfg = loadConfig();
  const promptFile = process.env.RALPH_PROMPT_FILE;
  const prompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8") : String(process.argv[process.argv.length - 1] ?? "");
  const t = parseTask(prompt);
  if (!t) {
    emit("turn.skip", "not a build turn (task or curation turn): nothing to do");
    return 0;
  }
  return buildTurn(t);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[gaffer] fatal: ${(err as Error).stack ?? err}`);
    try {
      emit("turn.fail", `fatal: ${(err as Error).message}`);
    } catch {
      /* ignore */
    }
    try {
      note(`gaffer: fatal: ${(err as Error).message}`);
    } catch {
      /* ignore */
    }
    process.exit(FAILED_ATTEMPT);
  },
);
