/**
 * The in-process app event bus (core/bus.ts). Service publishes one event after each committed change; the SSE hub
 * forwards every event to every open stream as a `delta` frame unchanged (D9). Chat state does not go through the bus:
 * it comes from Conversation.watch (agent/feed.ts) as ChatDelta.
 * Types only.
 */
import type {
  Actor,
  CeilingInfo,
  CronEntry,
  LayerInfo,
  Page,
  PagePath,
  PageTree,
  RunSummary,
  Selection,
  SettingKey,
  Settings,
  ThemeCheck,
  ThemeInfo,
  ToolInfo,
  UiConfig,
} from "./types.ts";

export type AppEvent =
  // P2: pages. `pages.changed` follows every tree change (create, move, delete, folder, or a file changed on disk).
  | { readonly type: "pages.changed"; readonly tree: PageTree; readonly paths: readonly PagePath[]; readonly by: Actor }
  /** A page's content changed (by Service or on disk). Carries the content so a focused page updates live. */
  | { readonly type: "page.updated"; readonly page: Page; readonly by: Actor }
  | { readonly type: "page.removed"; readonly path: PagePath; readonly by: Actor }
  | { readonly type: "selection.changed"; readonly selection: Selection; readonly focus: Page | null }
  // P1-P2: settings, layers, tools
  | { readonly type: "settings.changed"; readonly settings: Settings; readonly keys: readonly SettingKey[]; readonly by: Actor }
  | { readonly type: "layers.changed"; readonly layers: readonly LayerInfo[] }
  | { readonly type: "tools.changed"; readonly tools: readonly ToolInfo[] }
  /** Never sent at runtime (the ceiling is fixed at startup); kept so the reducer handles every snapshot field. */
  | { readonly type: "ceiling.changed"; readonly ceiling: CeilingInfo }
  /** The model list changed (live fetch). The list is large, so clients refetch GET /api/models. */
  | { readonly type: "models.changed"; readonly count: number; readonly fetchedAt: number }
  // P2: recorder
  | { readonly type: "run.recorded"; readonly run: RunSummary }
  // P3: UI config
  | { readonly type: "ui_config.changed"; readonly config: UiConfig; readonly by: Actor }
  // P4: themes. `theme.applied` follows every change of the active theme or of its values, PW or custom, and always
  // carries the full CSS (theme tokens + style preset, the same string as Snapshot.themeCss). The browser replaces the
  // text of <style id="tsf-theme"> with it; nothing is switched by name and no theme CSS is bundled.
  | { readonly type: "themes.changed"; readonly themes: readonly ThemeInfo[] }
  | { readonly type: "theme.applied"; readonly name: string; readonly css: string; readonly check: ThemeCheck }
  // P5-P6: prompts. Prompt-section toggles (D6) live in a conversation doc the watch does not mount, so every prompt
  // change (system, custom, runtime, section toggle) publishes this; clients refetch GET /api/prompts if they show it.
  | { readonly type: "prompts.changed"; readonly by: Actor }
  // P4: a layer's own state changed (published by layerAction, or by the layer through ctx.bus); the generic layer
  // control renderer re-reads that layer's queries.
  | { readonly type: "layer.changed"; readonly layer: string; readonly by: Actor }
  // P6: cron
  | { readonly type: "cron.changed"; readonly entries: readonly CronEntry[] }
  | {
      readonly type: "cron.fired";
      readonly cronId: string;
      readonly name: string;
      readonly slot: number;
      readonly submissionId: number;
      readonly catchUp: boolean;
    }
  // P4: open a modal in every open page. Published by Service.openPanel, which the hotkeys, the navbar buttons and
  // the factory_controls tool `open_panel` all call (parity: capability "ui.open").
  | { readonly type: "ui.open"; readonly target: "settings" | "cron"; readonly section?: string; readonly by: Actor }
  // Liquid core (P9): the web build. `web.rebuilt` follows a good rebuild (a page reloads when `hash` differs from the
  // one it loaded); `web.build_failed` follows a failed one (the previous good build keeps serving; `error` is vite's
  // trimmed text). `factory.restarting` is sent just before the process restarts: clients show "restarting" and reconnect.
  | { readonly type: "web.rebuilt"; readonly hash: string }
  | { readonly type: "web.build_failed"; readonly error: string }
  | { readonly type: "factory.restarting"; readonly inMs: number; readonly reason?: string; readonly by: Actor };

export type AppEventType = AppEvent["type"];

/** core/bus.ts implements this. Listeners run synchronously; a throwing listener is logged and skipped. */
export interface AppBus {
  publish(event: AppEvent): void;
  subscribe(listener: (event: AppEvent) => void): () => void;
}
