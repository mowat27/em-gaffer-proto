/**
 * Listeners: observe-only hooks on journal events (design section 6). They run in the workflow run's process,
 * asynchronously, on the events of the run and of every run its journal links to (a step's `childRunId`), tailing
 * those runs' journal files. They are never awaited on the step path: an event is queued for each matching listener
 * and handled on a later turn of the event loop, one event at a time per listener.
 *
 * A listener that throws is logged and the error journaled as `listener.error`; after 3 errors it is switched off for
 * the job (`listener.off`, E10). The build is never affected (G7). A listener has no access to the context store or
 * the workspace: it can only emit journal events, write artifacts under runs/<id>/artifacts/<listener>/, and add its
 * totals to the run's summary.json.
 *
 * Where they come from: every module in agentics/shared/listeners/ (all workflow runs), then the builder's own
 * `listeners: [...]`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { JOURNAL_FILE, type JournalEvent, type JournalSink } from "../runtime/journal.ts";

export interface ListenerApi {
  /** Append an event to the workflow run's journal (its data carries the listener's name). */
  emit(kind: string, data: Record<string, unknown>): void;
  /** Write runs/<id>/artifacts/<listener>/<name>. */
  artifact(name: string, content: string): void;
  /** Put `data` under the listener's name in the run's summary.json (the latest call wins). */
  summary(data: Record<string, unknown>): void;
}

export interface Listener {
  /** Default: the module's file name for a shared listener, `listener-<n>` for a builder's. */
  name?: string;
  /** An event kind, a prefix ending in `*` ("tool.*"), or "*" for every event. */
  on: string;
  /** Every key must equal the event's own field (step, agent, runId, span, parent) or else its data field. */
  match?: Partial<Record<string, unknown>>;
  handle(e: JournalEvent, api: ListenerApi): void | Promise<void>;
}

export const defineListener = (l: Listener): Listener => l;

export const MAX_LISTENER_ERRORS = 3;

const TOP_LEVEL = new Set(["seq", "ts", "runId", "step", "agent", "span", "parent", "kind"]);

export function isListener(v: unknown): v is Listener {
  const l = v as Listener | null;
  return !!l && typeof l === "object" && typeof l.on === "string" && typeof l.handle === "function";
}

/** Does the listener want this event? */
export function matches(l: Listener, e: JournalEvent): boolean {
  const on = l.on;
  if (on !== "*" && !(on.endsWith("*") ? e.kind.startsWith(on.slice(0, -1)) : e.kind === on)) return false;
  for (const [k, want] of Object.entries(l.match ?? {})) {
    const have = TOP_LEVEL.has(k) ? (e as unknown as Record<string, unknown>)[k] : e.data?.[k];
    if (have !== want) return false;
  }
  return true;
}

/** The listeners in agentics/shared/listeners/ (each module's default export), named after their files. */
export async function sharedListeners(agenticsDir: string): Promise<{ name: string; listener: Listener }[]> {
  const dir = join(agenticsDir, "shared", "listeners");
  if (!existsSync(dir)) return [];
  const out: { name: string; listener: Listener }[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.m?ts$/.test(f)).sort()) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
    if (!isListener(mod.default)) throw new Error(`shared/listeners/${file}: its default export is not a listener (defineListener)`);
    out.push({ name: mod.default.name ?? basename(file).replace(/\.m?ts$/, ""), listener: mod.default });
  }
  return out;
}

interface Entry {
  name: string;
  listener: Listener;
  errors: number;
  off: boolean;
  queue: Promise<void>;
}

interface Tail {
  file: string;
  offset: number;
  partial: string;
}

const nextTurn = () => new Promise<void>((r) => setImmediate(r));
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const SAFE_NAME = /^[\w.-]+$/;

export interface ListenerHostOptions {
  /** The workflow run's journal: listener events go here. */
  journal: JournalSink;
  /** The workflow run's folder (artifacts/, and the runs directory its children are in). */
  runDir: string;
  listeners: { name: string; listener: Listener }[];
  /** Where a listener's errors are logged (the job log). */
  log?(text: string): void;
  /** How often followed journals are read. Default 200 ms. */
  pollMs?: number;
}

export class ListenerHost {
  private readonly o: ListenerHostOptions;
  private readonly entries: Entry[];
  private readonly tails = new Map<string, Tail>();
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(o: ListenerHostOptions) {
    this.o = o;
    this.entries = o.listeners.map(({ name, listener }) => ({ name, listener, errors: 0, off: false, queue: Promise.resolve() }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** An event of the workflow run's own journal (the writer's onEvent). */
  observe(e: JournalEvent): void {
    this.dispatch(e);
  }

  /** Tail another run's journal: a child run's, found through a step event's childRunId. */
  follow(runDir: string): void {
    if (this.done || this.tails.has(runDir)) return;
    this.tails.set(runDir, { file: join(runDir, JOURNAL_FILE), offset: 0, partial: "" });
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.o.pollMs ?? 200);
      this.timer.unref();
    }
  }

  /** Read what the followed runs have written since the last poll and dispatch it. */
  private poll(): void {
    for (const t of this.tails.values()) {
      try {
        if (!existsSync(t.file)) continue;
        const size = statSync(t.file).size;
        if (size <= t.offset) continue;
        const fd = openSync(t.file, "r");
        const buf = Buffer.alloc(size - t.offset);
        try {
          readSync(fd, buf, 0, buf.length, t.offset);
        } finally {
          closeSync(fd);
        }
        t.offset = size;
        t.partial += buf.toString("utf8");
        for (let nl = t.partial.indexOf("\n"); nl >= 0; nl = t.partial.indexOf("\n")) {
          const line = t.partial.slice(0, nl);
          t.partial = t.partial.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            this.dispatch(JSON.parse(line) as JournalEvent);
          } catch {
            /* a torn line */
          }
        }
      } catch {
        /* read again next time */
      }
    }
  }

  private dispatch(e: JournalEvent): void {
    if (this.done || !e || typeof e.kind !== "string") return;
    // The tree: a child run named by a step event is followed from here on.
    const child = e.data?.childRunId;
    if (typeof child === "string" && SAFE_NAME.test(child)) this.follow(join(dirname(this.o.runDir), child));
    // A listener's own events (and its errors) never reach listeners.
    if (e.data && "listener" in e.data) return;
    for (const entry of this.entries) {
      if (entry.off || !matches(entry.listener, e)) continue;
      entry.queue = entry.queue.then(nextTurn).then(() => this.run(entry, e));
    }
  }

  private async run(entry: Entry, e: JournalEvent): Promise<void> {
    if (entry.off) return;
    try {
      await entry.listener.handle(e, this.api(entry));
    } catch (err) {
      entry.errors++;
      const error = messageOf(err);
      this.o.log?.(`[builder] listener ${entry.name} failed on ${e.kind} (seq ${e.seq}): ${error}\n`);
      this.o.journal.append({ kind: "listener.error", data: { listener: entry.name, error, event: { runId: e.runId, seq: e.seq, kind: e.kind }, errors: entry.errors } });
      if (entry.errors >= MAX_LISTENER_ERRORS) {
        entry.off = true;
        this.o.log?.(`[builder] listener ${entry.name} is off for this job after ${entry.errors} errors\n`);
        this.o.journal.append({ kind: "listener.off", data: { listener: entry.name, errors: entry.errors } });
      }
    }
  }

  private api(entry: Entry): ListenerApi {
    return {
      emit: (kind, data) => {
        this.o.journal.append({ kind, data: { ...(data ?? {}), listener: entry.name } });
      },
      artifact: (name, content) => {
        if (!SAFE_NAME.test(name) || name === "." || name === "..") throw new Error(`artifact name ${JSON.stringify(name)}: letters, digits, _ . - only`);
        const dir = join(this.o.runDir, "artifacts", entry.name);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, content);
        this.o.journal.append({ kind: "listener.artifact", data: { listener: entry.name, name, path, bytes: Buffer.byteLength(content) } });
      },
      summary: (data) => this.o.journal.summarize?.(entry.name, data),
    };
  }

  /**
   * At the end of the workflow run: read the rest of every followed journal, give the listeners up to `graceMs` to
   * handle what is queued, then stop. Events after this are not dispatched.
   */
  async finish(graceMs = 2000): Promise<void> {
    this.poll();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.entries.map((e) => e.queue)),
      new Promise<void>((r) => {
        timeout = setTimeout(r, graceMs);
      }),
    ]);
    clearTimeout(timeout);
    this.done = true;
  }
}
