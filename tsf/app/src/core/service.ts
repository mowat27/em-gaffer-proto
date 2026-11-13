/**
 * The Service (DESIGN 9): the one object routes and agent tools call. `createService(deps)` builds its own stores from
 * `deps` and returns the Service plus a `start()`/`close()` pair (the seam is fixed from P1).
 *
 * P1: status, snapshot, chat, models, settings and theme CSS. P2: layers, tools, ceiling, runs (the recorder) and pages
 * (PageStore, selection, focus). P3: the UI config document (UiConfigStore, `ui_config` mutex); selecting a page while
 * the agent pane is maximised also un-maximises it (mutex order `pages` then `ui_config`, DESIGN 4.2, 11).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FactoryAgent } from "../agent/harness.ts";
import type {
  AddWidgetInput,
  CompactInput,
  CreateCronInput,
  CreateCustomPromptInput,
  CronRunResult,
  UpdateCronInput,
  CreatePageInput,
  CreateThemeInput,
  DeletePageInput,
  DeleteResult,
  DeleteThemeResult,
  DescribeToolInput,
  EarlierInput,
  EarlierPage,
  FactoryService,
  FixThemeResult,
  HotkeyInfo,
  LayerActionInput,
  LayerQueryInput,
  MovePageInput,
  MoveResult,
  MoveWidgetInput,
  OpenPanelInput,
  PlacedWidget,
  SendMessageInput,
  SendResult,
  SetHotkeyInput,
  SetThemeValuesInput,
  SetWidgetOptionsInput,
  ThemeResult,
  UpdateCustomPromptInput,
  UpdatePageInput,
  UpdateUiConfigInput,
  RunListInput,
  WidgetList,
  WidgetType,
} from "./service-api.ts";
import {
  API_VERSION,
  BUILTIN_WIDGETS,
  CRON_ENTRY_KIND,
  DEFAULT_UI_CONFIG,
  THINKING_LEVELS,
  type Actor,
  type CeilingInfo,
  type ChatView,
  type CompactionPoints,
  type CompactResult,
  type ContextInfo,
  type CronEntry,
  type ModelRef,
  type ModelSelection,
  type CreateLayerInput,
  type ExportLayerInput,
  type ExportLayerResult,
  type ImportLayerInput,
  type ImportLayerResult,
  type DefineWidgetInput,
  type DefineWidgetResult,
  type DeleteLayerFileResult,
  type DeleteLayerResult,
  type LayerFileContent,
  type LayerFileInput,
  type LayerFileList,
  type UndefineWidgetInput,
  type UndefineWidgetResult,
  type WidgetContribution,
  type WriteLayerFileInput,
  type WriteLayerFileResult,
  type PromptInfo,
  type PromptList,
  type RefreshModelsResult,
  type SettingKey,
  type ThinkingLevel,
  type ToolDescription,
  type FactoryStatus,
  type FolderNode,
  type HotkeyAction,
  type JevInput,
  type JevVerdict,
  type Json,
  type LayerInfo,
  type ModelInfo,
  type Origin,
  type NavbarId,
  type NavbarSlot,
  type Page,
  type PagePath,
  type PageTree,
  type RunDetail,
  type RunSummary,
  type Selection,
  type Settings,
  type RebuildWebResult,
  type RestartInput,
  type RestartResult,
  type ScreenshotInput,
  type ScreenshotResult,
  type Snapshot,
  type ThemeCheck,
  type ThemeInfo,
  type ToolInfo,
  type UiConfig,
  type WebStatus,
  type WidgetPlacement,
} from "../shared/types.ts";
import { HOTKEY_ACTIONS } from "../shared/ui-config-schema.ts";
import type { AppBus } from "../shared/events.ts";
import { createRecorder } from "../agent/recorder.ts";
import { disabledSections, NEVER_GATED, originalSection, PromptSectionsDoc } from "../agent/prompt-sections.ts";
import { toolSignature } from "../agent/schema-ts.ts";
import type { PromptInput } from "@earendil-works/pi-durable";
import { CronScheduler, requireCron, type FireJob, type FireResult } from "../server/cron.ts";
import { checkExpr, checkName, checkPrompt, cronId, CronStore, MAX_CRONS, type CronRunStatus } from "./cron-store.ts";
import type { AppDb } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { sha12 } from "./fsutil.ts";
import type { Logger } from "./log.ts";
import { LAYERS_MUTEX, KeyedMutex } from "./mutex.ts";
import { runCoreAction, runCoreQuery } from "./core-bindings.ts";
import { readScreenshotFile, takeScreenshot, type PlaywrightLoader } from "./screenshot.ts";
import { exportLayerArchive, installImport, loadImportSource, planImport, readExportFile as readExportArchive } from "./layer-transfer.ts";
import {
  deleteLayerFile as removeLayerFile,
  findLayerFolder,
  deleteLayerFolder,
  listLayerFiles as listFiles,
  readJsonManifestText,
  readLayerFile as readFileOf,
  requireEditable,
  requireLayerName,
  writeLayerFile as writeFileOf,
} from "./layer-files.ts";
import { actionTemplate, applyValueTemplate, declaredCoreBindings, isCoreRef, parseJsonManifest } from "../agent/layer-manifest.ts";
import type { ReloadResult } from "../agent/registry.ts";
import { BUILTIN_LAYERS } from "../agent/registry.ts";
import { atomicWrite } from "./fsutil.ts";
import { join } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { PAGES_MUTEX, PageStore } from "./pages.ts";
import {
  bareId,
  checkCustomName,
  checkText,
  DEFAULT_SYSTEM_PROMPT,
  MAX_CUSTOM_TEXT,
  MAX_RUNTIME_TEXT,
  MAX_SYSTEM_PROMPT,
  promptId,
  PromptStore,
  type CustomPrompt,
  type RuntimePrompt,
} from "./prompts.ts";
import { jevJudge, parseJevInput, type JevOptions } from "./jev.ts";
import type { ProjectPaths } from "./paths.ts";
import { FALLBACK_THEME, ThemeStore } from "./themes.ts";
import { UiConfigStore } from "./ui-config.ts";

export interface ServiceDeps {
  paths: ProjectPaths;
  db: AppDb;
  bus: AppBus;
  log: Logger;
  agent: FactoryAgent;
  bootId: number;
  startedAt: number;
  url: () => string;
  /** The served web build (`server/web-host.ts`); absent when no web app is served (tests, `--dev`). */
  web?: { status(): WebStatus; rebuild(): Promise<RebuildWebResult>; serving(): boolean };
  /**
   * How this process restarts itself (`runServer` supplies it once it owns the listener); absent in the in-process
   * test factory, where `restart` answers `conflict`. `begin` runs the DESIGN 3 shutdown, then exits or respawns.
   */
  restart?: { readonly mode: "systemd" | "respawn"; begin(reason?: string): void };
  /** Test seam: the playwright module loader of `screenshot`. */
  playwright?: PlaywrightLoader;
  /** Test seam: milliseconds between the `restart` reply and the restart (default 1500). */
  restartDelayMs?: number;
  /** Test seam for jevJudge options (fetch, apiKey, provider); default: global fetch and the environment. */
  jev?: JevOptions;
}

export interface ServiceRuntime {
  service: FactoryService;
  /** Runs after the URL line (DESIGN 3 step 15): starts the cron scheduler (P6): boot catch-up, then the timers. */
  start(): Promise<void>;
  /** First in shutdown: stops cron (P6), then the page watcher and the recorder (P2). */
  close(): Promise<void>;
}

/** The version reported by status. */
const VERSION = "0.1.0";

const MAX_TEXT = 100_000;
/** Between the `restart` reply and the restart: the tool result and the closing words of the turn get out first. */
const RESTART_DELAY_MS = 1500;
const RESTART_CALL_KEY = "restart.last_call";

/** The listening URL with a loopback host (the server may listen on 0.0.0.0 or a name; the browser runs on this machine). */
function loopbackUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "0.0.0.0" || u.hostname === "[::]" || u.hostname === "") u.hostname = "127.0.0.1";
    return u.origin;
  } catch {
    return url;
  }
}
const MAX_REQUEST_ID = 128;

/** The page a fresh install opens on (T23). */
const START_PAGE = "Start Here.md";
/** Runs in the snapshot. */
const SNAPSHOT_RUNS = 20;
const SELECTION_KEY = "selection";
/** The UI config's mutex key (DESIGN 4.2 lock order: pages, settings, themes, ui_config, ...). */
const UI_CONFIG_MUTEX = "ui_config";
const THEMES_MUTEX = "themes";
const SETTINGS_MUTEX = "settings";
const PROMPTS_MUTEX = "prompts";
const CRON_MUTEX = "cron";
const MAX_COMPACT_INSTRUCTIONS = 2_000;
const MAX_POINT = 100_000_000;
const NAVBARS: readonly NavbarId[] = ["global", "agent"];
const SLOTS: readonly NavbarSlot[] = ["left", "center", "right"];
const HANDLER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LAYER_INPUT = 100_000;

const BUILTIN_WIDGET_INFO: Readonly<Record<(typeof BUILTIN_WIDGETS)[number], { title: string; description: string }>> = {
  context_bar: { title: "Context bar", description: "How full the agent's context window is, and where compaction starts." },
  agent_status: { title: "Agent status", description: "Whether the agent is idle, working, retrying or compacting, with a stop button." },
  factory_name: { title: "Factory name", description: "The factory's name." },
  cron_status: { title: "Cron status", description: "The next scheduled prompt, and a button that opens the cron list." },
};

const HOTKEY_TITLES: Readonly<Record<HotkeyAction, string>> = {
  "settings.open": "Open settings",
  "cron.open": "Open the cron list",
  "panes.left.toggle": "Show or hide the pages pane",
  "panes.right.toggle": "Show or hide the agent pane",
  "agent.focus": "Focus the agent's message box",
  "agent.maximise": "Expand the agent pane over the page, or go back",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function createService(deps: ServiceDeps): Promise<ServiceRuntime> {
  const { paths, log, agent } = deps;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  const ctx = BACKGROUND_CONTEXT;

  const themes = new ThemeStore({ log, repo: deps.db.themes });
  try {
    await themes.init();
  } catch (err) {
    // A missing pw-ui theme source must not stop the API; the page is served unthemed and the log says why.
    log.error("theme.init_failed", { error: err });
  }

  // --- pages: store, selection, focus (DESIGN 4.3) ---------------------------------------------------------------
  const mutex = new KeyedMutex();
  const { bus } = deps;

  /** The selection and the selected page's content: changed only inside the `pages` mutex, with the event. */
  let selection: Selection = { path: null, by: "system", at: deps.startedAt };
  let focus: Page | null = null;

  const persistSelection = (): void => {
    deps.db.settings.setRaw(SELECTION_KEY, JSON.stringify(selection));
  };
  /** Assign selection and focus, store the selection and publish: one synchronous step. */
  const setSelection = (path: PagePath | null, page: Page | null, by: Actor): void => {
    selection = { path, by, at: Date.now() };
    focus = page;
    persistSelection();
    bus.publish({ type: "selection.changed", selection, focus });
  };

  const readQuiet = async (path: PagePath): Promise<Page | null> => {
    try {
      return await store.read(path);
    } catch (err) {
      if (err instanceof ServiceError && err.code === "not_found") return null;
      throw err;
    }
  };

  /** Runs inside the `pages` mutex (the rescan holds it), so it never takes it again. */
  const onExternalChange = async (
    changed: PagePath[],
    removed: PagePath[],
    info: { readonly structureChanged: boolean },
  ): Promise<void> => {
    const pages: Page[] = [];
    for (const path of changed) {
      const page = await readQuiet(path);
      if (page) pages.push(page);
    }
    const selected = selection.path;
    const selectedRemoved = selected !== null && removed.includes(selected);
    const selectedPage = selected !== null ? (pages.find((p) => p.path === selected) ?? null) : null;
    // From here on no await: state and events change in one synchronous step.
    if (info.structureChanged) {
      bus.publish({ type: "pages.changed", tree: store.tree(), paths: [...new Set([...changed, ...removed])], by: "system" });
    }
    for (const page of pages) {
      if (page.path === selected) focus = page;
      bus.publish({ type: "page.updated", page, by: "system" });
    }
    for (const path of removed) bus.publish({ type: "page.removed", path, by: "system" });
    if (selectedRemoved) setSelection(null, null, "system");
    else if (selectedPage) focus = selectedPage;
  };

  const store = new PageStore({ dir: paths.pagesDir, log, mutex, onExternalChange });

  // --- UI config (DESIGN 4.4) -------------------------------------------------------------------------------------
  const uiConfig = new UiConfigStore(deps.db, {
    context: () => {
      const names = themes.names();
      return { widgets: agent.registry.manifests().flatMap((m) => m.ui.widgets), ...(names.length > 0 ? { themes: names } : {}) };
    },
  });
  /** Store a patch and publish `ui_config.changed` when it changed something. Call inside the `ui_config` mutex. */
  const commitUiConfig = (input: UpdateUiConfigInput, by: Actor): UiConfig => {
    const before = uiConfig.get().version;
    const config = uiConfig.update(input);
    if (config.version !== before) bus.publish({ type: "ui_config.changed", config, by });
    return config;
  };
  await store.init();

  // Boot: the active theme follows the UI config; a name that no longer exists falls back (DESIGN 9, Themes).
  if (themes.names().length > 0) {
    let name = uiConfig.get().theme.name;
    if (!themes.has(name)) {
      const fallback = themes.has(FALLBACK_THEME) ? FALLBACK_THEME : themes.names()[0]!;
      log.warn("theme.unknown_at_boot", { theme: name, fallback });
      name = fallback;
      uiConfig.setTheme({ name });
    }
    try {
      await themes.activate(name);
    } catch (err) {
      log.error("theme.load_failed", { theme: name, error: err });
    }
  }
  // Layer hotkeys bind their default key at boot when the key is free, so the web reads one table (UiConfig.hotkeys).
  // A reload runs it again for new layers (publishing the change).
  const bindLayerHotkeys = (by: Actor | null): void => {
    for (const m of agent.registry.manifests()) {
      for (const h of m.ui.hotkeys) {
        if (h.action in uiConfig.get().hotkeys) continue;
        try {
          const input: UpdateUiConfigInput = { patch: { hotkeys: { [h.action]: h.defaultKey } } };
          if (by === null) uiConfig.update(input);
          else commitUiConfig(input, by);
        } catch (err) {
          log.warn("hotkey.default_skipped", { action: h.action, key: h.defaultKey, error: err });
        }
      }
    }
  };
  bindLayerHotkeys(null);

  // Default placements (WidgetContribution.defaultPlacements): a layer's widget type is placed once, when its layer
  // loads and no placement of that type exists. The widget ids already handled are kept in the layer's own state file
  // `tsf/data/layer-state/<layer>.json` ({ appliedPlacements: [...] }), so a user who removed the widget (or disabled
  // and re-enabled the layer) does not get it back. Call inside the `ui_config` mutex (or at boot, with `by` null).
  const layerStateFile = (name: string): string => join(paths.dataDir, "layer-state", `${name}.json`);
  const readApplied = async (name: string): Promise<string[]> => {
    try {
      const raw = JSON.parse(await readFile(layerStateFile(name), "utf8")) as { appliedPlacements?: unknown };
      return Array.isArray(raw.appliedPlacements) ? raw.appliedPlacements.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  const applyDefaultPlacements = async (by: Actor | null): Promise<void> => {
    for (const m of agent.registry.manifests()) {
      const wanted = m.ui.widgets.filter((w) => (w.defaultPlacements?.length ?? 0) > 0);
      if (wanted.length === 0) continue;
      const applied = await readApplied(m.name);
      let changed = false;
      for (const w of wanted) {
        if (applied.includes(w.id)) continue;
        const exists = NAVBARS.some((nb) => uiConfig.get().navbars[nb].items.some((p) => p.widget === w.id));
        try {
          if (!exists) {
            for (const place of w.defaultPlacements ?? []) {
              const config = uiConfig.get();
              const taken = new Set(NAVBARS.flatMap((nb) => config.navbars[nb].items.map((p) => p.id)));
              let n = 1;
              while (taken.has(`${w.id}-${n}`)) n++;
              const placement: WidgetPlacement = { id: `${w.id}-${n}`, widget: w.id, slot: place.slot, options: { ...w.defaultOptions } };
              const input: UpdateUiConfigInput = { patch: { navbars: { [place.navbar]: { items: [...config.navbars[place.navbar].items, placement] as unknown as Json } } } };
              if (by === null) uiConfig.update(input);
              else commitUiConfig(input, by);
            }
          }
          applied.push(w.id);
          changed = true;
        } catch (err) {
          log.warn("widget.default_placement_skipped", { widget: w.id, error: err });
        }
      }
      if (changed) await atomicWrite(layerStateFile(m.name), `${JSON.stringify({ appliedPlacements: applied }, null, 2)}\n`);
    }
  };
  await applyDefaultPlacements(null);

  // Boot: restore the stored selection (a missing file clears it); a fresh install selects Start Here.md.
  const storedRaw = deps.db.settings.getRaw(SELECTION_KEY);
  if (storedRaw === undefined) {
    const start = await readQuiet(START_PAGE);
    if (start) {
      selection = { path: START_PAGE, by: "system", at: Date.now() };
      focus = start;
      persistSelection();
    }
  } else {
    try {
      const stored = JSON.parse(storedRaw) as Partial<Selection>;
      const page = typeof stored.path === "string" ? await readQuiet(stored.path) : null;
      if (page) {
        selection = { path: page.path, by: stored.by ?? "system", at: stored.at ?? Date.now() };
        focus = page;
      } else {
        selection = { path: null, by: "system", at: Date.now() };
        if (typeof stored.path === "string") persistSelection();
      }
    } catch (err) {
      log.warn("selection.restore_failed", { error: err });
    }
  }
  store.watch();

  const recorder = await createRecorder({ feed: agent.feed, main: agent.main, db: deps.db, bus, log });

  const layers = (): readonly LayerInfo[] => agent.registry.infos(agent.settings());
  /**
   * The tools the model is offered on its next request: enabled, in an enabled layer. Derived from the settings, not
   * from the feed's last resolved agent, so a toggle shows at once (the feed follows once configure() commits).
   */
  const offered = (): ReadonlySet<string> => {
    const off = new Set(agent.settings().toolsDisabled);
    return new Set(layers().filter((l) => l.enabled).flatMap((l) => l.tools.filter((t) => !off.has(t))));
  };
  const tools = (): readonly ToolInfo[] => agent.registry.toolInfos(agent.settings(), offered());
  const ceiling = (): CeilingInfo => agent.registry.ceiling().info();

  const status = (): FactoryStatus => {
    const settings = agent.settings();
    return {
      name: settings.factoryName,
      version: VERSION,
      projectRoot: paths.projectRoot,
      pid: process.pid,
      bootId: deps.bootId,
      startedAt: deps.startedAt,
      url: deps.url(),
      busy: agent.feed.view().live.busy,
      model: agent.catalog.resolve(settings.model),
      modelSource: agent.catalog.source,
      layers: agent.registry.manifests().length,
      tools: tools().length,
      web: deps.web?.status() ?? { hash: null, building: false, lastError: null },
    };
  };

  // --- P4 helpers: widgets, hotkeys, themes, layer handlers -------------------------------------------------------
  const placed = (config: UiConfig): PlacedWidget[] =>
    NAVBARS.flatMap((navbar) => config.navbars[navbar].items.map((p): PlacedWidget => ({ ...p, navbar })));
  const findPlaced = (config: UiConfig, id: unknown): PlacedWidget => {
    if (typeof id !== "string" || id === "") throw new ServiceError("invalid", "id must be a widget placement id");
    const hit = placed(config).find((p) => p.id === id);
    if (!hit) throw new ServiceError("not_found", `no widget placed with id ${id}; list_widgets shows the ids`);
    return hit;
  };
  const strip = (p: PlacedWidget): WidgetPlacement => ({ id: p.id, widget: p.widget, slot: p.slot, options: p.options });
  /** Write one or both navbars' item lists through the UI config (arrays replace). Call inside the `ui_config` mutex. */
  const writeItems = (items: Partial<Record<NavbarId, readonly WidgetPlacement[]>>, by: Actor): UiConfig => {
    const navbars: Record<string, Json> = {};
    for (const [navbar, list] of Object.entries(items)) navbars[navbar] = { items: list as unknown as Json };
    return commitUiConfig({ patch: { navbars } }, by);
  };
  const requireNavbar = (v: unknown): NavbarId => {
    if (v !== "global" && v !== "agent") throw new ServiceError("invalid", "navbar must be global or agent");
    return v;
  };
  const requireSlot = (v: unknown): NavbarSlot => {
    if (!SLOTS.includes(v as NavbarSlot)) throw new ServiceError("invalid", "slot must be left, center or right");
    return v as NavbarSlot;
  };
  const requireIndex = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ServiceError("invalid", "index must be an integer 0 or more");
    return v;
  };
  const widgetTypes = (): WidgetType[] => [
    ...BUILTIN_WIDGETS.map(
      (widget): WidgetType => ({
        widget,
        ...BUILTIN_WIDGET_INFO[widget],
        navbars: NAVBARS,
        layer: null,
        defaultOptions: {},
      }),
    ),
    ...agent.registry.manifests().flatMap((m) =>
      m.ui.widgets.map(
        (w): WidgetType => ({
          widget: w.id,
          title: w.title,
          description: w.description,
          navbars: w.navbars,
          layer: m.name,
          defaultOptions: w.defaultOptions,
        }),
      ),
    ),
  ];

  const hotkeyInfos = (): HotkeyInfo[] => {
    const keys = uiConfig.get().hotkeys as Record<string, string>;
    const out: HotkeyInfo[] = HOTKEY_ACTIONS.map((action) => ({
      action,
      title: HOTKEY_TITLES[action],
      key: keys[action] ?? null,
      defaultKey: DEFAULT_UI_CONFIG.hotkeys[action],
      layer: null,
    }));
    const known = new Set<string>(HOTKEY_ACTIONS);
    for (const m of agent.registry.manifests()) {
      for (const h of m.ui.hotkeys) {
        known.add(h.action);
        out.push({ action: h.action, title: h.title, key: keys[h.action] ?? null, defaultKey: h.defaultKey, layer: m.name });
      }
    }
    for (const [action, key] of Object.entries(keys)) {
      if (!known.has(action)) out.push({ action, title: action, key, defaultKey: null, layer: action.split(".")[0] ?? null });
    }
    return out;
  };

  const themeInfo = (name: string): ThemeInfo => themes.info(name);
  const themeResult = (name: string, check: ThemeCheck): ThemeResult => ({
    theme: themeInfo(name),
    active: uiConfig.get().theme.name === name,
    check,
  });
  const requireThemeName = (v: unknown): string => {
    if (typeof v !== "string" || v === "") throw new ServiceError("invalid", "name must be a theme name");
    return v;
  };
  /**
   * Make `name` the active theme: render it, write `ui_config.theme` (version + 1 when it changed), update the CSS cache
   * and publish `ui_config.changed` and `theme.applied`. Call inside the `themes` mutex (lock order: themes, ui_config).
   */
  const applyTheme = async (name: string, by: Actor, mode?: UiConfig["theme"]["mode"]): Promise<ThemeCheck> => {
    const css = await themes.cssOf(name);
    const check = themes.check(name);
    return await mutex.run(UI_CONFIG_MUTEX, () => {
      const before = uiConfig.get().version;
      const config = uiConfig.setTheme({ name, ...(mode !== undefined ? { mode } : {}) });
      themes.setActive(name, css);
      if (config.version !== before) bus.publish({ type: "ui_config.changed", config, by });
      bus.publish({ type: "theme.applied", name, css, check });
      return check;
    });
  };
  /** Re-render the active theme after its values changed. Call inside the `themes` mutex. */
  const reapplyIfActive = async (name: string, by: Actor): Promise<ThemeCheck> => {
    if (uiConfig.get().theme.name === name) return await applyTheme(name, by);
    return themes.check(name);
  };

  const requireLayer = (layer: unknown, name: unknown) => {
    if (typeof layer !== "string" || typeof name !== "string" || (!isCoreRef(name) && !HANDLER_NAME.test(name))) {
      throw new ServiceError("invalid", "layer and handler names are required (handler: lowercase letters, digits and underscores, or core:<capabilityId>)");
    }
    const loaded = agent.registry.layers().find((l) => l.manifest.name === layer);
    if (!loaded) throw new ServiceError("not_found", `no such layer: ${layer}`);
    if (!agent.settings().layersEnabled.includes(layer)) throw new ServiceError("not_found", `layer ${layer} is disabled`);
    return loaded;
  };
  const layerHandler = (layer: unknown, name: unknown, kind: "queries" | "actions") => {
    const loaded = requireLayer(layer, name);
    const table = loaded.handlers?.[kind] as Record<string, unknown> | undefined;
    const handler = table !== undefined && Object.hasOwn(table, name as string) ? table[name as string] : undefined;
    if (handler === undefined) {
      throw new ServiceError("not_found", `layer ${layer as string} has no ${kind === "queries" ? "query" : "action"} ${name as string}`);
    }
    return handler;
  };
  /** The layer for a `core:` binding: loaded, enabled, and its manifest declares exactly this binding. */
  const coreLayer = (layer: unknown, name: string) => {
    const loaded = requireLayer(layer, name);
    if (!declaredCoreBindings(loaded.manifest).has(name)) {
      throw new ServiceError("not_found", `layer ${loaded.manifest.name} does not bind ${name}`);
    }
    return loaded;
  };
  const layerInput = (input: Json | undefined): Json => {
    const value = input === undefined ? {} : input;
    if (JSON.stringify(value).length > MAX_LAYER_INPUT) throw new ServiceError("too_large", "the input is too large");
    return value;
  };
  const runHandler = async <T>(layer: string, name: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ServiceError)) log.error("layer.handler_failed", { layer, handler: name, error: err });
      throw err;
    }
  };

  // --- P9 helpers: layer authoring ---------------------------------------------------------------------------
  const layerInfo = (name: string): LayerInfo => {
    const info = layers().find((l) => l.name === name);
    if (!info) throw new ServiceError("not_found", `no such layer: ${name}`);
    return info;
  };
  /**
   * Re-scan the layer folders (`agent.reloadLayers`: registry, pi-durable's extensions, `configure`) and tell every
   * client. Call inside the `layers` mutex.
   */
  const reloadNow = async (by: Actor): Promise<ReloadResult> => {
    const result = await agent.reloadLayers();
    const touched = result.added.length + result.removed.length + result.changed.length > 0;
    if (touched) publishSettings(["layersEnabled"], by);
    bus.publish({ type: "layers.changed", layers: layers() });
    publishTools();
    if (touched) bus.publish({ type: "prompts.changed", by });
    return result;
  };
  /**
   * After a layer change: bind the default keys of new layer hotkeys and drop placements whose widget type no longer
   * exists or no longer fits its navbar (they would make every later UI config write fail its semantic check).
   * Returns the removed placement ids. Takes `ui_config`, so it runs outside the `layers` mutex (lock order).
   */
  const syncUiWithLayers = async (by: Actor): Promise<string[]> =>
    await mutex.run(UI_CONFIG_MUTEX, async () => {
      bindLayerHotkeys(by);
      const types = new Map(widgetTypes().map((w) => [w.widget, w.navbars]));
      const config = uiConfig.get();
      const removed: string[] = [];
      const items: Partial<Record<NavbarId, readonly WidgetPlacement[]>> = {};
      for (const navbar of NAVBARS) {
        const all = config.navbars[navbar].items;
        const keep = all.filter((p) => types.get(p.widget)?.includes(navbar) === true);
        if (keep.length !== all.length) {
          removed.push(...all.filter((p) => !keep.includes(p)).map((p) => p.id));
          items[navbar] = keep;
        }
      }
      if (removed.length > 0) writeItems(items, by);
      await applyDefaultPlacements(by);
      return removed;
    });
  /**
   * Edit a layer's manifest.json in place (defineWidget, removeWidgetType): `edit` changes the parsed object, the
   * result is validated whole, written, and the layer reloaded. When the reloaded layer fails (a binding the loader
   * rejects), the old file is restored and the error returned, so a tool call never breaks a working layer.
   */
  const editManifestJson = async <T>(name: string, origin: Origin, edit: (raw: Record<string, unknown>) => T): Promise<T> =>
    await mutex.run(LAYERS_MUTEX, async () => {
      const folder = await requireEditable(paths, name);
      const text = await readJsonManifestText(folder);
      if (text === null) {
        throw new ServiceError("invalid", `layer ${name} uses manifest.ts; edit that file with write_layer_file instead (only manifest.json layers are edited by data)`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ServiceError("invalid", `layer ${name}: manifest.json is not valid JSON; fix it with write_layer_file`);
      }
      if (!isRecord(raw)) throw new ServiceError("invalid", `layer ${name}: manifest.json must be a JSON object`);
      const result = edit(raw);
      const next = `${JSON.stringify(raw, null, 2)}\n`;
      try {
        parseJsonManifest(name, next);
      } catch (err) {
        throw new ServiceError("invalid", err instanceof Error ? err.message : String(err));
      }
      const file = join(folder.dir, "manifest.json");
      await atomicWrite(file, next);
      await reloadNow(origin.by);
      const info = layerInfo(name);
      if (info.status === "failed") {
        await atomicWrite(file, text);
        await reloadNow(origin.by);
        throw new ServiceError("invalid", info.error ?? `layer ${name} failed to load with this change`);
      }
      log.info("layer.manifest_edited", { layer: name, by: origin.by });
      return result;
    });

  // --- P5 helpers: settings writes, prompts, tools ----------------------------------------------------------------
  const prompts = new PromptStore(deps.db.db);
  /** The catalog changed (a live list arrived, a provider layer was switched): tell the open pages to refetch. */
  const unsubscribeCatalog = agent.catalog.onChange(() => {
    bus.publish({ type: "models.changed", count: agent.catalog.list().length, fetchedAt: Date.now() });
  });
  const publishSettings = (keys: readonly SettingKey[], by: Actor): void => {
    bus.publish({ type: "settings.changed", settings: agent.settings(), keys, by });
  };
  const publishTools = (): void => {
    bus.publish({ type: "tools.changed", tools: tools() });
  };

  const requireString = (v: unknown, what: string): string => {
    if (typeof v !== "string" || v === "") throw new ServiceError("invalid", `${what} is required`);
    return v;
  };
  const requireText = (v: unknown, what: string, max: number, allowEmpty = false): string => {
    if (typeof v !== "string" || (!allowEmpty && v.trim() === "") || v.length > max || v.includes("\n")) {
      throw new ServiceError("invalid", `${what} must be a single line of text, at most ${max} characters${allowEmpty ? "" : ", not empty"}`);
    }
    return v;
  };
  const requireBool = (v: unknown, what: string): boolean => {
    if (typeof v !== "boolean") throw new ServiceError("invalid", `${what} must be true or false`);
    return v;
  };

  const contextInfo = (): ContextInfo => {
    const { meta, live } = agent.feed.view();
    return {
      model: meta.model,
      modelName: meta.modelName,
      contextTokens: meta.contextTokens,
      contextWindow: meta.contextWindow,
      fraction: meta.contextWindow > 0 ? meta.contextTokens / meta.contextWindow : 0,
      points: agent.settings().compaction,
      compaction: meta.compaction,
      compacting: live.compactions.length > 0,
      ...(live.compactionFailure ? { compactionFailure: live.compactionFailure.error } : {}),
      usage: meta.usage,
    };
  };

  const selectionInfo = (): ModelSelection => {
    const s = agent.settings();
    const model = agent.catalog.resolve(s.model);
    const info = agent.catalog.info(model);
    return {
      model,
      modelName: info?.name ?? null,
      thinkingLevel: s.thinkingLevel,
      effectiveThinkingLevel: agent.catalog.clampThinking(model, s.thinkingLevel),
      supportedThinkingLevels: info?.thinkingLevels ?? THINKING_LEVELS,
    };
  };

  const pointsPatch = (v: unknown): Partial<CompactionPoints> => {
    if (!isRecord(v)) throw new ServiceError("invalid", "the compaction points must be an object");
    const out: { -readonly [K in keyof CompactionPoints]?: CompactionPoints[K] } = {};
    const int = (key: "background" | "forced" | "keepRecentTokens", min: number): void => {
      const x = v[key];
      if (x === undefined) return;
      if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > MAX_POINT) {
        throw new ServiceError("invalid", `${key} must be a whole number of tokens from ${min} to ${MAX_POINT}`);
      }
      out[key] = x;
    };
    for (const key of Object.keys(v)) {
      if (!["enabled", "background", "forced", "keepRecentTokens"].includes(key)) {
        throw new ServiceError("invalid", `unknown compaction setting: ${key} (enabled, background, forced, keepRecentTokens)`);
      }
    }
    if (v.enabled !== undefined) out.enabled = requireBool(v.enabled, "enabled");
    int("background", 0);
    int("forced", 1_000);
    int("keepRecentTokens", 0);
    if (Object.keys(out).length === 0) {
      throw new ServiceError("invalid", "give at least one of enabled, background, forced, keepRecentTokens");
    }
    return out;
  };

  // Prompts: ids are `system`, `custom:<id>`, `section:<key>`, `runtime:<id>`; the bare forms are accepted too.
  const preview = (text: string): string => (text.split("\n", 1)[0] ?? "").trim().slice(0, 60);
  const systemInfo = (): PromptInfo => {
    const override = agent.settings().systemPrompt;
    const text = override ?? DEFAULT_SYSTEM_PROMPT;
    return { id: "system", layer: "system", title: "System prompt", enabled: true, editable: true, override: override !== null, length: text.length, text };
  };
  const customInfo = (p: CustomPrompt): PromptInfo => ({
    id: `custom:${p.id}`,
    layer: "custom",
    title: p.name,
    enabled: p.enabled,
    editable: true,
    by: p.createdBy,
    length: p.text.length,
    text: p.text,
  });
  const runtimeInfo = (p: RuntimePrompt): PromptInfo => ({
    id: `runtime:${p.id}`,
    layer: "runtime",
    title: preview(p.text) || "Runtime prompt",
    enabled: true,
    editable: true,
    by: p.createdBy,
    length: p.text.length,
    text: p.text,
  });
  /** Every gateable section of the enabled layers, in layer order. */
  const sectionRefs = (): { layer: string; key: string }[] => {
    const on = new Set(agent.settings().layersEnabled);
    return agent.registry
      .layers()
      .filter((l) => on.has(l.manifest.name))
      .flatMap((l) => (l.extension.sections ?? []).filter((s) => !NEVER_GATED.has(s.key)).map((s) => ({ layer: l.manifest.name, key: s.key })));
  };
  const readDisabled = async (): Promise<readonly string[]> => {
    try {
      return await disabledSections(agent.harness, agent.main.id, ctx);
    } catch (err) {
      log.warn("prompts.sections_read_failed", { error: err });
      return [];
    }
  };
  const sectionInfo = (ref: { layer: string; key: string }, off: readonly string[], text: string | null): PromptInfo => ({
    id: `section:${ref.key}`,
    layer: "extension",
    title: agent.registry.sectionTitle(ref.key) ?? (ref.key.startsWith(`${ref.layer}-`) ? ref.key.slice(ref.layer.length + 1) : ref.key),
    enabled: !off.includes(ref.key),
    editable: false,
    layerName: ref.layer,
    key: ref.key,
    length: text?.length ?? 0,
    text,
  });
  /** The section's own text (what it renders now, even when switched off), or null when it cannot be rendered here. */
  const renderSection = async (ref: { layer: string; key: string }): Promise<string | null> => {
    const section = agent.registry.extension(ref.layer)?.sections?.find((s) => s.key === ref.key);
    if (!section) return null;
    try {
      const input: PromptInput = {
        conversationId: agent.main.id,
        agent: await agent.main.agent(ctx),
        env: undefined,
        shown: {},
        read: agent.harness,
      };
      return (await originalSection(section).render(input, ctx)) ?? "";
    } catch (err) {
      log.warn("prompts.section_render_failed", { section: ref.key, error: err });
      return null;
    }
  };
  const requireSection = (key: string): { layer: string; key: string } => {
    if (NEVER_GATED.has(key)) {
      throw new ServiceError("invalid", "the system prompt cannot be switched off; set_system_prompt replaces it");
    }
    const ref = sectionRefs().find((r) => r.key === key);
    if (!ref) throw new ServiceError("not_found", `no such prompt section: ${key}; list_prompts shows them`);
    return ref;
  };
  type PromptRef =
    | { kind: "system" }
    | { kind: "custom"; id: string }
    | { kind: "runtime"; id: string }
    | { kind: "section"; ref: { layer: string; key: string } };
  const findPrompt = (raw: unknown): PromptRef => {
    const id = requireString(raw, "id");
    if (id === "system") return { kind: "system" };
    if (id.startsWith("custom:")) return { kind: "custom", id: id.slice(7) };
    if (id.startsWith("runtime:")) return { kind: "runtime", id: id.slice(8) };
    if (id.startsWith("section:")) return { kind: "section", ref: requireSection(id.slice(8)) };
    if (prompts.customGet(id)) return { kind: "custom", id };
    if (prompts.runtimeGet(id)) return { kind: "runtime", id };
    const ref = sectionRefs().find((r) => r.key === id);
    if (ref) return { kind: "section", ref };
    throw new ServiceError("not_found", `no such prompt: ${id}; list_prompts shows the ids`);
  };
  const customPrompt = (rawId: unknown): CustomPrompt => {
    const id = bareId(rawId, "custom");
    const found = prompts.customGet(id);
    if (!found) throw new ServiceError("not_found", `no such custom prompt: ${id}; list_prompts shows them`);
    return found;
  };

  /** A tool name must be inside the ceiling; outside is `forbidden`, unknown is `not_found`. */
  const requireTool = (rawName: unknown): ToolInfo => {
    const name = requireString(rawName, "name");
    const info = tools().find((t) => t.name === name);
    if (info) return info;
    if (agent.registry.toolLayer(name) !== undefined) {
      throw new ServiceError("forbidden", `tool ${name} is outside the permissions ceiling; it cannot be listed, described or enabled`);
    }
    throw new ServiceError("not_found", `no such tool: ${name}; list_tools shows them`);
  };

  // --- P6: cron (DESIGN 9) ----------------------------------------------------------------------------------------
  const cronStore = new CronStore(deps.db.db);
  const cronStatusOf = (status: string): CronRunStatus => (status === "done" ? "answered" : status === "placed" ? "running" : status === "queued" ? "queued" : "failed");
  const publishCron = (): void => bus.publish({ type: "cron.changed", entries: cronStore.entries() });
  const scheduler = new CronScheduler({
    store: cronStore,
    log: log.child({ component: "cron" }),
    lock: (fn) => mutex.run(CRON_MUTEX, fn),
    onChange: publishCron,
    onFired: (e) => bus.publish({ type: "cron.fired", ...e }),
    submit: async (job: FireJob): Promise<FireResult> => {
      // A cron fire is an input with entry kind tsf.cron (DESIGN 4.1); a busy conversation queues it as a follow-up.
      const submission = await agent.main.submit(
        {
          type: "input",
          content: job.prompt,
          requestId: job.requestId,
          whenBusy: "followUp",
          entry: { kind: CRON_ENTRY_KIND, data: { ...job.data } },
        },
        ctx,
      );
      const record = await submission.status(ctx);
      return { submissionId: Number(submission.id), status: cronStatusOf(record.status) };
    },
    ...(typeof agent.harness.submission === "function"
      ? {
          settle: async (submissionId: number): Promise<CronRunStatus> => {
            const submission = await agent.harness.submission(submissionId as never, ctx);
            if (!submission) return "failed";
            const record = await submission.wait(ctx);
            return record.status === "done" ? "answered" : "failed";
          },
        }
      : {}),
  });

  const service: FactoryService = {
    status,

    snapshot(): Snapshot {
      return {
        apiVersion: API_VERSION,
        bootId: deps.bootId,
        serverTime: Date.now(),
        status: status(),
        chat: agent.feed.view(),
        pages: store.tree(),
        selection,
        focus,
        settings: agent.settings(),
        uiConfig: uiConfig.get(),
        layers: layers(),
        tools: tools(),
        ceiling: ceiling(),
        runs: recorder.list({ limit: SNAPSHOT_RUNS }),
        themes: themes.list(),
        themeCss: themes.activeCss(),
        cron: cronStore.entries(),
      };
    },

    chatView(): ChatView {
      return agent.feed.view();
    },

    async loadEarlier(input: EarlierInput): Promise<EarlierPage> {
      if (!Number.isInteger(input.before) || input.before < 1) {
        throw new ServiceError("invalid", "before must be a positive integer entry id");
      }
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ServiceError("invalid", "limit must be an integer 1..200");
      }
      return await agent.feed.loadEarlier({ before: input.before, limit });
    },

    async sendMessage(input: SendMessageInput, origin: Origin): Promise<SendResult> {
      if (typeof input.text !== "string" || input.text.trim() === "") {
        throw new ServiceError("invalid", "text must not be empty");
      }
      if (input.text.length > MAX_TEXT) throw new ServiceError("invalid", `text must be at most ${MAX_TEXT} characters`);
      if (typeof input.requestId !== "string" || input.requestId === "" || input.requestId.length > MAX_REQUEST_ID) {
        throw new ServiceError("invalid", `requestId must be 1..${MAX_REQUEST_ID} characters`);
      }
      if (input.mode !== undefined && input.mode !== "followUp" && input.mode !== "steer") {
        throw new ServiceError("invalid", "mode must be followUp or steer");
      }
      // Admission only: the run continues in this process and its output reaches clients through the feed (DESIGN 7).
      const submission = await agent.main.submit(
        { type: "input", content: input.text, requestId: `chat:${input.requestId}`, whenBusy: input.mode ?? "followUp" },
        ctx,
      );
      const record = await submission.status(ctx);
      log.info("chat.send", { by: origin.by, submissionId: Number(submission.id), status: record.status });
      return { submissionId: Number(submission.id), requestId: input.requestId, status: record.status };
    },

    async stopRun(origin: Origin): Promise<{ readonly stopped: boolean }> {
      const live = agent.feed.view().live;
      const stopped = live.busy || live.inbox.length > 0;
      await agent.main.abort(ctx);
      log.info("chat.stop", { by: origin.by, stopped });
      return { stopped };
    },

    listModels(): readonly ModelInfo[] {
      return agent.catalog.list();
    },

    getSettings(): Settings {
      return agent.settings();
    },

    // --- P2: layers, tools, ceiling, runs ----------------------------------------------------------------------
    listLayers: layers,
    listTools: tools,
    getCeiling: ceiling,

    listRuns(input: RunListInput): readonly RunSummary[] {
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ServiceError("invalid", "limit must be an integer 1..200");
      if (input.before !== undefined && (!Number.isInteger(input.before) || input.before < 1)) {
        throw new ServiceError("invalid", "before must be a positive integer run id");
      }
      return recorder.list({ limit, ...(input.before !== undefined ? { before: input.before } : {}) });
    },

    getRun(id: number): RunDetail {
      const run = Number.isInteger(id) ? recorder.get(id) : undefined;
      if (!run) throw new ServiceError("not_found", `no such run: ${id}`);
      return run;
    },

    // --- P2: pages ----------------------------------------------------------------------------------------------
    listPages(): PageTree {
      return store.tree();
    },

    async readPage(input: { readonly path: PagePath }): Promise<Page> {
      return await store.read(input.path);
    },

    async createPage(input: CreatePageInput, origin: Origin): Promise<Page> {
      return await mutex.run(PAGES_MUTEX, async () => {
        const page = await store.create(input.path, input.content);
        if (selection.path === page.path) focus = page;
        bus.publish({ type: "pages.changed", tree: store.tree(), paths: [page.path], by: origin.by });
        bus.publish({ type: "page.updated", page, by: origin.by });
        return page;
      });
    },

    async updatePage(input: UpdatePageInput, origin: Origin): Promise<Page> {
      return await mutex.run(PAGES_MUTEX, async () => {
        const page = await store.update(input);
        if (selection.path === page.path) focus = page;
        bus.publish({ type: "page.updated", page, by: origin.by });
        return page;
      });
    },

    async movePage(input: MovePageInput, origin: Origin): Promise<MoveResult> {
      return await mutex.run(PAGES_MUTEX, async () => {
        const result = await store.move(input.from, input.to);
        const paths = result.moved.flatMap((m) => [m.from, m.to]);
        const followed = selection.path === null ? undefined : result.moved.find((m) => m.from === selection.path);
        const page = followed ? await readQuiet(followed.to) : null;
        bus.publish({ type: "pages.changed", tree: store.tree(), paths: paths.length > 0 ? paths : [result.from, result.to], by: origin.by });
        if (followed) setSelection(page ? followed.to : null, page, origin.by);
        return result;
      });
    },

    async deletePage(input: DeletePageInput, origin: Origin): Promise<DeleteResult> {
      return await mutex.run(PAGES_MUTEX, async () => {
        const result = await store.remove(input.path, input.recursive);
        bus.publish({ type: "pages.changed", tree: store.tree(), paths: [result.path, ...result.removed], by: origin.by });
        for (const path of result.removed) bus.publish({ type: "page.removed", path, by: origin.by });
        if (selection.path !== null && result.removed.includes(selection.path)) setSelection(null, null, origin.by);
        return result;
      });
    },

    async createFolder(input: { readonly path: PagePath }, origin: Origin): Promise<FolderNode> {
      return await mutex.run(PAGES_MUTEX, async () => {
        const path = store.normalise(input.path, "folder");
        const existed = store.hasFolder(path);
        const folder = await store.mkdir(path);
        if (!existed) bus.publish({ type: "pages.changed", tree: store.tree(), paths: [path], by: origin.by });
        return folder;
      });
    },

    async selectPage(input: { readonly path: PagePath }, origin: Origin): Promise<Selection> {
      return await mutex.run(PAGES_MUTEX, async () => {
        const page = await store.read(input.path);
        setSelection(page.path, page, origin.by);
        const selected = selection;
        // The page comes forward: un-maximise the agent pane (spec 8.1), after selection.changed, in lock order.
        if (uiConfig.get().panes.agentMaximised) {
          await mutex.run(UI_CONFIG_MUTEX, () => {
            if (uiConfig.get().panes.agentMaximised) commitUiConfig({ patch: { panes: { agentMaximised: false } } }, origin.by);
          });
        }
        return selected;
      });
    },

    async unselectPage(origin: Origin): Promise<Selection> {
      return await mutex.run(PAGES_MUTEX, async () => {
        if (selection.path !== null) setSelection(null, null, origin.by);
        return selection;
      });
    },

    getSelection(): Selection {
      return selection;
    },

    // --- P3 -------------------------------------------------------------------------------------------------
    getUiConfig(): UiConfig {
      return uiConfig.get();
    },

    async updateUiConfig(input: UpdateUiConfigInput, origin: Origin): Promise<UiConfig> {
      return await mutex.run(UI_CONFIG_MUTEX, () => commitUiConfig(input, origin.by));
    },

    getThemeCss(): string {
      return themes.activeCss();
    },

    // --- P4: widgets ------------------------------------------------------------------------------------------
    listWidgets(): WidgetList {
      return { available: widgetTypes(), placements: placed(uiConfig.get()) };
    },

    async addWidget(input: AddWidgetInput, origin: Origin): Promise<PlacedWidget> {
      const navbar = requireNavbar(input.navbar);
      const slot = requireSlot(input.slot);
      if (typeof input.widget !== "string" || input.widget === "") throw new ServiceError("invalid", "widget must be a widget type");
      if (input.options !== undefined && !isRecord(input.options)) throw new ServiceError("invalid", "options must be an object");
      if (input.index !== undefined) requireIndex(input.index);
      return await mutex.run(UI_CONFIG_MUTEX, () => {
        const config = uiConfig.get();
        const all = placed(config);
        // The agent's id comes from its call id, so a replayed call finds its own placement instead of adding another.
        let id: string;
        if (origin.callId !== undefined) {
          id = `${input.widget}-${sha12(origin.callId).slice(0, 6)}`;
          const again = all.find((p) => p.id === id);
          if (again) return again;
        } else {
          const taken = new Set(all.map((p) => p.id));
          let n = 1;
          while (taken.has(`${input.widget}-${n}`)) n++;
          id = `${input.widget}-${n}`;
        }
        const defaults = widgetTypes().find((w) => w.widget === input.widget)?.defaultOptions ?? {};
        const placement: WidgetPlacement = { id, widget: input.widget, slot, options: { ...defaults, ...(input.options ?? {}) } };
        const items = [...config.navbars[navbar].items];
        items.splice(Math.min(input.index ?? items.length, items.length), 0, placement);
        writeItems({ [navbar]: items }, origin.by);
        return { ...placement, navbar };
      });
    },

    async removeWidget(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string; readonly navbar: NavbarId }> {
      return await mutex.run(UI_CONFIG_MUTEX, () => {
        const config = uiConfig.get();
        const hit = findPlaced(config, input.id);
        writeItems({ [hit.navbar]: config.navbars[hit.navbar].items.filter((p) => p.id !== hit.id) }, origin.by);
        return { id: hit.id, navbar: hit.navbar };
      });
    },

    async moveWidget(input: MoveWidgetInput, origin: Origin): Promise<PlacedWidget> {
      const index = requireIndex(input.index);
      const target = input.navbar === undefined ? undefined : requireNavbar(input.navbar);
      const slot = input.slot === undefined ? undefined : requireSlot(input.slot);
      return await mutex.run(UI_CONFIG_MUTEX, () => {
        const config = uiConfig.get();
        const hit = findPlaced(config, input.id);
        const to = target ?? hit.navbar;
        const moved: WidgetPlacement = { ...strip(hit), slot: slot ?? hit.slot };
        const source = config.navbars[hit.navbar].items.filter((p) => p.id !== hit.id);
        const dest = to === hit.navbar ? source : [...config.navbars[to].items];
        dest.splice(Math.min(index, dest.length), 0, moved);
        writeItems(to === hit.navbar ? { [to]: dest } : { [hit.navbar]: source, [to]: dest }, origin.by);
        return { ...moved, navbar: to };
      });
    },

    async setWidgetOptions(input: SetWidgetOptionsInput, origin: Origin): Promise<PlacedWidget> {
      if (!isRecord(input.options)) throw new ServiceError("invalid", "options must be an object");
      return await mutex.run(UI_CONFIG_MUTEX, () => {
        const config = uiConfig.get();
        const hit = findPlaced(config, input.id);
        const options: Record<string, Json> = { ...(hit.options as Record<string, Json>) };
        for (const [k, v] of Object.entries(input.options)) {
          if (k === "__proto__" || k === "constructor" || k === "prototype") throw new ServiceError("invalid", `option ${k} is not allowed`);
          if (v === null) delete options[k];
          else options[k] = v;
        }
        const next: WidgetPlacement = { ...strip(hit), options };
        writeItems({ [hit.navbar]: config.navbars[hit.navbar].items.map((p) => (p.id === hit.id ? next : p)) }, origin.by);
        return { ...next, navbar: hit.navbar };
      });
    },

    // --- P4: hotkeys ------------------------------------------------------------------------------------------
    listHotkeys(): readonly HotkeyInfo[] {
      return hotkeyInfos();
    },

    async setHotkey(input: SetHotkeyInput, origin: Origin): Promise<HotkeyInfo> {
      if (typeof input.action !== "string" || input.action === "") throw new ServiceError("invalid", "action is required");
      if (typeof input.key !== "string" || input.key === "") throw new ServiceError("invalid", "key must be one key or mod+key");
      if (!hotkeyInfos().some((h) => h.action === input.action)) {
        throw new ServiceError("not_found", `no such hotkey action: ${input.action}; list_hotkeys shows them`);
      }
      return await mutex.run(UI_CONFIG_MUTEX, () => {
        commitUiConfig({ patch: { hotkeys: { [input.action]: input.key } } }, origin.by);
        return hotkeyInfos().find((h) => h.action === input.action)!;
      });
    },

    // --- P4: themes -------------------------------------------------------------------------------------------
    listThemes(): readonly ThemeInfo[] {
      return themes.list();
    },

    async setTheme(input: { readonly name: string; readonly mode?: "light" | "dark" | "system" }, origin: Origin): Promise<ThemeResult> {
      const name = requireThemeName(input.name);
      if (input.mode !== undefined && input.mode !== "light" && input.mode !== "dark" && input.mode !== "system") {
        throw new ServiceError("invalid", "mode must be light, dark or system");
      }
      return await mutex.run(THEMES_MUTEX, async () => {
        if (!themes.has(name)) throw new ServiceError("not_found", `no such theme: ${name}; list_themes shows them`);
        const check = await applyTheme(name, origin.by, input.mode);
        return themeResult(name, check);
      });
    },

    async createTheme(input: CreateThemeInput, origin: Origin): Promise<ThemeResult> {
      if (!isRecord(input)) throw new ServiceError("invalid", "the input must be an object");
      return await mutex.run(THEMES_MUTEX, async () => {
        const { created } = themes.create(input);
        if (created) bus.publish({ type: "themes.changed", themes: themes.list() });
        const check = await applyTheme(input.name, origin.by);
        return themeResult(input.name, check);
      });
    },

    async setThemeValues(input: SetThemeValuesInput, origin: Origin): Promise<ThemeResult> {
      const name = requireThemeName(input.name);
      return await mutex.run(THEMES_MUTEX, async () => {
        const before = themes.definition(name);
        const after = themes.setValues(name, input);
        if (after !== before) bus.publish({ type: "themes.changed", themes: themes.list() });
        const check = after !== before ? await reapplyIfActive(name, origin.by) : themes.check(name);
        return themeResult(name, check);
      });
    },

    checkTheme(input: { readonly name: string }): ThemeCheck {
      return themes.check(requireThemeName(input.name));
    },

    async fixTheme(input: { readonly name: string }, origin: Origin): Promise<FixThemeResult> {
      const name = requireThemeName(input.name);
      return await mutex.run(THEMES_MUTEX, async () => {
        const before = themes.definition(name);
        const { theme, applied } = themes.fix(name);
        if (theme !== before) bus.publish({ type: "themes.changed", themes: themes.list() });
        const check = theme !== before ? await reapplyIfActive(name, origin.by) : themes.check(name);
        return { ...themeResult(name, check), applied };
      });
    },

    async deleteTheme(input: { readonly name: string }, origin: Origin): Promise<DeleteThemeResult> {
      const name = requireThemeName(input.name);
      return await mutex.run(THEMES_MUTEX, async () => {
        const wasActive = uiConfig.get().theme.name === name;
        themes.delete(name);
        bus.publish({ type: "themes.changed", themes: themes.list() });
        if (wasActive) await applyTheme(themes.fallback(), origin.by);
        return { name, active: uiConfig.get().theme.name };
      });
    },

    // --- P5: context and compaction ---------------------------------------------------------------------------
    getContext: contextInfo,

    async setCompaction(points: Partial<CompactionPoints>, origin: Origin): Promise<ContextInfo> {
      const patch = pointsPatch(points);
      return await mutex.run(SETTINGS_MUTEX, () => {
        deps.db.settings.set("compaction", { ...agent.settings().compaction, ...patch });
        // The Harness reads its policy at every use (clamped to the window, D3); nothing is committed to the
        // conversation, so the feed is told to recompute the context readings.
        agent.feed.refreshMeta();
        publishSettings(["compaction"], origin.by);
        return contextInfo();
      });
    },

    async compact(input: CompactInput, origin: Origin): Promise<CompactResult> {
      const instructions = input?.instructions;
      if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > MAX_COMPACT_INSTRUCTIONS)) {
        throw new ServiceError("invalid", `instructions must be text of at most ${MAX_COMPACT_INSTRUCTIONS} characters`);
      }
      const text = instructions !== undefined && instructions.trim() !== "" ? instructions : undefined;
      const task = await agent.main.compact(text, ctx);
      log.info("chat.compact", { by: origin.by, taskId: Number(task) });
      return { taskId: Number(task), instructions: text ?? null };
    },

    // --- P5: model and thinking -------------------------------------------------------------------------------
    async refreshModels(origin: Origin): Promise<RefreshModelsResult> {
      const refreshed = await agent.catalog.refresh(AbortSignal.timeout(30_000));
      log.info("models.refresh", { by: origin.by, refreshed });
      return { refreshed, count: agent.catalog.list().length };
    },

    async setModel(ref: ModelRef, origin: Origin): Promise<ModelSelection> {
      const provider = requireString(ref?.provider, "provider");
      const modelId = requireString(ref?.modelId, "modelId");
      if (!agent.catalog.model({ provider, modelId })) {
        throw new ServiceError("not_found", `no such model: ${provider}/${modelId}; list_models shows the models of the enabled providers`);
      }
      return await mutex.run(SETTINGS_MUTEX, async () => {
        deps.db.settings.set("model", { provider, modelId });
        await agent.applySettings();
        publishSettings(["model"], origin.by);
        return selectionInfo();
      });
    },

    async setThinkingLevel(level: ThinkingLevel, origin: Origin): Promise<ModelSelection> {
      if (!THINKING_LEVELS.includes(level)) throw new ServiceError("invalid", `level must be one of ${THINKING_LEVELS.join(", ")}`);
      return await mutex.run(SETTINGS_MUTEX, async () => {
        deps.db.settings.set("thinkingLevel", level);
        await agent.applySettings();
        publishSettings(["thinkingLevel"], origin.by);
        return selectionInfo();
      });
    },

    // --- P5: prompts -------------------------------------------------------------------------------------------
    async listPrompts(): Promise<PromptList> {
      const off = await readDisabled();
      return {
        system: systemInfo(),
        custom: prompts.customList().map(customInfo),
        extensions: sectionRefs().map((r) => sectionInfo(r, off, null)),
        runtime: prompts.runtimeList().map(runtimeInfo),
      };
    },

    async getPrompt(input: { readonly id: string }): Promise<PromptInfo> {
      const found = findPrompt(input?.id);
      switch (found.kind) {
        case "system":
          return systemInfo();
        case "custom":
          return customInfo(customPrompt(found.id));
        case "runtime": {
          const p = prompts.runtimeGet(found.id);
          if (!p) throw new ServiceError("not_found", `no such runtime prompt: ${found.id}; list_prompts shows them`);
          return runtimeInfo(p);
        }
        case "section":
          return sectionInfo(found.ref, await readDisabled(), await renderSection(found.ref));
      }
    },

    async setSystemPrompt(input: { readonly text: string | null }, origin: Origin): Promise<PromptInfo> {
      const text = input?.text;
      if (text !== null) checkText(text, MAX_SYSTEM_PROMPT, "text");
      await mutex.run(SETTINGS_MUTEX, () => {
        // Null removes the stored row, so the shipped system-prompt.md applies; the section reads it at each request.
        deps.db.settings.set("systemPrompt", text === null ? undefined : text);
        publishSettings(["systemPrompt"], origin.by);
      });
      await mutex.run(PROMPTS_MUTEX, () => bus.publish({ type: "prompts.changed", by: origin.by }));
      return systemInfo();
    },

    async createCustomPrompt(input: CreateCustomPromptInput, origin: Origin): Promise<PromptInfo> {
      const name = checkCustomName(input?.name);
      const text = checkText(input?.text, MAX_CUSTOM_TEXT, "text");
      const enabled = input.enabled === undefined ? true : requireBool(input.enabled, "enabled");
      return await mutex.run(PROMPTS_MUTEX, () => {
        const before = prompts.customList().length;
        const created = prompts.customCreate({ id: promptId(origin, origin.by === "agent" ? "a" : "u"), name, text, enabled, by: origin.by });
        if (prompts.customList().length !== before) bus.publish({ type: "prompts.changed", by: origin.by });
        return customInfo(created);
      });
    },

    async updateCustomPrompt(input: UpdateCustomPromptInput, origin: Origin): Promise<PromptInfo> {
      const id = customPrompt(input?.id).id;
      const patch: { name?: string; text?: string } = {};
      if (input.name !== undefined) patch.name = checkCustomName(input.name);
      if (input.text !== undefined) patch.text = checkText(input.text, MAX_CUSTOM_TEXT, "text");
      if (patch.name === undefined && patch.text === undefined) throw new ServiceError("invalid", "give a new name or text");
      return await mutex.run(PROMPTS_MUTEX, () => {
        const updated = prompts.customUpdate(id, patch);
        bus.publish({ type: "prompts.changed", by: origin.by });
        return customInfo(updated);
      });
    },

    async deleteCustomPrompt(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string }> {
      const id = customPrompt(input?.id).id;
      return await mutex.run(PROMPTS_MUTEX, () => {
        prompts.customDelete(id);
        bus.publish({ type: "prompts.changed", by: origin.by });
        return { id: `custom:${id}` };
      });
    },

    async togglePrompt(input: { readonly id: string; readonly enabled: boolean }, origin: Origin): Promise<PromptInfo> {
      const found = findPrompt(input?.id);
      const enabled = requireBool(input?.enabled, "enabled");
      if (found.kind === "system" || found.kind === "runtime") {
        throw new ServiceError("invalid", `${found.kind === "system" ? "the system prompt" : "a runtime prompt"} cannot be switched off; ${found.kind === "system" ? "set_system_prompt replaces it" : "remove_runtime_prompt removes it"}`);
      }
      return await mutex.run(PROMPTS_MUTEX, async () => {
        if (found.kind === "custom") {
          customPrompt(found.id);
          const updated = prompts.customUpdate(found.id, { enabled });
          bus.publish({ type: "prompts.changed", by: origin.by });
          return customInfo(updated);
        }
        // An extension section (D6): the switch is the conversation document the wrapped section reads.
        const key = found.ref.key;
        await agent.main.commit(async (tx) => {
          const doc = await tx.doc(PromptSectionsDoc, agent.main.id);
          const set = new Set(doc.disabled);
          if (enabled) set.delete(key);
          else set.add(key);
          doc.disabled = [...set];
        }, ctx);
        bus.publish({ type: "prompts.changed", by: origin.by });
        return sectionInfo(found.ref, await readDisabled(), null);
      });
    },

    async appendRuntimePrompt(input: { readonly text: string }, origin: Origin): Promise<PromptInfo> {
      const text = checkText(input?.text, MAX_RUNTIME_TEXT, "text");
      return await mutex.run(PROMPTS_MUTEX, async () => {
        const row = prompts.runtimeAppend({ id: promptId(origin, origin.by === "agent" ? "a" : "u"), text, by: origin.by });
        // `instructions` is the reserved section rendered after all others; it applies from the next request.
        await agent.applySettings();
        bus.publish({ type: "prompts.changed", by: origin.by });
        return runtimeInfo(row);
      });
    },

    async removeRuntimePrompt(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string }> {
      const id = bareId(input?.id, "runtime");
      return await mutex.run(PROMPTS_MUTEX, async () => {
        if (!prompts.runtimeRemove(id)) throw new ServiceError("not_found", `no such runtime prompt: ${id}; list_prompts shows them`);
        await agent.applySettings();
        bus.publish({ type: "prompts.changed", by: origin.by });
        return { id: `runtime:${id}` };
      });
    },

    async clearRuntimePrompts(origin: Origin): Promise<{ readonly removed: number }> {
      return await mutex.run(PROMPTS_MUTEX, async () => {
        const removed = prompts.runtimeClear();
        await agent.applySettings();
        if (removed > 0) bus.publish({ type: "prompts.changed", by: origin.by });
        return { removed };
      });
    },

    // --- P5: tools and layers ----------------------------------------------------------------------------------
    describeTool(input: DescribeToolInput): ToolDescription {
      const syntax = input?.syntax;
      if (syntax !== undefined && syntax !== "json" && syntax !== "typescript") {
        throw new ServiceError("invalid", "syntax must be json or typescript");
      }
      const info = requireTool(input?.name);
      const schema = syntax === "typescript" ? undefined : info.parameters;
      const signature = syntax === "json" ? undefined : toolSignature(info.name, info.parameters);
      return {
        name: info.name,
        layer: info.layer,
        description: info.description,
        replay: info.replay,
        enabled: info.enabled,
        offered: info.offered,
        syntax: syntax ?? "both",
        ...(schema !== undefined ? { schema } : {}),
        ...(signature !== undefined ? { signature } : {}),
        text: signature ?? JSON.stringify(info.parameters, null, 2),
      };
    },

    async setToolEnabled(input: { readonly name: string; readonly enabled: boolean }, origin: Origin): Promise<ToolInfo> {
      const info = requireTool(input?.name);
      const enabled = requireBool(input?.enabled, "enabled");
      return await mutex.run(SETTINGS_MUTEX, async () => {
        const off = agent.settings().toolsDisabled;
        if (enabled === !off.includes(info.name)) return tools().find((t) => t.name === info.name)!;
        deps.db.settings.set("toolsDisabled", enabled ? off.filter((n) => n !== info.name) : [...off, info.name]);
        // configure({ tools: { remove } }): the next request offers the new set, no restart.
        await agent.applySettings();
        publishSettings(["toolsDisabled"], origin.by);
        publishTools();
        return tools().find((t) => t.name === info.name)!;
      });
    },

    async setLayerEnabled(input: { readonly name: string; readonly enabled: boolean }, origin: Origin): Promise<LayerInfo> {
      const name = requireString(input?.name, "name");
      const enabled = requireBool(input?.enabled, "enabled");
      const loaded = agent.registry.layers().find((l) => l.manifest.name === name);
      if (!loaded) throw new ServiceError("not_found", `no such layer: ${name}; list_layers shows the loaded layers`);
      if (!enabled && loaded.manifest.required === true) {
        throw new ServiceError("forbidden", `layer ${name} is required and cannot be disabled`);
      }
      return await mutex.run(SETTINGS_MUTEX, async () => {
        const on = agent.settings().layersEnabled.includes(name);
        if (on !== enabled) {
          const provider = loaded.provider;
          const live = provider !== undefined && agent.catalog.source !== "faux";
          if (live && !enabled) {
            const others = agent.registry
              .layers()
              .filter((l) => l.provider !== undefined && l.manifest.name !== name && agent.settings().layersEnabled.includes(l.manifest.name));
            if (others.length === 0) {
              throw new ServiceError("conflict", "at least one provider layer must stay enabled: no model would remain");
            }
          }
          const stored = deps.db.settings.stored().layerToggles ?? {};
          deps.db.settings.set("layerToggles", { ...stored, [name]: enabled });
          if (live) {
            if (enabled) agent.catalog.enableProvider(provider);
            else agent.catalog.disableProvider(provider.provider.id);
          }
          await agent.applySettings();
          publishSettings(["layersEnabled"], origin.by);
          bus.publish({ type: "layers.changed", layers: layers() });
          publishTools();
        }
        return layers().find((l) => l.name === name)!;
      });
    },

    // --- P4: panels and layer handlers ------------------------------------------------------------------------
    async openPanel(input: OpenPanelInput, origin: Origin): Promise<OpenPanelInput> {
      if (input.target !== "settings" && input.target !== "cron") throw new ServiceError("invalid", "target must be settings or cron");
      if (input.section !== undefined && (typeof input.section !== "string" || input.section === "" || input.section.length > 64)) {
        throw new ServiceError("invalid", "section must be a short section name");
      }
      bus.publish({ type: "ui.open", target: input.target, ...(input.section !== undefined ? { section: input.section } : {}), by: origin.by });
      return { target: input.target, ...(input.section !== undefined ? { section: input.section } : {}) };
    },

    // --- P6: cron ----------------------------------------------------------------------------------------------
    listCrons(): readonly CronEntry[] {
      return cronStore.entries();
    },

    async createCron(input: CreateCronInput, origin: Origin): Promise<CronEntry> {
      const name = checkName(input?.name);
      const expr = checkExpr(input.expr);
      const prompt = checkPrompt(input.prompt);
      const enabled = input.enabled === undefined ? true : requireBool(input.enabled, "enabled");
      return await mutex.run(CRON_MUTEX, () => {
        if (cronStore.count() >= MAX_CRONS && cronStore.get(cronId(origin)) === undefined) {
          throw new ServiceError("conflict", `at most ${MAX_CRONS} cron entries; delete one first`);
        }
        const { row, created } = cronStore.insert({
          id: cronId(origin),
          name,
          expr,
          prompt,
          enabled,
          nextRunAt: enabled ? scheduler.nextAfter(expr) : null,
        });
        if (created) {
          scheduler.arm(row.id);
          publishCron();
        }
        return cronStore.entry(row);
      });
    },

    async updateCron(input: UpdateCronInput, origin: Origin): Promise<CronEntry> {
      if (typeof input?.id !== "string" || input.id === "") throw new ServiceError("invalid", "id must be a cron id");
      const patch: { name?: string; expr?: string; prompt?: string; enabled?: boolean } = {};
      if (input.name !== undefined) patch.name = checkName(input.name);
      if (input.expr !== undefined) patch.expr = checkExpr(input.expr);
      if (input.prompt !== undefined) patch.prompt = checkPrompt(input.prompt);
      if (input.enabled !== undefined) patch.enabled = requireBool(input.enabled, "enabled");
      if (Object.keys(patch).length === 0) throw new ServiceError("invalid", "give a new name, expr, prompt or enabled");
      return await mutex.run(CRON_MUTEX, () => {
        const row = requireCron(cronStore, input.id);
        const enabled = patch.enabled ?? row.enabled;
        const expr = patch.expr ?? row.expr;
        // The schedule restarts from now when the expression changed or the entry was switched on; otherwise it keeps its slot.
        const reschedule = enabled && (patch.expr !== undefined || !row.enabled || row.nextRunAt === null);
        const nextRunAt = !enabled ? null : reschedule ? scheduler.nextAfter(expr) : row.nextRunAt;
        const updated = cronStore.update(row.id, { ...patch, nextRunAt })!;
        scheduler.arm(row.id);
        log.info("cron.updated", { by: origin.by, cronId: row.id });
        publishCron();
        return cronStore.entry(updated);
      });
    },

    async deleteCron(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string; readonly name: string }> {
      return await mutex.run(CRON_MUTEX, () => {
        const row = requireCron(cronStore, input?.id);
        scheduler.disarm(row.id);
        cronStore.delete(row.id);
        log.info("cron.deleted", { by: origin.by, cronId: row.id });
        publishCron();
        return { id: row.id, name: row.name };
      });
    },

    async runCronNow(input: { readonly id: string }, origin: Origin): Promise<CronRunResult> {
      return await mutex.run(CRON_MUTEX, async () => {
        const row = requireCron(cronStore, input?.id);
        return await scheduler.runNow(row, origin.callId);
      });
    },

    async jevJudge(input: JevInput): Promise<JevVerdict> {
      const parsed = parseJevInput(input);
      try {
        const verdict = await jevJudge(parsed, deps.jev ?? {});
        log.info("jev.judged", { kind: parsed.kind, model: verdict.model });
        return verdict;
      } catch (err) {
        log.warn("jev.failed", { kind: parsed.kind, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },

    async layerQuery(input: LayerQueryInput): Promise<Json> {
      if (typeof input.name === "string" && isCoreRef(input.name)) {
        coreLayer(input.layer, input.name);
        const value = layerInput(input.input);
        return await runHandler(input.layer, input.name, () => runCoreQuery(service, input.name, value));
      }
      const handler = layerHandler(input.layer, input.name, "queries") as (i: Json, c: typeof ctx) => Promise<Json> | Json;
      const value = layerInput(input.input);
      return await runHandler(input.layer, input.name, () => handler(value, ctx));
    },

    async layerAction(input: LayerActionInput, origin: Origin): Promise<Json> {
      if (typeof input.name === "string" && isCoreRef(input.name)) {
        const loaded = coreLayer(input.layer, input.name);
        const value = layerInput(input.input);
        // `{ value }` from a text, number, toggle or select control becomes the capability's input through actionInput.
        const template = actionTemplate(loaded.manifest, input.name);
        const arg = template !== undefined && isRecord(value) && "value" in value ? applyValueTemplate(template, value.value as Json) : value;
        // No `layer:<name>` key: the capability takes its own keys (lock order, DESIGN 4.2).
        const out = await runHandler(input.layer, input.name, () => runCoreAction(service, input.name, arg, origin));
        bus.publish({ type: "layer.changed", layer: input.layer, by: origin.by });
        return out;
      }
      const handler = layerHandler(input.layer, input.name, "actions") as {
        run(i: Json, o: Origin, c: typeof ctx): Promise<Json>;
      };
      const value = layerInput(input.input);
      return await mutex.run(`layer:${input.layer}`, async () => {
        const out = await runHandler(input.layer, input.name, () => handler.run(value, origin, ctx));
        bus.publish({ type: "layer.changed", layer: input.layer, by: origin.by });
        return out;
      });
    },

    // --- P9: layer authoring (declarative layers, DESIGN 8) ------------------------------------------------------
    async createLayer(input: CreateLayerInput, origin: Origin): Promise<LayerInfo> {
      const name = requireLayerName(input?.name);
      const title = requireText(input?.title, "title", 80);
      const description = requireText(input?.description, "description", 1000, true);
      if (input.enabledByDefault !== undefined) requireBool(input.enabledByDefault, "enabledByDefault");
      if ((BUILTIN_LAYERS as readonly string[]).includes(name)) throw new ServiceError("conflict", `${name} is the name of a built-in layer`);
      const manifest = {
        name,
        kind: "harness",
        title,
        description,
        version: "0.1.0",
        origin: "local",
        enabledByDefault: input.enabledByDefault ?? true,
        env: [],
        vaultHosts: [],
        ui: { settingsPanels: [], widgets: [], hotkeys: [] },
        capabilities: [],
      };
      await mutex.run(LAYERS_MUTEX, async () => {
        await mkdir(paths.layersDir, { recursive: true });
        try {
          await mkdir(join(paths.layersDir, name));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ServiceError("conflict", `layer ${name} already exists`);
          throw err;
        }
        await atomicWrite(join(paths.layersDir, name, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        log.info("layer.created", { layer: name, by: origin.by });
        await reloadNow(origin.by);
      });
      await syncUiWithLayers(origin.by);
      return layerInfo(name);
    },

    async deleteLayer(input: { readonly name: string }, origin: Origin): Promise<DeleteLayerResult> {
      const name = requireLayerName(input?.name);
      await mutex.run(LAYERS_MUTEX, async () => {
        await requireEditable(paths, name);
        await deleteLayerFolder(paths, name);
        log.info("layer.deleted", { layer: name, by: origin.by });
        await reloadNow(origin.by);
      });
      // Settings and UI config follow the layer out, in lock order (settings, ui_config) and outside `layers`.
      await mutex.run(SETTINGS_MUTEX, () => {
        const stored = deps.db.settings.stored().layerToggles ?? {};
        if (name in stored) {
          const { [name]: _gone, ...rest } = stored;
          deps.db.settings.set("layerToggles", rest);
          publishSettings(["layersEnabled"], origin.by);
        }
      });
      await rm(layerStateFile(name), { force: true });
      const placementsRemoved = await syncUiWithLayers(origin.by);
      return { name, placementsRemoved };
    },

    async listLayerFiles(input: { readonly name: string }): Promise<LayerFileList> {
      return await listFiles(paths, input?.name);
    },

    async readLayerFile(input: LayerFileInput): Promise<LayerFileContent> {
      return await readFileOf(paths, input?.name, input?.path);
    },

    async writeLayerFile(input: WriteLayerFileInput, origin: Origin): Promise<WriteLayerFileResult> {
      const result = await mutex.run(LAYERS_MUTEX, async () => {
        // A manifest.json that does not validate is refused before it replaces a working one.
        if (input?.path === "manifest.json" && typeof input.content === "string") {
          try {
            parseJsonManifest(requireLayerName(input.name), input.content);
          } catch (err) {
            if (err instanceof ServiceError) throw err;
            throw new ServiceError("invalid", err instanceof Error ? err.message : String(err));
          }
        }
        const written = await writeFileOf(paths, input?.name, input?.path, input?.content);
        log.info("layer.file_written", { layer: written.name, path: written.path, size: written.size, by: origin.by });
        await reloadNow(origin.by);
        return written;
      });
      await syncUiWithLayers(origin.by);
      return { ...result, layer: layerInfo(result.name) };
    },

    async deleteLayerFile(input: LayerFileInput, origin: Origin): Promise<DeleteLayerFileResult> {
      const result = await mutex.run(LAYERS_MUTEX, async () => {
        const removed = await removeLayerFile(paths, input?.name, input?.path);
        log.info("layer.file_deleted", { layer: removed.name, path: removed.path, by: origin.by });
        await reloadNow(origin.by);
        return removed;
      });
      await syncUiWithLayers(origin.by);
      return { ...result, layer: layerInfo(result.name) };
    },

    async reloadLayers(origin: Origin): Promise<readonly LayerInfo[]> {
      await mutex.run(LAYERS_MUTEX, async () => {
        log.info("layer.reload", { by: origin.by });
        await reloadNow(origin.by);
      });
      await syncUiWithLayers(origin.by);
      return layers();
    },

    async exportLayer(input: ExportLayerInput, origin: Origin): Promise<ExportLayerResult> {
      const name = requireLayerName(input?.name);
      return await mutex.run(LAYERS_MUTEX, async () => {
        const folder = await findLayerFolder(paths, name);
        if (folder.source === "builtin") throw new ServiceError("forbidden", `layer ${name} is built in; only project layers can be exported`);
        let version = layers().find((l) => l.name === name)?.version;
        if (version === undefined) {
          const text = await readJsonManifestText(folder);
          try {
            const v = text === null ? undefined : (JSON.parse(text) as { version?: unknown }).version;
            if (typeof v === "string") version = v;
          } catch {
            // an unreadable manifest exports as 0.0.0
          }
        }
        const result = await exportLayerArchive(paths, folder, version ?? "0.0.0", input?.to);
        log.info("layer.exported", { layer: name, file: result.file, size: result.size, by: origin.by });
        return result;
      });
    },

    async importLayer(input: ImportLayerInput, origin: Origin): Promise<ImportLayerResult> {
      if (input?.replace !== undefined) requireBool(input.replace, "replace");
      const source = await loadImportSource(paths, input?.source);
      const plan = planImport(source, input?.name);
      if ((BUILTIN_LAYERS as readonly string[]).includes(plan.name)) throw new ServiceError("conflict", `${plan.name} is the name of a built-in layer`);
      const replaced = await mutex.run(LAYERS_MUTEX, async () => {
        const did = await installImport(paths, plan, input?.replace === true);
        log.info("layer.imported", { layer: plan.name, files: plan.files.length, replaced: did, by: origin.by });
        await reloadNow(origin.by);
        return did;
      });
      await syncUiWithLayers(origin.by);
      const layer = layerInfo(plan.name);
      return { name: plan.name, version: layer.version ?? "0.0.0", files: plan.files.map((f) => f.path), replaced, layer };
    },

    async rebuildWeb(): Promise<RebuildWebResult> {
      if (!deps.web) throw new ServiceError("conflict", "this factory serves no built web app (it runs with --dev or has no web source)");
      return await deps.web.rebuild();
    },

    async restart(input: RestartInput, origin: Origin): Promise<RestartResult> {
      const reason = input?.reason;
      if (reason !== undefined && (typeof reason !== "string" || reason.length > 200)) throw new ServiceError("invalid", "reason must be a string of at most 200 characters");
      const hook = deps.restart;
      if (!hook) throw new ServiceError("conflict", "this process cannot restart itself (it was not started with `tsf start`)");
      const delay = deps.restartDelayMs ?? RESTART_DELAY_MS;
      // A tool call that runs again after a crash must not restart again (a loop): the call id is stored before the exit.
      if (origin.callId !== undefined) {
        if (deps.db.settings.getRaw(RESTART_CALL_KEY) === JSON.stringify(origin.callId)) return { restartingInMs: 0, mode: hook.mode, alreadyRestarted: true };
        deps.db.settings.setRaw(RESTART_CALL_KEY, JSON.stringify(origin.callId));
      }
      if (!restartTimer) {
        log.info("restart.requested", { by: origin.by, reason, inMs: delay });
        bus.publish({ type: "factory.restarting", inMs: delay, ...(reason !== undefined ? { reason } : {}), by: origin.by });
        restartTimer = setTimeout(() => hook.begin(reason), delay);
      }
      return { restartingInMs: delay, mode: hook.mode };
    },

    async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
      if (!deps.web?.serving() && !process.env.TSF_VITE_URL) {
        throw new ServiceError("conflict", "the web app is not being served by this factory, so there is nothing to screenshot");
      }
      return await takeScreenshot(input ?? {}, {
        baseUrl: loopbackUrl(deps.url()),
        dir: join(paths.dataDir, "screenshots"),
        ...(deps.playwright ? { playwright: deps.playwright } : {}),
      });
    },

    async readScreenshot(input: { readonly file: string }): Promise<{ readonly file: string; readonly bytes: Uint8Array }> {
      return await readScreenshotFile(join(paths.dataDir, "screenshots"), input?.file);
    },

    async readExportFile(input: { readonly file: string }): Promise<{ readonly file: string; readonly bytes: Uint8Array }> {
      return await readExportArchive(paths, input?.file);
    },

    async defineWidget(input: DefineWidgetInput, origin: Origin): Promise<DefineWidgetResult> {
      const name = requireLayerName(input?.layer);
      if (typeof input.widget !== "object" || input.widget === null || Array.isArray(input.widget)) {
        throw new ServiceError("invalid", "widget must be a widget contribution object { id, title, description, navbars, defaultOptions, control }");
      }
      const widget = input.widget;
      const created = await editManifestJson(name, origin, (raw) => {
        const ui = isRecord(raw.ui) ? raw.ui : {};
        const widgets = Array.isArray(ui.widgets) ? [...(ui.widgets as unknown[])] : [];
        const at = widgets.findIndex((w) => isRecord(w) && w.id === widget.id);
        if (at >= 0) widgets[at] = widget;
        else widgets.push(widget);
        raw.ui = { ...ui, widgets };
        return at < 0;
      });
      await syncUiWithLayers(origin.by);
      return { layer: name, widget: widget as WidgetContribution, created, info: layerInfo(name) };
    },

    async removeWidgetType(input: UndefineWidgetInput, origin: Origin): Promise<UndefineWidgetResult> {
      const name = requireLayerName(input?.layer);
      const id = requireString(input?.id, "id");
      await editManifestJson(name, origin, (raw) => {
        const ui = isRecord(raw.ui) ? raw.ui : {};
        const widgets = Array.isArray(ui.widgets) ? (ui.widgets as unknown[]) : [];
        if (!widgets.some((w) => isRecord(w) && w.id === id)) {
          throw new ServiceError("not_found", `layer ${name} defines no widget ${id}; list_widgets shows the widget types`);
        }
        raw.ui = { ...ui, widgets: widgets.filter((w) => !(isRecord(w) && w.id === id)) };
        return true;
      });
      const placementsRemoved = await syncUiWithLayers(origin.by);
      return { layer: name, id, placementsRemoved };
    },
  };

  return {
    service,
    async start() {
      await scheduler.start();
    },
    async close() {
      if (restartTimer) clearTimeout(restartTimer);
      // Cron (P6) stops first; then the page watcher and the recorder.
      scheduler.close();
      unsubscribeCatalog();
      store.close();
      recorder.stop();
    },
  };
}
