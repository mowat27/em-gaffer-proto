/**
 * The pure state reducer (DESIGN 11, "State"): a `snapshot` frame replaces the state, every `delta` applies to its slice,
 * `hello` and `ping` only touch the connection. No DOM, no fetch: tests/unit/web-reducer.test.ts runs it in node.
 * It returns the same object when a frame changes nothing, so `useSyncExternalStore` selectors stay stable.
 */
import type { AppEvent } from "../../shared/events.ts";
import {
  DEFAULT_UI_CONFIG,
  type CeilingInfo,
  type ChatDelta,
  type ChatItem,
  type ChatView,
  type CronEntry,
  type FactoryStatus,
  type LayerInfo,
  type Page,
  type PageTree,
  type RunSummary,
  type Selection,
  type Settings,
  type Snapshot,
  type SseFrame,
  type ThemeCheck,
  type ThemeInfo,
  type ToolInfo,
  type UiConfig,
} from "../../shared/types.ts";

/** "restarting": the server said it is restarting (`factory.restarting`); it stays until the next snapshot (or `hello`). */
export type Connection = "connecting" | "live" | "offline" | "restarting";

/**
 * Everything the web app shows. The snapshot's fields are flattened onto the state and kept current by the deltas;
 * `snapshot` itself is the last snapshot frame as received (not updated by deltas), so read the flattened fields.
 * Object slices are null until the first snapshot; lists start empty and `uiConfig` starts at the defaults.
 */
export interface FactoryState {
  readonly connection: Connection;
  readonly bootId: number | null;
  /** The id of the newest snapshot or delta applied (the stream's Last-Event-ID). */
  readonly lastId: number | null;
  readonly snapshot: Snapshot | null;
  readonly status: FactoryStatus | null;
  readonly chat: ChatView | null;
  readonly pages: PageTree | null;
  readonly selection: Selection | null;
  /** The selected page's content. */
  readonly focus: Page | null;
  readonly settings: Settings | null;
  readonly uiConfig: UiConfig;
  readonly layers: readonly LayerInfo[];
  readonly tools: readonly ToolInfo[];
  readonly ceiling: CeilingInfo | null;
  /** Newest first, at most RUNS_KEPT. */
  readonly runs: readonly RunSummary[];
  readonly themes: readonly ThemeInfo[];
  /** The active theme's full CSS (the store mirrors it into `<style id="tsf-theme">`). */
  readonly themeCss: string;
  /** The contrast check that came with the newest `theme.applied` (null until one arrives). */
  readonly themeCheck: ThemeCheck | null;
  readonly cron: readonly CronEntry[];
  /** Counters that bump on `prompts.changed` and `models.changed`, so a panel that holds a fetched list refetches. */
  readonly revs: { readonly prompts: number; readonly models: number };
  /** Vite's text of the newest failed web rebuild (`web.build_failed`, or the snapshot's `status.web.lastError`); null after a good one. */
  readonly webError: string | null;
}

export const initialState: FactoryState = {
  connection: "connecting",
  bootId: null,
  lastId: null,
  snapshot: null,
  status: null,
  chat: null,
  pages: null,
  selection: null,
  focus: null,
  settings: null,
  uiConfig: DEFAULT_UI_CONFIG,
  layers: [],
  tools: [],
  ceiling: null,
  runs: [],
  themes: [],
  themeCss: "",
  themeCheck: null,
  cron: [],
  revs: { prompts: 0, models: 0 },
  webError: null,
};

/** The runs the client keeps (the snapshot carries the newest 20). */
export const RUNS_KEPT = 20;
/** Chat items the client keeps; older ones are dropped and `hasEarlier` set, so "Load earlier" can page them back. */
export const CHAT_ITEMS_KEPT = 1000;

/** The connection changes outside the stream's frames (EventSource errors); the store calls this. */
export function withConnection(state: FactoryState, connection: Connection): FactoryState {
  // A restart announced by the server ends with the next snapshot, not with an error, a retry or a ping.
  if (state.connection === "restarting" && connection !== "restarting") return state;
  return state.connection === connection ? state : { ...state, connection };
}

export function reduce(state: FactoryState, frame: SseFrame): FactoryState {
  switch (frame.type) {
    case "hello": {
      // A resumed stream replays deltas next, so it is live now; otherwise a snapshot follows and makes it live.
      const connection = frame.resumed ? "live" : state.connection;
      if (state.connection === "restarting" && frame.resumed) return { ...state, bootId: frame.bootId, connection: "live" };
      if (state.bootId === frame.bootId && state.connection === connection) return state;
      return { ...state, bootId: frame.bootId, connection };
    }
    case "snapshot":
      return fromSnapshot(state, frame.id, frame.snapshot);
    case "delta": {
      const delta = frame.delta;
      // Ids rise monotonically across boots (bootId * 1000 + n), so an id at or below the last one is a repeat.
      if (state.lastId !== null && frame.id <= state.lastId) return state;
      const next = applyDelta(state, frame.delta);
      return { ...next, lastId: frame.id, connection: delta.type === "factory.restarting" || state.connection === "restarting" ? "restarting" : "live" };
    }
    case "ping":
      return withConnection(state, "live");
    default:
      return state;
  }
}

function fromSnapshot(state: FactoryState, id: number, s: Snapshot): FactoryState {
  return {
    connection: "live",
    bootId: s.bootId,
    lastId: id,
    snapshot: s,
    status: s.status,
    chat: s.chat,
    pages: s.pages,
    selection: s.selection,
    focus: s.focus,
    settings: s.settings,
    uiConfig: s.uiConfig,
    layers: s.layers,
    tools: s.tools,
    ceiling: s.ceiling,
    runs: s.runs,
    themes: s.themes,
    // An empty string means the server could not load the theme: keep what is shown.
    themeCss: s.themeCss !== "" ? s.themeCss : state.themeCss,
    themeCheck: state.themeCheck,
    cron: s.cron,
    webError: s.status.web?.lastError ?? null,
    // A new snapshot may follow a missed event: refetch what panels hold.
    revs: { prompts: state.revs.prompts + 1, models: state.revs.models + 1 },
  };
}

function applyDelta(state: FactoryState, delta: ChatDelta | AppEvent): FactoryState {
  switch (delta.type) {
    // --- chat (agent/feed.ts) ---------------------------------------------------------------------------------
    case "chat.append":
      return state.chat ? { ...state, chat: appendItems(state.chat, delta.items) } : state;
    case "chat.update":
      return state.chat ? { ...state, chat: updateItems(state.chat, delta.items) } : state;
    case "chat.live":
      return state.chat ? { ...state, chat: { ...state.chat, live: delta.live } } : state;
    case "chat.meta":
      return state.chat ? { ...state, chat: { ...state.chat, meta: delta.meta } } : state;
    case "chat.reset":
      return { ...state, chat: delta.chat };

    // --- pages ------------------------------------------------------------------------------------------------
    case "pages.changed":
      return { ...state, pages: delta.tree };
    case "page.updated":
      // Only the selected page's content is held; other pages are read on demand.
      return state.selection?.path === delta.page.path ? { ...state, focus: delta.page } : state;
    case "page.removed":
      // A removed selected page is followed by selection.changed, which clears the focus.
      return state;
    case "selection.changed":
      return { ...state, selection: delta.selection, focus: delta.focus };

    // --- settings, layers, tools, ceiling, models, runs --------------------------------------------------------
    case "settings.changed":
      return { ...state, settings: delta.settings };
    case "layers.changed":
      return { ...state, layers: delta.layers };
    case "tools.changed":
      return { ...state, tools: delta.tools };
    case "ceiling.changed":
      return { ...state, ceiling: delta.ceiling };
    case "models.changed":
      // The list is large; views that show it refetch GET /api/models when `revs.models` moves.
      return { ...state, revs: { ...state.revs, models: state.revs.models + 1 } };
    case "run.recorded":
      return { ...state, runs: upsertRun(state.runs, delta.run) };

    // --- UI config and themes ----------------------------------------------------------------------------------
    case "ui_config.changed":
      return delta.config.version > state.uiConfig.version ? { ...state, uiConfig: delta.config } : state;
    case "themes.changed":
      return { ...state, themes: delta.themes };
    case "theme.applied":
      return delta.css === state.themeCss && delta.check === state.themeCheck ? state : { ...state, themeCss: delta.css, themeCheck: delta.check };

    // --- prompts, layers' own state, cron, panels --------------------------------------------------------------
    case "prompts.changed":
      // Prompt-section toggles are not in the watch, so the Prompts panel refetches when `revs.prompts` moves.
      return { ...state, revs: { ...state.revs, prompts: state.revs.prompts + 1 } };
    case "layer.changed":
    case "cron.fired":
    case "ui.open":
      // Signals for views that refetch or react (P4-P6); no state slice.
      return state;
    case "cron.changed":
      return { ...state, cron: delta.entries };
    case "web.build_failed":
      return { ...state, webError: delta.error };
    case "web.rebuilt":
      return state.webError === null ? state : { ...state, webError: null };
    case "factory.restarting":
      // Signals the connection state (reduce sets it); no slice.
      return state;
    default:
      return state;
  }
}

/** Newer runs first; a run already held is replaced. */
function upsertRun(runs: readonly RunSummary[], run: RunSummary): readonly RunSummary[] {
  const rest = runs.filter((r) => r.id !== run.id);
  return [run, ...rest].sort((a, b) => b.id - a.id).slice(0, RUNS_KEPT);
}

/** Append new items; an item whose id is already held replaces it in place (a replayed or repeated append). */
function appendItems(chat: ChatView, items: readonly ChatItem[]): ChatView {
  if (items.length === 0) return chat;
  const index = new Map(chat.items.map((item, i) => [item.id, i]));
  const next = [...chat.items];
  for (const item of items) {
    const at = index.get(item.id);
    if (at !== undefined) next[at] = item;
    else {
      index.set(item.id, next.length);
      next.push(item);
    }
  }
  if (next.length > CHAT_ITEMS_KEPT) return { ...chat, items: next.slice(next.length - CHAT_ITEMS_KEPT), hasEarlier: true };
  return { ...chat, items: next };
}

/** Replace the items with the same id; an id the client does not hold is ignored (it is outside the view). */
function updateItems(chat: ChatView, items: readonly ChatItem[]): ChatView {
  const byId = new Map(items.map((item) => [item.id, item]));
  let changed = false;
  const next = chat.items.map((item) => {
    const updated = byId.get(item.id);
    if (!updated) return item;
    changed = true;
    return updated;
  });
  return changed ? { ...chat, items: next } : chat;
}
