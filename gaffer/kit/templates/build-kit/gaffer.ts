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
import { Capture } from "./capture.ts";
import { type Baseline, type Changes, baselinePath, BASELINE_DIR, compare, emptyReason, stable, summarise } from "./baseline.ts";

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
  /** When set, every turn is recorded in full under this folder (capture.ts). */
  capturesDir?: string;
  /** The runner's log file, so a turn's capture includes the runner output around it. */
  runLog?: string;
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
    capturesDir: raw.capturesDir,
    runLog: raw.runLog,
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
let cap: Capture | null = null;

/** Secret values to mask in captures: the board token from the environment and from the clone's config. */
function secrets(): string[] {
  const out = [process.env.EVENTMODELERS_TOKEN ?? ""];
  try {
    out.push(String((JSON.parse(readFileSync(join(cwd, ".eventmodelers", "config.json"), "utf8")) as { token?: unknown }).token ?? ""));
  } catch {
    /* no config */
  }
  return out;
}

function emit(kind: string, msg: string, data: Record<string, unknown> = {}): void {
  const line = `[gaffer] ${msg}`;
  console.log(line);
  cap?.add("event", msg, { data: { event: kind, ...data } });
  if (kind === "turn.fail") cap?.update({ outcome: "failed", reason: msg });
  if (kind === "settled") cap?.update({ outcome: "merged", reason: msg });
  if (kind === "unchanged") cap?.update({ outcome: "unchanged", reason: msg });
  if (kind === "blocked") cap?.update({ outcome: "blocked", reason: msg });
  if (!cfg?.eventsFile) return;
  const event = { ts: new Date().toISOString(), source: "gaffer", kind, msg, jobId: jobId || undefined, slice: task?.title, ...data };
  try {
    appendFileSync(cfg.eventsFile, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error(`[gaffer] could not append to ${cfg.eventsFile}: ${(err as Error).message}`);
  }
}

function git(args: string[], opts: { allowFail?: boolean } = {}): string {
  const t0 = Date.now();
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  cap?.add("git", `git ${args.join(" ")} → exit ${res.status}`, {
    dir: "local",
    ms: Date.now() - t0,
    data: { args, cwd, exit: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" },
  });
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
  const t0 = Date.now();
  const res = spawnSync("eventmodelers", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  cap?.add("cli", `eventmodelers ${args.join(" ")} → exit ${res.status}`, {
    dir: "out",
    ms: Date.now() - t0,
    data: { args, exit: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" },
  });
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

interface BoardResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

/**
 * GET one board path, retried on 429 and 5xx. Every attempt is captured: URL (the token is a header, never in the
 * URL), status, response headers and timing, and the body as a blob unless `keepBody` is false (the caller then keeps
 * it in a combined blob of its own).
 */
async function boardRequest(board: BoardConfig, path: string, query: Record<string, string> = {}, opts: { keepBody?: boolean; label?: string } = {}): Promise<BoardResponse> {
  const qs = new URLSearchParams(query).toString();
  const url = `${board.baseUrl}/api/org/${board.organizationId}/boards/${board.boardId}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { "x-token": board.token };
  if (process.env.EVENTMODELERS_AGENT_ID) headers["x-agent-id"] = process.env.EVENTMODELERS_AGENT_ID;
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      cap?.add("board", `GET ${path}${qs ? `?${qs}` : ""} → ${(err as Error).message}`, { dir: "out", ms: Date.now() - t0, data: { method: "GET", url, attempt, error: (err as Error).message } });
      throw err;
    }
    const text = await res.text();
    const resHeaders = Object.fromEntries(res.headers.entries());
    cap?.add("board", `${opts.label ? `${opts.label}: ` : ""}GET ${path}${qs ? `?${qs}` : ""} → HTTP ${res.status} (${text.length} bytes)`, {
      dir: "in",
      ms: Date.now() - t0,
      data: { method: "GET", url, attempt, status: res.status, requestHeaders: { "x-token": "***", ...(headers["x-agent-id"] ? { "x-agent-id": headers["x-agent-id"] } : {}) }, responseHeaders: resHeaders, bytes: text.length },
      blobs: opts.keepBody === false && res.ok ? {} : { [`response${text.trim().startsWith("{") || text.trim().startsWith("[") ? ".json" : ".txt"}`]: prettyJson(text) },
    });
    if (res.ok) {
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, headers: resHeaders, text, json };
    }
    const short = text.slice(0, 300);
    // The board limits a token to 120 requests a minute (HTTP 429, with the wait it wants); a short wait clears it.
    // Everything else sharing the token (the runner, the factory's polling) counts against the same limit.
    if (attempt < BOARD_TRIES && [429, 502, 503, 504].includes(res.status)) {
      const wait = retryWaitMs(res, short);
      emit("board.retry", `board GET ${path} answered HTTP ${res.status}: waiting ${Math.round(wait / 1000)}s (try ${attempt + 1} of ${BOARD_TRIES})`, { status: res.status });
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new Error(`board GET ${path} answered HTTP ${res.status}: ${short}`);
  }
}

async function boardGet(board: BoardConfig, path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return (await boardRequest(board, path, query)).json as Record<string, unknown>;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const BOARD_TRIES = 4;
/** Pages of the board event log read per turn at most (300 events each); the rest is read on later turns. */
const EVENT_PAGES_PER_TURN = 200;

type BoardNode = { id?: string; type?: string; title?: string; meta?: { title?: string }; [k: string]: unknown };

/** A node record keeps its title in `meta.title`. */
function nodeTitle(n: BoardNode): string {
  return n.title ?? n.meta?.title ?? n.id ?? "?";
}

/**
 * Download the whole board into the turn's capture, for reference. The API refuses an unfiltered node list, so the
 * board is read in its documented parts:
 *
 * 1. `nodes?toplevel=true`: every node in no chapter (the chapters themselves, contexts, drawings), full records.
 * 2. Per chapter: `nodes?chapterId=` (every node placed in it, full records) and `slicedata?contextId=` (the chapter's
 *    whole slice graph: elements, fields, specs, comments).
 * 3. The slice being built: its SLICE_BORDER node and its comments.
 * 4. The board event log, incrementally: the events since the last turn's highest `seq` (kept per board in the
 *    captures folder), which includes the claim of this slice. The first turn reads the whole log.
 *
 * Never fails the turn: an error is captured and the build goes on.
 */
async function downloadBoard(sliceId: string): Promise<void> {
  if (!cap || !cfg.capturesDir) return;
  const t0 = Date.now();
  const board = loadBoardConfig();
  const out: Record<string, unknown> = { fetchedAt: new Date().toISOString(), boardId: board.boardId, organizationId: board.organizationId, baseUrl: board.baseUrl };
  const errors: string[] = [];
  const get = async (label: string, path: string, query: Record<string, string> = {}): Promise<unknown> => {
    try {
      return (await boardRequest(board, path, query, { keepBody: false, label })).json;
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
      return null;
    }
  };

  const toplevel = ((await get("board", "/nodes", { toplevel: "true" })) ?? []) as BoardNode[];
  out.toplevel = toplevel;
  const chapters = toplevel.filter((n) => n.type === "CHAPTER");
  out.chapters = [];
  for (const ch of chapters) {
    if (!ch.id) continue;
    const nodes = await get(`chapter ${nodeTitle(ch)}`, "/nodes", { chapterId: ch.id });
    const slicedata = await get(`chapter ${nodeTitle(ch)}`, "/slicedata", { contextId: ch.id });
    (out.chapters as unknown[]).push({ id: ch.id, title: nodeTitle(ch), nodes, slicedata });
  }
  out.sliceList = await get("board", "/slicedata/slices");
  out.slice = { node: await get("slice", `/nodes/${sliceId}`), comments: await get("slice", `/nodes/${sliceId}/comments`) };

  // The event log, from where the previous turn stopped.
  const seqFile = join(cfg.capturesDir, `.board-${board.boardId}-seq`);
  let since = 0;
  try {
    since = Number(readFileSync(seqFile, "utf8").trim()) || 0;
  } catch {
    since = 0;
  }
  const fromSeq = since;
  const events: unknown[] = [];
  let more = false;
  for (let page = 0; page < EVENT_PAGES_PER_TURN; page++) {
    let res: BoardResponse;
    try {
      res = await boardRequest(board, "/events", { since: String(since), skipSilent: "false" }, { keepBody: false, label: "events" });
    } catch (err) {
      errors.push(`events: ${(err as Error).message}`);
      break;
    }
    const batch = Array.isArray(res.json) ? (res.json as { seq?: number }[]) : [];
    events.push(...batch);
    more = res.headers["x-has-more"] === "true";
    if (batch.length) since = Number(batch[batch.length - 1].seq ?? since);
    if (!more || !batch.length) break;
  }
  try {
    writeFileSync(seqFile, String(since));
  } catch {
    /* next turn rereads */
  }

  const chapterCount = (out.chapters as unknown[]).length;
  cap.add("board.download", `whole board downloaded: ${toplevel.length} top-level nodes, ${chapterCount} chapter(s), ${events.length} new board event(s)${errors.length ? `, ${errors.length} error(s)` : ""}`, {
    dir: "in",
    ms: Date.now() - t0,
    data: { chapters: chapters.map(nodeTitle), toplevelNodes: toplevel.length, events: { fromSeq, toSeq: since, count: events.length, moreToRead: more }, errors },
    blobs: { "board.json": out, "board-events.json": events },
  });
}

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

type BoardSlice = { id?: string; title?: string; status?: string; sliceType?: string; contextName?: string; contextId?: string; chapterId?: string; [k: string]: unknown };

/**
 * load-slice, run by the gaffer over REST: the full definition of one slice from the board, never the summary stub.
 * One summary call finds the slice's chapter (the stub on disk may lack `contextId`), then one full fetch by
 * `contextId` (exact) with `contextName` as the fallback. Chapters can share a title and a name resolves to the first
 * match only, so the id is preferred. Throws when the slice cannot be fetched in full. Also returns the board's slice
 * list, which names every slice's chapter.
 */
async function loadFullSlice(t: Task, stub: BoardSlice): Promise<{ slice: BoardSlice; listed: BoardSlice[] }> {
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
      if (full) return { slice: full, listed };
      lastError = `slice not returned for ${Object.keys(query)[0]}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new Error(`could not load the full slice ${t.sliceId} from the board: ${lastError}`);
}

type BoardElement = { id?: string; title?: string; elementCopy?: boolean; linkedId?: string; [k: string]: unknown };
type Dependency = { id?: string; type?: string; title?: string; elementType?: string };

/** One entry of the dispatch's `sourceEvents`: the event element verbatim from its owning slice's `events[]`. */
interface SourceEvent {
  owner: { sliceId: string; title: string; status: string; sliceType: string; chapterId: string };
  event: BoardElement;
}

/**
 * The definitions of the events a STATE_VIEW slice's read models project, from the board. The read models name them
 * as INBOUND EVENT dependencies (id and title only). The full element is in the `events[]` of the slice that owns
 * it, which can be in any scope on the board, and `slicedata` returns one scope per call. So the scopes are read one
 * at a time, the slice's own chapter first, then every other chapter in the board's slice list, and reading stops as
 * soon as every event is found. A chapter id resolves to its effective MODEL_CONTEXT, so this also covers events in
 * another context. A dependency that points at a copy (`elementCopy`) resolves to the original through `linkedId`.
 * Throws when a source event is owned by no slice on the board: the definition must come from the board, never from
 * the read model.
 */
async function loadSourceEvents(slice: BoardSlice, listed: BoardSlice[]): Promise<SourceEvent[]> {
  const deps = new Map<string, string>();
  for (const rm of (slice.readmodels ?? []) as BoardElement[]) {
    for (const d of (rm.dependencies ?? []) as Dependency[]) {
      if (d.type === "INBOUND" && d.elementType === "EVENT" && d.id && !deps.has(d.id)) deps.set(d.id, d.title ?? d.id);
    }
  }
  if (deps.size === 0) return [];

  const board = loadBoardConfig();
  const own = listed.find((s) => s.id === slice.id)?.chapterId;
  let chapters = Array.from(new Set(listed.map((s) => s.chapterId).filter((c): c is string => !!c)));
  if (chapters.length === 0) {
    const toplevel = ((await boardRequest(board, "/nodes", { toplevel: "true" }, { label: "source events" })).json ?? []) as BoardNode[];
    chapters = toplevel.filter((n) => n.type === "CHAPTER" && n.id).map((n) => n.id as string);
  }
  if (own) chapters = [own, ...chapters.filter((c) => c !== own)];

  // Every event element read so far, by id, with the slice that holds it. Originals win over copies.
  const seen = new Map<string, { event: BoardElement; owner: SourceEvent["owner"] }>();
  const original = (id: string): { event: BoardElement; owner: SourceEvent["owner"] } | undefined => {
    const hit = seen.get(id);
    if (!hit?.event.elementCopy) return hit;
    const linked = hit.event.linkedId && hit.event.linkedId !== id ? seen.get(hit.event.linkedId) : undefined;
    return linked && !linked.event.elementCopy ? linked : undefined;
  };
  const scopes = new Set<string>();
  for (const chapterId of chapters) {
    if (Array.from(deps.keys()).every((id) => original(id))) break;
    const res = await boardRequest(board, "/slicedata", { contextId: chapterId }, { label: "source events" });
    const slices = (((res.json as { slices?: unknown }) ?? {}).slices ?? []) as BoardSlice[];
    // Chapters sharing one MODEL_CONTEXT return the same scope: read it once.
    const key = slices.map((s) => s.id).sort().join(",");
    if (scopes.has(key)) continue;
    scopes.add(key);
    for (const s of slices) {
      for (const e of (s.events ?? []) as BoardElement[]) {
        if (!e.id) continue;
        const prev = seen.get(e.id);
        if (prev && !prev.event.elementCopy) continue;
        const owner = { sliceId: String(s.id ?? ""), title: String(s.title ?? ""), status: String(s.status ?? ""), sliceType: String(s.sliceType ?? ""), chapterId };
        seen.set(e.id, { event: e, owner });
      }
    }
  }

  const out: SourceEvent[] = [];
  const missing: string[] = [];
  const added = new Set<string>();
  for (const [id, title] of deps) {
    const hit = original(id);
    if (!hit) {
      missing.push(`${title} (${id})`);
      continue;
    }
    if (added.has(String(hit.event.id))) continue;
    added.add(String(hit.event.id));
    out.push({ owner: hit.owner, event: hit.event });
  }
  if (missing.length) {
    throw new Error(`no slice on the board owns the source event(s) ${missing.join(", ")} of read model slice ${slice.title}: add each event to the slice that records it`);
  }
  return out;
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
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    const raw = await readBody(req).catch(() => "");
    // Every request to the listener is captured, whatever it gets back.
    const record = (status: number, note: string, parsed?: Callback): void => {
      const isDone = parsed?.outcome === "done";
      const { patch: _patch, ...rest } = (parsed ?? {}) as Record<string, unknown>;
      cap?.add("callback", `${req.method} ${url.pathname} from ${req.socket.remoteAddress ?? "?"} → ${status}${note ? ` (${note})` : ""}`, {
        dir: "in",
        ms: Date.now() - t0,
        data: { method: req.method, path: url.pathname, remote: req.socket.remoteAddress, headers: req.headers, status, bytes: raw.length, body: parsed ? rest : undefined },
        blobs: isDone ? { "callback.patch": (parsed as { patch: string }).patch } : raw ? { [`body${raw.trim().startsWith("{") ? ".json" : ".txt"}`]: prettyJson(raw) } : {},
      });
    };
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      record(404, "not a callback path");
      return;
    }
    if (m[1] !== jobId || settled) {
      emit("callback.stale", `stale callback for job ${m[1]} answered 410`);
      res.writeHead(410).end();
      record(410, `stale: job ${m[1]}`);
      return;
    }
    let body: Callback;
    try {
      body = JSON.parse(raw) as Callback;
      if (body.outcome !== "done" && body.outcome !== "failed") throw new Error("outcome must be done or failed");
      if (body.outcome === "done" && typeof body.patch !== "string") throw new Error("done needs a patch");
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
      record(400, (err as Error).message);
      return;
    }
    settled = true;
    res.writeHead(204).end();
    record(204, body.outcome, body);
    onResult(body);
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(cfg.callbackPort, cfg.callbackHost, () => resolveServer(server));
  });
}

async function dispatch(body: unknown, deadline: number): Promise<void> {
  const payload = JSON.stringify(body);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    const t0 = Date.now();
    try {
      res = await fetch(`${cfg.builderUrl}/slices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      cap?.add("dispatch", `POST ${cfg.builderUrl}/slices → ${(err as Error).message}`, {
        dir: "out",
        ms: Date.now() - t0,
        data: { url: `${cfg.builderUrl}/slices`, attempt, error: (err as Error).message },
        blobs: attempt === 1 ? { "request.json": body } : {},
      });
      throw new Error(`builder unreachable at ${cfg.builderUrl}: ${(err as Error).message}`);
    }
    const text = await res.text();
    cap?.add("dispatch", `POST ${cfg.builderUrl}/slices → HTTP ${res.status} (attempt ${attempt})`, {
      dir: "out",
      ms: Date.now() - t0,
      data: { url: `${cfg.builderUrl}/slices`, attempt, requestBytes: payload.length, status: res.status, responseHeaders: Object.fromEntries(res.headers.entries()), response: prettyJson(text) },
      blobs: attempt === 1 ? { "request.json": body } : {},
    });
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

  cap?.update({ kind: "build", jobId, slice: t.title, sliceId: t.sliceId, context: t.context });
  cap?.add("task", `build ${t.status} slice ${t.context}/${t.title}`, { dir: "in", data: { ...t, jobId } });

  const found = findSlice(t.sliceId);
  if (!found) {
    emit("turn.fail", `slice.json for ${t.sliceId} not found under .build-kit/.slices`);
    return FAILED_ATTEMPT;
  }
  // What the runner fetched and wrote for this turn (B3): the slice stub and its chapter's index.
  const indexFile = join(found.file, "..", "..", "index.json");
  cap?.add("slice.stub", `slice.json written by the runner: ${found.file.slice(cwd.length + 1)}`, {
    dir: "in",
    data: { file: found.file },
    blobs: { "slice.json": found.slice, "index.json": existsSync(indexFile) ? prettyJson(readFileSync(indexFile, "utf8")) : null },
  });

  // The slice.json on disk is a summary stub. The builder gets the full definition from the board.
  let fullSlice: BoardSlice;
  // A read model slice also gets the definitions of the events it projects (contract: `sourceEvents`).
  let sourceEvents: SourceEvent[] | undefined;
  try {
    const loaded = await loadFullSlice(t, found.slice as BoardSlice);
    fullSlice = loaded.slice;
    emit("slice.loaded", `full slice loaded from the board (${Object.keys(fullSlice).length} fields)`, { fields: Object.keys(fullSlice) });
    cap?.add("slice.full", `full slice definition for ${t.title}`, { dir: "in", data: { fields: Object.keys(fullSlice) }, blobs: { "slice.json": fullSlice } });
    if (fullSlice.sliceType === "STATE_VIEW") {
      sourceEvents = await loadSourceEvents(fullSlice, loaded.listed);
      const names = sourceEvents.map((s) => `${String(s.event.title)} (from ${s.owner.title}, ${s.owner.status})`);
      emit("source.events", `${sourceEvents.length} source event definition(s) loaded from the board${names.length ? `: ${names.join(", ")}` : ""}`, { events: names });
      cap?.add("source.events", `source event definitions for ${t.title}: ${sourceEvents.length}`, { dir: "in", data: { events: names }, blobs: { "source-events.json": sourceEvents } });
    }
  } catch (err) {
    const reason = (err as Error).message;
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return FAILED_ATTEMPT;
  }
  try {
    await downloadBoard(t.sliceId);
  } catch (err) {
    cap?.add("error", `board download failed: ${(err as Error).message}`);
  }
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

  // A slice with nothing to build is Blocked at once: retrying cannot help until the model changes on the board.
  const empty = emptyReason(fullSlice);
  if (empty) {
    note(`gaffer: ${empty}`);
    try {
      em(["slice-status", "Blocked"]);
    } catch (err) {
      emit("turn.fail", `could not record Blocked: ${(err as Error).message}`);
      return FAILED_ATTEMPT;
    }
    emit("blocked", `slice recorded as Blocked: ${empty}`, { reason: empty });
    return 0;
  }

  // 1. base = HEAD of the selected branch, pushed so the builder can fetch it.
  let base: string;
  let changes: Changes;
  try {
    base = await syncAndPushBranch();
    emit("push", `${cfg.branch} pushed before dispatch`);
    changes = compareWithBaseline(base, t, fullSlice, sourceEvents ?? []);
  } catch (err) {
    const reason = (err as Error).message;
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return FAILED_ATTEMPT;
  }
  emit("changes", `since the last build: ${summarise(changes)}`, { verdict: changes.verdict, since: changes.since?.commit });
  cap?.add("changes", `changes since the last build: ${changes.verdict}`, { dir: "local", data: { verdict: changes.verdict, since: changes.since }, blobs: { "changes.json": changes } });

  // Nothing the builder would see has changed since the code on this branch was built: no job, only the gate.
  if (changes.verdict === "UNCHANGED") {
    try {
      runGate();
      const status = t.handover ? "Waiting" : "Done";
      em(["slice-status", status]);
      emit("unchanged", `slice unchanged since ${changes.since?.commit.slice(0, 12)}: recorded as ${status} without a build`, { status });
      emit("turn.end", `turn finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      return 0;
    } catch (err) {
      const reason = (err as Error).message;
      emit("turn.fail", reason);
      note(`gaffer: ${reason}`);
      return FAILED_ATTEMPT;
    }
  }
  const baseline: Baseline = {
    sliceId: t.sliceId,
    title: String(fullSlice.title ?? t.title),
    sliceType: String(fullSlice.sliceType ?? ""),
    recordedAt: "",
    jobId,
    slice: fullSlice,
    sourceEvents: sourceEvents ?? [],
  };

  const requires = Array.from(new Set([`repo:${repoKey(cfg.repoUrl || git(["remote", "get-url", "origin"]))}`, ...cfg.requires]));
  const publicHost = cfg.callbackPublicHost || cfg.callbackHost;
  const callback = `http://${publicHost}:${cfg.callbackPort}/jobs/${jobId}`;
  const attempt = Number(process.env.GAFFER_ATTEMPT ?? 1) || 1;
  const request = {
    requires,
    repo: { url: cfg.repoUrl || git(["remote", "get-url", "origin"]), base },
    task: { sliceId: t.sliceId, title: t.title, context: t.context, handover: t.handover, attempt },
    slice: fullSlice,
    ...(sourceEvents ? { sourceEvents } : {}),
    changes,
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
    return applyAndMerge(t, base, cb.patch, baseline);
  } catch (err) {
    const reason = (err as Error).message;
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return FAILED_ATTEMPT;
  } finally {
    server.close();
  }
}

/**
 * The slice's baseline as the base commit holds it (`.gaffer/slices/<sliceId>.json`), compared with what is about to be
 * dispatched. Read from the base, not from a working tree, so every branch is compared with its own last build.
 * Throws on a baseline that cannot be parsed: the gaffer wrote it, so it is a fault, not a new slice.
 */
function compareWithBaseline(base: string, t: Task, slice: BoardSlice, sourceEvents: SourceEvent[]): Changes {
  const path = baselinePath(t.sliceId);
  const raw = spawnSync("git", ["show", `${base}:${path}`], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (raw.status !== 0) return compare(null, null, slice, sourceEvents);
  let prev: Baseline;
  try {
    prev = JSON.parse(raw.stdout) as Baseline;
  } catch (err) {
    throw new Error(`the baseline ${path} at ${base.slice(0, 12)} is not valid JSON: ${(err as Error).message}`);
  }
  const commit = git(["log", "-1", "--format=%H", base, "--", path]);
  return compare(prev, { commit, recordedAt: prev.recordedAt }, slice, sourceEvents);
}

/** The gate: a shell command run in the clone. Empty passes. Throws when it fails. */
function runGate(): void {
  if (!cfg.gate || !cfg.gate.trim()) {
    emit("gate.ok", "no gate configured: passing");
    return;
  }
  emit("gate", `running gate: ${cfg.gate}`);
  const g0 = Date.now();
  const res = spawnSync("sh", ["-c", cfg.gate], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  cap?.add("gate", `gate \`${cfg.gate}\` → exit ${res.status}`, { dir: "local", ms: Date.now() - g0, data: { command: cfg.gate, exit: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" } });
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim().slice(-2000);
  if (res.status !== 0) throw new Error(`gate failed (exit ${res.status}): ${out}`);
  emit("gate.ok", "gate passed");
}

function applyAndMerge(t: Task, base: string, patch: string, baseline: Baseline): number {
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
    cap?.add("applied", `${commits} commit(s) applied on ${branch}`, {
      dir: "local",
      data: { base, head: git(["rev-parse", "HEAD"]), branch, commits: Number(commits) },
      blobs: {
        "commits.txt": git(["log", "--stat", "--format=fuller", `${base}..HEAD`]),
        "applied.diff": git(["diff", `${base}..HEAD`]),
      },
    });

    // .gaffer/ is the gaffer's build record: only the gaffer writes it.
    const touched = git(["diff", "--name-only", `${base}..HEAD`]).split("\n").filter((f) => f.startsWith(`${BASELINE_DIR.split("/")[0]}/`));
    if (touched.length) throw new Error(`the builder's patch touches the gaffer's build record: ${touched.join(", ")}`);

    // The baseline is committed with the code it describes, so a merge or a later build on this branch finds both.
    const path = baselinePath(t.sliceId);
    mkdirSync(join(cwd, BASELINE_DIR), { recursive: true });
    writeFileSync(join(cwd, path), stable({ ...baseline, recordedAt: new Date().toISOString() }, "  ") + "\n");
    git(["add", "--", path]);
    git(["commit", "-q", "-m", `gaffer: record ${t.title} baseline`, "--", path]);
    emit("baseline", `baseline committed: ${path}`, { path });

    runGate();

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

/** Start the turn's capture and record what the runner handed over: prompt, environment, arguments, config. */
function startCapture(prompt: string, promptFile: string | undefined): void {
  if (!cfg.capturesDir) return;
  try {
    cap = new Capture(cfg.capturesDir, secrets);
  } catch (err) {
    console.error(`[gaffer] capture disabled: ${(err as Error).message}`);
    return;
  }
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => /^(RALPH_|EVENTMODELERS_|GAFFER_)/.test(k))
      .map(([k, v]) => [k, /TOKEN|SECRET|KEY/i.test(k) ? "***" : v]),
  );
  cap.add("prompt", `prompt from the runner (${prompt.length} chars)`, { dir: "in", data: { file: promptFile }, blobs: { "prompt.md": prompt } });
  cap.add("env", "runner environment and arguments", { dir: "in", data: { cwd, argv: process.argv.slice(0, -1), pid: process.pid, env } });
  cap.add("config", "gaffer configuration", { dir: "local", blobs: { "gaffer.json": cfg } });
}

/** Close the capture: outcome, exit code, duration and the runner's log around the turn. */
function finishCapture(code: number): void {
  if (!cap) return;
  cap.runnerLog(cfg.runLog);
  const s = cap.summary;
  cap.update({ endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, exitCode: code, outcome: s.outcome ?? (s.kind === "skip" ? "skipped" : "failed") });
}

async function main(): Promise<number> {
  cfg = loadConfig();
  const promptFile = process.env.RALPH_PROMPT_FILE;
  const prompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8") : String(process.argv[process.argv.length - 1] ?? "");
  startCapture(prompt, promptFile);
  const t = parseTask(prompt);
  if (!t) {
    cap?.update({ kind: "skip", outcome: "skipped" });
    emit("turn.skip", "not a build turn (task or curation turn): nothing to do");
    return 0;
  }
  return buildTurn(t);
}

main().then(
  (code) => {
    finishCapture(code);
    process.exit(code);
  },
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
    try {
      cap?.update({ outcome: "failed", reason: `fatal: ${(err as Error).message}` });
      finishCapture(FAILED_ATTEMPT);
    } catch {
      /* ignore */
    }
    process.exit(FAILED_ATTEMPT);
  },
);
