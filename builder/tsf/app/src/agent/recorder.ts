/**
 * The run recorder (DESIGN 7 "Recorder"). It reads the feed's raw commits (`FeedCommit`: the watch's ConversationView
 * plus the entries it added), never ChatItems, and keeps `runs` / `run_tools` in tsf/data/tsf.sqlite. No hook feeds it:
 * hooks rerun on replay and stop after `restartLimit`, while committed state is the same after any number of crashes.
 *
 * A run is the span in which `docs["pi.live"].run` is present. Its `id` is the first `run.taskId` seen (the run's
 * task is handed from one generation to the next, so the id is fixed once and the rest of the run is told by
 * `run.first`). Entries of the run: id >= `run.first` and `byTaskId >= run id` (task ids ascend, so a continue, which
 * keeps the failed run's `first`, does not count the failed run's entries again). A restart matches the open run by
 * `first_entry` and pages `main.entries` from there, so it neither duplicates nor loses rows.
 *
 * Observed on 1.5.0: the commit that ends a run also carries its last entry, and a run that ends without an answer
 * carries `pi.live.runFailure` in that same commit.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AppDb, RunRow } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import type { RunListInput } from "../core/service-api.ts";
import type { AppBus } from "../shared/events.ts";
import { CRON_ENTRY_KIND, type RunDetail, type RunSummary, type RunToolCall, type ToolStatus } from "../shared/types.ts";
import { resultStatus } from "./chat-view.ts";
import type { ChatFeed, FeedCommit } from "./feed.ts";

export interface RunRecorder {
  /** Newest first. */
  list(input: RunListInput): RunSummary[];
  get(id: number): RunDetail | undefined;
  /** Stops listening. An open run stays `running` in the db: the next recorder matches it by `first_entry`. */
  stop(): void;
}

export interface RecorderOptions {
  readonly feed: ChatFeed;
  readonly main: Conversation;
  readonly db: AppDb;
  readonly bus: AppBus;
  readonly log: Logger;
}

const PROMPT_CAP = 300;
const PAGE = 200;

interface LiveRun {
  readonly taskId: number;
  readonly turns: number;
  readonly first: number | undefined;
}

interface LiveToolSlot {
  readonly callId: string;
  readonly status: string;
}

interface LiveView {
  readonly run: LiveRun | undefined;
  readonly failure: { readonly reason: string; readonly first: number | undefined; readonly taskId: number | undefined } | undefined;
  readonly tools: readonly LiveToolSlot[];
}

/** The run being recorded. */
interface Tracked {
  readonly id: number;
  first: number | undefined;
  trigger: RunSummary["trigger"];
  /** The trigger is settled once the first entry is known (or restored from a row). */
  triggerFixed: boolean;
  startedAt: number;
  turns: number;
  /** Entries of the run (and a few before it), by id. */
  readonly entries: Map<number, EntryRecord>;
  /** The first entry was looked for in `main.entries`. */
  caughtUp: boolean;
  toolsSig: string;
  lastSig: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readLive(commit: FeedCommit): LiveView {
  const live = commit.value.docs["pi.live"] as unknown;
  if (!isRecord(live)) return { run: undefined, failure: undefined, tools: [] };
  let run: LiveRun | undefined;
  if (isRecord(live.run) && num(live.run.taskId) !== undefined) {
    run = { taskId: live.run.taskId as number, turns: num(live.run.turns) ?? 0, first: num(live.run.first) };
  }
  let failure: LiveView["failure"];
  if (isRecord(live.runFailure)) {
    failure = {
      reason: typeof live.runFailure.reason === "string" ? live.runFailure.reason : "faulted",
      first: num(live.runFailure.first),
      taskId: num(live.runFailure.taskId),
    };
  }
  const tools: LiveToolSlot[] = Array.isArray(live.tools)
    ? live.tools.flatMap((t: unknown) =>
        isRecord(t) && typeof t.callId === "string" ? [{ callId: t.callId, status: String(t.status ?? "") }] : [],
      )
    : [];
  return { run, failure, tools };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("");
}

function messageOf<M extends { role: string }>(entry: EntryRecord, role: M["role"]): M | undefined {
  return entry.model?.find((m) => m.role === role) as M | undefined;
}

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function firstDiagnosticCode(entry: EntryRecord): string | undefined {
  const diagnostics = isRecord(entry.data) && Array.isArray(entry.data.diagnostics) ? entry.data.diagnostics : [];
  const first = diagnostics.find((d): d is { code: string } => isRecord(d) && typeof d.code === "string");
  return first?.code;
}

/** What a run's entries add up to. */
interface Derived {
  readonly model: string | null;
  readonly toolCalls: number;
  readonly usage: RunSummary["usage"];
  readonly costSource: RunSummary["costSource"];
  readonly tools: RunToolCall[];
}

function derive(t: Tracked, live: LiveView, final: boolean): Derived {
  const entries = [...t.entries.values()].sort((a, b) => a.id - b.id);
  const mine = (e: EntryRecord): boolean =>
    (t.first === undefined || (e.id as number) >= t.first) && (e.byTaskId === undefined || (e.byTaskId as number) >= t.id);

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let steps = 0;
  let fromProvider = 0;
  let model: string | null = null;
  const calls: { callId: string; name: string; args: string }[] = [];
  const results = new Map<string, { message: ToolResultMessage; code: string | undefined }>();

  for (const e of entries) {
    if (!mine(e)) continue;
    if (e.kind === "pi.assistant") {
      const m = messageOf<AssistantMessage>(e, "assistant");
      if (!m) continue;
      steps++;
      const u = m.usage;
      input += u?.input ?? 0;
      output += u?.output ?? 0;
      cacheRead += u?.cacheRead ?? 0;
      cacheWrite += u?.cacheWrite ?? 0;
      totalTokens += u?.totalTokens ?? 0;
      costUsd += u?.cost?.total ?? 0;
      if (u?.cost?.totalFromProvider === true) fromProvider++;
      if (m.provider && m.model) model = `${m.provider}/${m.model}`;
      for (const block of m.content) {
        if (block.type === "toolCall") {
          calls.push({ callId: block.id, name: block.name, args: JSON.stringify(block.arguments ?? {}) });
        }
      }
    } else if (e.kind === "pi.tool-result") {
      for (const m of e.model ?? []) {
        if (m.role !== "toolResult") continue;
        const r = m as ToolResultMessage;
        results.set(r.toolCallId, { message: r, code: r.isError ? firstDiagnosticCode(e) : undefined });
      }
    }
  }

  const slots = new Map(live.tools.map((s) => [s.callId, s.status]));
  const tools: RunToolCall[] = calls.map((c) => {
    const res = results.get(c.callId);
    if (res) {
      return {
        callId: c.callId,
        name: c.name,
        status: resultStatus(res.message.isError, res.code),
        durationMs: typeof res.message.durationMs === "number" ? res.message.durationMs : null,
        diagnostic: res.code ?? null,
        args: cap(c.args, 20_000),
        output: cap(textOf(res.message.content), 20_000),
      };
    }
    const status: ToolStatus = final ? "interrupted" : slots.get(c.callId) === "running" ? "running" : "pending";
    return { callId: c.callId, name: c.name, status, durationMs: null, diagnostic: null, args: cap(c.args, 20_000), output: "" };
  });

  return {
    model,
    toolCalls: calls.length,
    usage: { input, output, cacheRead, cacheWrite, totalTokens, costUsd },
    costSource: steps > 0 && fromProvider === steps ? "provider" : "estimate",
    tools,
  };
}

class Recorder implements RunRecorder {
  readonly #opts: RecorderOptions;
  readonly #ctx: Context = BACKGROUND_CONTEXT;
  #cur: Tracked | undefined;
  #chain: Promise<void> = Promise.resolve();
  #stopped = false;
  #unsubscribe: (() => void) | undefined;

  constructor(opts: RecorderOptions) {
    this.#opts = opts;
  }

  /** Subscribe, then reconcile from `feed.current()`: both in one synchronous step, so no commit falls between. */
  async start(): Promise<void> {
    const { feed } = this.#opts;
    this.#unsubscribe = feed.onCommit((commit) => this.#enqueue(commit, false));
    this.#enqueue(feed.current(), true);
    await this.#chain;
  }

  list(input: RunListInput): RunSummary[] {
    return this.#opts.db.runs.list(input);
  }

  get(id: number): RunDetail | undefined {
    return this.#opts.db.runs.get(id);
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  // --- internals -------------------------------------------------------------------------------------------------

  #enqueue(commit: FeedCommit, boot: boolean): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#stopped) return;
      try {
        await this.#process(commit, boot);
      } catch (err) {
        if (!this.#stopped) this.#opts.log.error("recorder.failed", { error: err });
      }
    });
  }

  async #process(commit: FeedCommit, boot: boolean): Promise<void> {
    const live = readLive(commit);
    let added: readonly EntryRecord[] = commit.added;

    // A new run placed in the very commit that ends the previous one (a follow-up): close the old one first.
    if (this.#cur && live.run?.first !== undefined && this.#cur.first !== undefined && live.run.first !== this.#cur.first) {
      const boundary = live.run.first;
      const mineNow = added.filter((e) => (e.id as number) < boundary);
      added = added.filter((e) => (e.id as number) >= boundary);
      this.#absorb(this.#cur, mineNow);
      await this.#finish(this.#cur, { run: undefined, failure: undefined, tools: [] }, commit.at);
      this.#cur = undefined;
    }

    if (!this.#cur && live.run) {
      this.#cur = await this.#open(live.run, commit, boot);
      if (this.#stopped) return;
      this.#absorb(this.#cur, added);
      if (boot) await this.#closeStale(commit, { ...live, failure: undefined }, this.#cur.id);
    } else if (this.#cur) {
      this.#absorb(this.#cur, added);
    } else if (boot) {
      await this.#closeStale(commit, live, undefined);
      return;
    } else {
      return;
    }

    const cur = this.#cur;
    if (live.run) {
      const toolsSig = live.tools.map((t) => `${t.callId}:${t.status}`).join(",");
      const changed = added.length > 0 || live.run.turns !== cur.turns || toolsSig !== cur.toolsSig || cur.lastSig === "";
      if (live.run.first !== undefined && cur.first === undefined) {
        cur.first = live.run.first;
        await this.#settleFirst(cur, commit);
      }
      cur.turns = live.run.turns;
      cur.toolsSig = toolsSig;
      if (changed) this.#save(cur, live, "running", null, null);
      return;
    }
    await this.#finish(cur, live, commit.at);
    this.#cur = undefined;
  }

  /** Start tracking `run`: reuse the open row with the same `first_entry` (a restart), else begin a new row. */
  async #open(run: LiveRun, commit: FeedCommit, boot: boolean): Promise<Tracked> {
    const { db } = this.#opts;
    const open = db.runs.running();
    const existing =
      (run.first !== undefined ? open.find((r) => r.firstEntry === run.first) : undefined) ??
      open.find((r) => r.id === run.taskId);
    const t: Tracked = {
      id: existing?.id ?? run.taskId,
      first: run.first ?? existing?.firstEntry ?? undefined,
      trigger: existing?.trigger ?? "system",
      triggerFixed: existing !== undefined,
      startedAt: existing?.startedAt ?? commit.at,
      turns: run.turns,
      entries: new Map(),
      caughtUp: false,
      toolsSig: "",
      lastSig: "",
    };
    if (boot && existing === undefined) {
      // A run already open at boot that no row knows (the db was new or lost): it is recorded from its first entry.
      this.#opts.log.info("recorder.adopt", { runId: t.id });
    }
    if (t.first !== undefined && (boot || existing !== undefined)) await this.#catchUp(t);
    // The commit's own entries come after, so the paged ones never overwrite fresher records.
    if (!t.triggerFixed) await this.#settleFirst(t, commit, true);
    return t;
  }

  /**
   * Fix the trigger and the start time from the first entry. For a run opened by this commit the entry is in
   * `commit.added`; otherwise (a continue keeps the failed run's `first`, or a restart) it is paged from storage.
   */
  async #settleFirst(t: Tracked, commit: FeedCommit, opening = false): Promise<void> {
    if (t.first === undefined || t.triggerFixed) return;
    let entry = t.entries.get(t.first) ?? commit.added.find((e) => (e.id as number) === t.first);
    if (!entry && !t.caughtUp) {
      await this.#catchUp(t);
      entry = t.entries.get(t.first);
    }
    if (this.#stopped) return;
    const known = this.#opts.db.runs.byFirstEntry(t.first).some((r) => r.id !== t.id);
    if (entry?.kind === CRON_ENTRY_KIND) t.trigger = "cron";
    else if (entry?.kind === "pi.user") t.trigger = known ? "continue" : "chat";
    else t.trigger = "system";
    const stamp = entry ? messageOf<UserMessage>(entry, "user")?.timestamp : undefined;
    t.startedAt = t.trigger === "continue" || typeof stamp !== "number" ? commit.at : stamp;
    t.triggerFixed = true;
    if (opening && entry) t.entries.set(entry.id as number, entry);
  }

  /** Page `main.entries` from the run's first entry, oldest first, into the run's entries. */
  async #catchUp(t: Tracked): Promise<void> {
    if (t.first === undefined || t.caughtUp) return;
    t.caughtUp = true;
    let cursor: unknown;
    for (let guard = 0; guard < 1_000; guard++) {
      const page = await this.#opts.main.entries(
        { minEntryId: t.first as unknown as EntryId, order: "ascending" },
        PAGE,
        cursor as never,
        this.#ctx,
      );
      for (const e of page.items) t.entries.set(e.id as number, e);
      if (page.next === undefined || page.items.length === 0) break;
      cursor = page.next;
    }
  }

  #absorb(t: Tracked, entries: readonly EntryRecord[]): void {
    for (const e of entries) {
      if (t.first !== undefined && (e.id as number) < t.first) continue;
      t.entries.set(e.id as number, e);
    }
  }

  /** Rows still `running` other than `keep`: the run ended while no recorder watched. */
  async #closeStale(commit: FeedCommit, live: LiveView, keep: number | undefined): Promise<void> {
    for (const row of this.#opts.db.runs.running()) {
      if (row.id === keep) continue;
      const t: Tracked = {
        id: row.id,
        first: row.firstEntry ?? undefined,
        trigger: row.trigger,
        triggerFixed: true,
        startedAt: row.startedAt,
        turns: row.turns,
        entries: new Map(),
        caughtUp: false,
        toolsSig: "",
        lastSig: "",
      };
      await this.#catchUp(t);
      if (this.#stopped) return;
      const failure = live.failure && (live.failure.first === row.firstEntry || live.failure.taskId === row.id) ? live.failure : undefined;
      await this.#finish(t, { run: undefined, failure, tools: [] }, commit.at);
    }
  }

  async #finish(t: Tracked, live: LiveView, at: number): Promise<void> {
    const failure = live.failure;
    const status: RunSummary["status"] = failure ? (failure.reason === "aborted" ? "aborted" : "failed") : "answered";
    const saved = this.#save(t, live, status, at, failure?.reason ?? null);
    if (!saved) return;
    const { firstEntry: _first, ...summary } = saved;
    this.#opts.bus.publish({ type: "run.recorded", run: summary });
  }

  /** Derive the row and write it when it changed; returns the row. */
  #save(
    t: Tracked,
    live: LiveView,
    status: RunSummary["status"],
    finishedAt: number | null,
    failure: string | null,
  ): RunRow | undefined {
    if (this.#stopped) return undefined;
    const final = status !== "running";
    const d = derive(t, live, final);
    const first = t.first !== undefined ? t.entries.get(t.first) : undefined;
    const prompt = first
      ? cap(textOf(messageOf<UserMessage>(first, "user")?.content), PROMPT_CAP)
      : "";
    const row: RunRow = {
      id: t.id,
      trigger: t.trigger,
      status,
      startedAt: t.startedAt,
      finishedAt,
      durationMs: finishedAt === null ? null : Math.max(0, finishedAt - t.startedAt),
      model: d.model,
      turns: t.turns,
      toolCalls: d.toolCalls,
      usage: d.usage,
      costSource: d.costSource,
      failure,
      prompt,
      firstEntry: t.first ?? null,
    };
    const sig = JSON.stringify([row, d.tools]);
    if (sig === t.lastSig && !final) return row;
    t.lastSig = sig;
    this.#opts.db.runs.save(row, d.tools);
    return row;
  }
}

/**
 * Create the recorder and reconcile with the feed's current commit before returning: an open run is matched by
 * `first_entry` (or adopted), rows whose run ended while nothing watched are closed.
 */
export async function createRecorder(opts: RecorderOptions): Promise<RunRecorder> {
  const recorder = new Recorder(opts);
  await recorder.start();
  return recorder;
}
