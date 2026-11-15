/**
 * ChatFeed (DESIGN 6 "Feed to deltas"): the one `Conversation.watch` of the process plus a `ConversationTranscript`,
 * turned into the web's ChatView and ChatDelta. Every watch value is also handed raw to `onCommit` listeners (the
 * recorder reads those, never ChatItems).
 *
 * Rules kept here:
 * - The initial view comes from `transcript.merge(watch.value)` before `watch.start()`; the listener is never called
 *   with the value at attachment (0 calls on a quiet conversation, verified on 1.5.0), so `start()` never waits for it.
 * - Only a root replacement (`isBase(ops)`) sends `chat.reset`. Entry ids have holes (task ids share their id space),
 *   so nothing compares ids for contiguity; missed entries show up only as transcript `gap` items, filled before
 *   emitting.
 * - `closed`: `stopped`, `aborted`, `ended` are normal; `failed` is final (the Harness is closing itself; the harness's
 *   `closed` handler exits); only `listener_error` reopens the watch (at most 5 times a minute). Past that limit the
 *   feed is dead: it calls its `onFatal` listeners (runServer shuts down gracefully and exits 1) and never calls
 *   `process.exit` itself.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isBase, type Op } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type Conversation,
  type ConversationView,
  type ConversationWatch,
  type EntryId,
  type EntryRecord,
  type TranscriptItem,
  type TranscriptView,
  type WatchEnd,
} from "@earendil-works/pi-durable";
import type { Logger } from "../core/log.ts";
import type { EarlierInput, EarlierPage } from "../core/service-api.ts";
import type { ChatDelta, ChatItem, ChatLive, ChatMeta, ChatView, Settings } from "../shared/types.ts";
import { contextTokensOf, entryItems, liveView, metaView, stitchResults } from "./chat-view.ts";
import { effectiveCompaction } from "./compaction.ts";
import type { ModelCatalog } from "./models.ts";

/** One watch value, raw, for the recorder. `at` = Date.now() on delivery. */
export interface FeedCommit {
  readonly value: ConversationView;
  readonly added: readonly EntryRecord[];
  readonly at: number;
}

export interface ChatFeedOptions {
  readonly catalog: ModelCatalog;
  readonly settings: () => Settings;
  readonly toolLayer: (n: string) => string | undefined;
  readonly log: Logger;
}

/** The watch window (the default 50..100 is too small for a chat pane). */
export const FEED_WINDOW = { min: 200, max: 400 } as const;
/** Items kept in the server's view; older ones are paged with GET /api/chat/earlier. */
export const VIEW_ITEMS = 200;
const RESTARTS_PER_MINUTE = 5;

type Gap = Extract<TranscriptItem, { kind: "gap" }>;

export class ChatFeed {
  readonly #main: Conversation;
  readonly #opts: ChatFeedOptions;
  readonly #ctx: Context = BACKGROUND_CONTEXT;
  readonly #deltaListeners = new Set<(d: ChatDelta) => void>();
  readonly #commitListeners = new Set<(c: FeedCommit) => void>();
  readonly #fatalListeners = new Set<(err: Error) => void>();
  #fatal: Error | undefined;
  #watch: ConversationWatch | undefined;
  #transcript: ConversationTranscript | undefined;
  #items: ChatItem[] = [];
  #seen = new Set<number>();
  #hasEarlier = false;
  #live: ChatLive = liveView({});
  #meta: ChatMeta | undefined;
  #liveJson = "";
  #metaJson = "";
  #agentKey: string | undefined;
  #agentInfo: { extensions: string[]; offeredTools: string[] } = { extensions: [], offeredTools: [] };
  #contextTokens = 0;
  #docs: ConversationView["docs"] = {};
  #commit: FeedCommit | undefined;
  #stopped = false;
  #restarts: number[] = [];
  #unsubscribeCatalog: (() => void) | undefined;

  constructor(main: Conversation, opts: ChatFeedOptions) {
    this.#main = main;
    this.#opts = opts;
  }

  /** Open the watch, build the initial view from its value, then start the listener. Never waits for a listener call. */
  async start(): Promise<void> {
    if (this.#watch) return;
    this.#transcript = new ConversationTranscript((query, limit, c) => this.#main.entries(query, limit, undefined, c));
    const watch = await this.#main.watch(this.#ctx, FEED_WINDOW);
    await this.#rebuild(watch.value);
    this.#attach(watch);
    this.#unsubscribeCatalog = this.#opts.catalog.onChange(() => this.#emitMetaIfChanged());
  }

  view(): ChatView {
    return { items: this.#items.slice(), hasEarlier: this.#hasEarlier, live: this.#live, meta: this.#metaOrEmpty() };
  }

  onDelta(fn: (d: ChatDelta) => void): () => void {
    this.#deltaListeners.add(fn);
    return () => {
      this.#deltaListeners.delete(fn);
    };
  }

  /**
   * Recompute `meta` from the settings and emit `chat.meta` when it changed. A compaction-point change commits nothing
   * to the conversation, so the Service calls this after writing it (P5).
   */
  refreshMeta(): void {
    this.#emitMetaIfChanged();
  }

  /** The newest value, raw. Throws before `start()`. */
  current(): FeedCommit {
    if (!this.#commit) throw new Error("ChatFeed.current() before start()");
    return this.#commit;
  }

  onCommit(fn: (c: FeedCommit) => void): () => void {
    this.#commitListeners.add(fn);
    return () => {
      this.#commitListeners.delete(fn);
    };
  }

  /**
   * Called once when the feed gives up (the watch failed with `listener_error` more than 5 times in a minute). The
   * process owner shuts down; a listener added after that is called at once.
   */
  onFatal(fn: (err: Error) => void): () => void {
    if (this.#fatal) {
      fn(this.#fatal);
      return () => undefined;
    }
    this.#fatalListeners.add(fn);
    return () => {
      this.#fatalListeners.delete(fn);
    };
  }

  /** Items of the entries before `input.before`, oldest first. */
  async loadEarlier(input: EarlierInput): Promise<EarlierPage> {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    if (!(input.before > 1)) return { items: [], hasEarlier: false };
    const page = await this.#main.entries(
      { maxEntryId: (input.before - 1) as EntryId, order: "descending" },
      limit,
      undefined,
      this.#ctx,
    );
    const items: ChatItem[] = [];
    for (const entry of [...page.items].reverse()) {
      if (entry.kind === "pi.tool-result") {
        for (const updated of stitchResults(items, entry)) {
          const at = items.findIndex((i) => i.id === updated.id);
          if (at >= 0) items[at] = updated;
        }
      } else {
        items.push(...entryItems(entry, this.#opts.toolLayer));
      }
    }
    return { items, hasEarlier: page.next !== undefined };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribeCatalog?.();
    this.#unsubscribeCatalog = undefined;
    await this.#watch?.stop();
  }

  // --- internals -------------------------------------------------------------------------------------------------

  #attach(watch: ConversationWatch): void {
    this.#watch = watch;
    void watch.closed.then((end) => this.#closed(watch, end));
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      try {
        await this.#apply(call.value, call.ops);
      } catch (err) {
        this.#opts.log.error("feed.apply_failed", { error: err });
      }
    });
  }

  #closed(watch: ConversationWatch, end: WatchEnd): void {
    if (this.#watch !== watch) return;
    const log = this.#opts.log;
    if (end.kind === "stopped" || end.kind === "aborted" || end.kind === "ended") {
      log.info("feed.closed", { kind: end.kind });
      return;
    }
    if (end.kind === "failed") {
      // The Harness failed and closes itself; harness.closed handles the exit.
      log.error("feed.failed", { error: end.error });
      return;
    }
    if (end.kind !== "listener_error" || this.#stopped) return;
    log.error("feed.listener_error", { error: end.error });
    const now = Date.now();
    this.#restarts = this.#restarts.filter((t) => now - t < 60_000);
    if (this.#restarts.length >= RESTARTS_PER_MINUTE) {
      log.error("feed.restart_limit", { restarts: this.#restarts.length });
      this.#fail(new Error(`chat feed watch restarted ${this.#restarts.length} times in a minute`));
      return;
    }
    this.#restarts.push(now);
    void this.#restart().catch((err: unknown) => log.error("feed.restart_failed", { error: err }));
  }

  #fail(err: Error): void {
    if (this.#fatal) return;
    this.#fatal = err;
    this.#stopped = true;
    for (const fn of [...this.#fatalListeners]) {
      try {
        fn(err);
      } catch (e) {
        this.#opts.log.error("feed.fatal_listener_failed", { error: e });
      }
    }
    this.#fatalListeners.clear();
  }

  async #restart(): Promise<void> {
    const watch = await this.#main.watch(this.#ctx, FEED_WINDOW);
    await this.#rebuild(watch.value);
    this.#emit({ type: "chat.reset", chat: this.view() });
    this.#attach(watch);
  }

  /** Merge a value and fill every gap; the result has no gap items. */
  async #merged(value: ConversationView): Promise<TranscriptView> {
    const transcript = this.#transcript!;
    let tv = transcript.merge(value);
    for (let guard = 0; guard < 10_000; guard++) {
      const gap = tv.items.find((i): i is Gap => i.kind === "gap");
      if (!gap) break;
      tv = await transcript.fillGap(gap, this.#ctx);
    }
    return tv;
  }

  /** Rebuild the whole view from the transcript (start, reset, restart). */
  async #rebuild(value: ConversationView): Promise<void> {
    const tv = await this.#merged(value);
    const entries = tv.items.flatMap((i) => (i.kind === "entry" ? [i.entry] : []));
    this.#items = [];
    this.#seen = new Set();
    for (const entry of entries) this.#take(entry, this.#items, undefined);
    this.#hasEarlier = tv.items[0]?.kind === "earlier";
    this.#trim();
    this.#docs = value.docs;
    this.#contextTokens = contextTokensOf(entries) ?? this.#contextTokens;
    this.#live = liveView(value.docs);
    this.#liveJson = JSON.stringify(this.#live);
    await this.#refreshAgent(value.docs);
    this.#meta = this.#computeMeta();
    this.#metaJson = JSON.stringify(this.#meta);
    this.#commit = { value, added: entries, at: Date.now() };
  }

  /**
   * Add one entry to `items`: a tool result updates its call's item (in `appended` when the item is new in this batch,
   * else as an update), any other entry appends its items.
   */
  #take(entry: EntryRecord, items: ChatItem[], updates: Map<string, ChatItem> | undefined, appended?: ChatItem[]): void {
    this.#seen.add(entry.id as number);
    if (entry.kind === "pi.tool-result") {
      for (const updated of stitchResults(items, entry)) {
        const at = items.findIndex((i) => i.id === updated.id);
        if (at >= 0) items[at] = updated;
        const inBatch = appended?.findIndex((i) => i.id === updated.id) ?? -1;
        if (appended && inBatch >= 0) appended[inBatch] = updated;
        else updates?.set(updated.id, updated);
      }
      return;
    }
    const fresh = entryItems(entry, this.#opts.toolLayer);
    items.push(...fresh);
    appended?.push(...fresh);
  }

  #trim(): void {
    if (this.#items.length > VIEW_ITEMS) {
      this.#items = this.#items.slice(this.#items.length - VIEW_ITEMS);
      this.#hasEarlier = true;
    }
  }

  async #apply(value: ConversationView, ops: readonly Op[]): Promise<void> {
    if (isBase(ops)) {
      await this.#rebuild(value);
      this.#emit({ type: "chat.reset", chat: this.view() });
      this.#emitCommit(this.#commit!);
      return;
    }
    const tv = await this.#merged(value);
    const added: EntryRecord[] = [];
    for (const item of tv.items) {
      if (item.kind === "entry" && !this.#seen.has(item.entry.id as number)) added.push(item.entry);
    }
    const appended: ChatItem[] = [];
    const updates = new Map<string, ChatItem>();
    for (const entry of added) this.#take(entry, this.#items, updates, appended);
    if (tv.items[0]?.kind === "earlier") this.#hasEarlier = true;
    this.#trim();
    this.#docs = value.docs;
    this.#contextTokens = contextTokensOf(added) ?? this.#contextTokens;

    if (appended.length > 0) this.#emit({ type: "chat.append", items: appended });
    if (updates.size > 0) this.#emit({ type: "chat.update", items: [...updates.values()] });

    const live = liveView(value.docs);
    const liveJson = JSON.stringify(live);
    if (liveJson !== this.#liveJson) {
      this.#live = live;
      this.#liveJson = liveJson;
      this.#emit({ type: "chat.live", live });
    }

    await this.#refreshAgent(value.docs);
    this.#emitMetaIfChanged();

    const commit: FeedCommit = { value, added, at: Date.now() };
    this.#commit = commit;
    this.#emitCommit(commit);
  }

  /** Re-resolve `Conversation.agent()` when `pi.agent` changed (the selected extensions and offered tools). */
  async #refreshAgent(docs: ConversationView["docs"]): Promise<void> {
    const key = JSON.stringify(docs["pi.agent"] ?? null);
    if (key === this.#agentKey) return;
    try {
      const agent = await this.#main.agent(this.#ctx);
      this.#agentInfo = {
        extensions: agent.extensions.map((e) => e.name),
        offeredTools: agent.tools.map((t) => t.name),
      };
      this.#agentKey = key;
    } catch (err) {
      this.#opts.log.warn("feed.agent_failed", { error: err });
    }
  }

  #computeMeta(): ChatMeta {
    const { catalog, settings } = this.#opts;
    const s = settings();
    const agent = (this.#docs["pi.agent"] ?? {}) as { model?: { provider?: unknown; modelId?: unknown } };
    const ref =
      agent.model && typeof agent.model.provider === "string" && typeof agent.model.modelId === "string"
        ? { provider: agent.model.provider, modelId: agent.model.modelId }
        : catalog.resolve(s.model);
    const window = catalog.window(ref);
    return metaView({
      docs: this.#docs,
      defaultModel: catalog.resolve(s.model),
      modelName: (r) => catalog.info(r)?.name ?? null,
      contextTokens: this.#contextTokens,
      contextWindow: window,
      compaction: effectiveCompaction(window, s.compaction),
      extensions: this.#agentInfo.extensions,
      offeredTools: this.#agentInfo.offeredTools,
    });
  }

  #metaOrEmpty(): ChatMeta {
    if (!this.#meta) this.#meta = this.#computeMeta();
    return this.#meta;
  }

  #emitMetaIfChanged(): void {
    if (!this.#commit) return;
    let meta: ChatMeta;
    try {
      meta = this.#computeMeta();
    } catch (err) {
      this.#opts.log.warn("feed.meta_failed", { error: err });
      return;
    }
    const json = JSON.stringify(meta);
    if (json === this.#metaJson) return;
    this.#meta = meta;
    this.#metaJson = json;
    this.#emit({ type: "chat.meta", meta });
  }

  #emit(delta: ChatDelta): void {
    for (const fn of [...this.#deltaListeners]) {
      try {
        fn(delta);
      } catch (err) {
        this.#opts.log.error("feed.delta_listener_error", { type: delta.type, error: err });
      }
    }
  }

  #emitCommit(commit: FeedCommit): void {
    for (const fn of [...this.#commitListeners]) {
      try {
        fn(commit);
      } catch (err) {
        this.#opts.log.error("feed.commit_listener_error", { error: err });
      }
    }
  }
}
