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
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface GafferConfig {
  name: string;
  repoUrl: string;
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
    builderUrl: raw.builderUrl.replace(/\/+$/, ""),
    callbackHost: raw.callbackHost ?? "127.0.0.1",
    callbackPort: Number(raw.callbackPort ?? 8787),
    callbackPublicHost: raw.callbackPublicHost,
    requires: Array.isArray(raw.requires) ? raw.requires : [],
    gate: raw.gate ?? "",
    turnTimeoutMinutes: Number(raw.turnTimeoutMinutes ?? 60),
    eventsFile: raw.eventsFile,
  };
}

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
    return 1;
  }

  // 1. base = HEAD of main, pushed so the builder can fetch it.
  git(["checkout", "-q", "main"]);
  const base = git(["rev-parse", "HEAD"]);
  emit("base", `base ${base.slice(0, 12)} on main`, { base });
  git(["push", "-q", "origin", "main"]);
  emit("push", "main pushed before dispatch");

  const requires = Array.from(new Set([`repo:${repoKey(cfg.repoUrl || git(["remote", "get-url", "origin"]))}`, ...cfg.requires]));
  const publicHost = cfg.callbackPublicHost || cfg.callbackHost;
  const callback = `http://${publicHost}:${cfg.callbackPort}/jobs/${jobId}`;
  const attempt = Number(process.env.GAFFER_ATTEMPT ?? 1) || 1;
  const request = {
    requires,
    repo: { url: cfg.repoUrl || git(["remote", "get-url", "origin"]), base },
    task: { sliceId: t.sliceId, title: t.title, context: t.context, handover: t.handover, attempt },
    slice: found.slice,
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
      return 1;
    }
    if (cb.outcome === "failed") {
      emit("result.failed", `builder failed: ${cb.reason}`, { reason: cb.reason });
      note(`builder failed: ${cb.reason}`);
      return 1;
    }
    emit("result.done", `builder returned a patch (${cb.patch.length} bytes)`, { bytes: cb.patch.length });
    return applyAndMerge(t, base, cb.patch);
  } catch (err) {
    const reason = (err as Error).message;
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return 1;
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
      emit("gate.ok", "no gate configured (stub build): passing");
    }

    git(["checkout", "-q", "main"]);
    git(["merge", "--ff-only", branch]);
    git(["push", "-q", "origin", "main"]);
    const head = git(["rev-parse", "HEAD"]);
    emit("merged", `main fast-forwarded to ${head.slice(0, 12)} and pushed`, { head });
    git(["branch", "-D", branch], { allowFail: true });

    const status = t.handover ? "Waiting" : "Done";
    em(["slice-status", status]);
    emit("settled", `slice recorded as ${status}`, { status });
    emit("turn.end", `turn finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return 0;
  } catch (err) {
    const reason = (err as Error).message;
    git(["checkout", "-q", "-f", "main"], { allowFail: true });
    git(["branch", "-D", branch], { allowFail: true });
    emit("turn.fail", reason);
    note(`gaffer: ${reason}`);
    return 1;
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
    process.exit(1);
  },
);
