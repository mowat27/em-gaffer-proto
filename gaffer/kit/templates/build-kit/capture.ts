/**
 * capture.ts: a full record of one gaffer turn on disk, for the gaffer TSF's Turns tab.
 *
 * One folder per turn under `capturesDir`: `turn.json` (the summary, rewritten as the turn goes), `entries.jsonl` (one
 * line per thing received, sent or changed) and `blobs/` (every body too large or too raw to inline: slice data, board
 * downloads, HTTP bodies, git output, the patch). Writes are synchronous, so a `process.exit` loses nothing.
 * Tokens are masked before anything is written.
 *
 * Runs on Node 24 type stripping: only erasable TypeScript syntax is used.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Inline strings up to this size; larger ones become blobs. */
const INLINE_MAX = 4096;

export interface TurnSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  kind: "build" | "skip" | "unknown";
  outcome?: "merged" | "unchanged" | "blocked" | "failed" | "skipped";
  reason?: string;
  exitCode?: number;
  jobId?: string;
  slice?: string;
  sliceId?: string;
  context?: string;
  entries: number;
  blobs: number;
  bytes: number;
}

export interface BlobRef {
  name: string;
  file: string;
  bytes: number;
  type: string;
}

/** Mask tokens: `token=<value>` (not `token=$VAR`), `x-token` headers and values, credentials in URLs. */
export function redact(s: string): string {
  return s
    .replace(/(token=)(?!\$)[^\s&"']+/gi, "$1***")
    .replace(/("x-token"\s*:\s*")[^"]*"/gi, '$1***"')
    .replace(/("token"\s*:\s*")[^"]*"/gi, '$1***"')
    .replace(/https?:\/\/[^\s@/]+@[^\s"']+/g, "http://***@***");
}

function blobType(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".patch") || name.endsWith(".diff")) return "text/x-diff";
  if (name.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

export class Capture {
  readonly root: string;
  readonly dir: string;
  readonly summary: TurnSummary;
  private readonly secrets: () => string[];
  private n = 0;

  constructor(root: string, secrets: () => string[]) {
    this.root = root;
    this.secrets = secrets;
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const id = `${stamp}-${process.pid}`;
    this.dir = join(root, id);
    mkdirSync(join(this.dir, "blobs"), { recursive: true });
    this.summary = { id, startedAt: now.toISOString(), kind: "unknown", entries: 0, blobs: 0, bytes: 0 };
    this.save();
  }

  /** Mask every known secret value as well as the token patterns. */
  mask(s: string): string {
    let out = s;
    for (const secret of this.secrets()) if (secret && secret.length >= 8) out = out.split(secret).join("***");
    return redact(out);
  }

  update(patch: Partial<TurnSummary>): void {
    Object.assign(this.summary, patch);
    this.save();
  }

  private save(): void {
    try {
      writeFileSync(join(this.dir, "turn.json"), JSON.stringify(this.summary, null, 2) + "\n");
    } catch {
      /* capture never breaks a turn */
    }
  }

  /** Write a blob for entry `n` and return its reference. Objects are written as pretty JSON. */
  private blob(n: number, name: string, content: unknown): BlobRef {
    const text = this.mask(typeof content === "string" ? content : JSON.stringify(content, null, 2));
    const file = `${String(n).padStart(4, "0")}-${name.replace(/[^\w.-]+/g, "_")}`;
    writeFileSync(join(this.dir, "blobs", file), text);
    const bytes = Buffer.byteLength(text);
    this.summary.blobs += 1;
    this.summary.bytes += bytes;
    return { name, file, bytes, type: blobType(name) };
  }

  /**
   * Record one entry. `data` is inlined (long strings in it move to blobs automatically); `blobs` are always written as
   * files. `dir` says which way it went: in (received), out (sent), local (changed here).
   */
  add(kind: string, title: string, opts: { dir?: "in" | "out" | "local"; data?: Record<string, unknown>; blobs?: Record<string, unknown>; ms?: number } = {}): number {
    const n = ++this.n;
    try {
      const refs: BlobRef[] = [];
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(opts.data ?? {})) {
        if (typeof v === "string" && v.length > INLINE_MAX) {
          refs.push(this.blob(n, `${k}.txt`, v));
          data[k] = `(${v.length} chars, in blob ${k}.txt)`;
        } else data[k] = v;
      }
      for (const [name, content] of Object.entries(opts.blobs ?? {})) {
        if (content === undefined || content === null) continue;
        refs.push(this.blob(n, name, content));
      }
      const line = { n, ts: new Date().toISOString(), kind, title: this.mask(title), dir: opts.dir ?? "local", ms: opts.ms, data: JSON.parse(this.mask(JSON.stringify(data))), blobs: refs };
      const text = JSON.stringify(line) + "\n";
      appendFileSync(join(this.dir, "entries.jsonl"), text);
      this.summary.entries = n;
      this.summary.bytes += Buffer.byteLength(text);
      this.save();
    } catch (err) {
      console.error(`[gaffer] capture failed for ${kind}: ${(err as Error).message}`);
    }
    return n;
  }

  /**
   * The runner's log since the previous turn ended: the claim, slice fetch and status push the shared runner did
   * around this turn. The offset is kept in `<root>/.runlog-offset`.
   */
  runnerLog(runLog: string | undefined): void {
    if (!runLog || !existsSync(runLog)) return;
    const offsetFile = join(this.root, ".runlog-offset");
    let from = 0;
    try {
      from = Number(readFileSync(offsetFile, "utf8").trim()) || 0;
    } catch {
      from = 0;
    }
    try {
      const size = statSync(runLog).size;
      if (from > size) from = 0;
      const fd = openSync(runLog, "r");
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      closeSync(fd);
      writeFileSync(offsetFile, String(size));
      const text = buf.toString("utf8");
      this.add("runner.log", `runner log since the previous turn (${text.split("\n").filter(Boolean).length} lines)`, {
        dir: "in",
        data: { file: runLog, fromByte: from, toByte: size },
        blobs: { "runner.log": text },
      });
    } catch (err) {
      this.add("error", `could not read the runner log: ${(err as Error).message}`);
    }
  }
}
