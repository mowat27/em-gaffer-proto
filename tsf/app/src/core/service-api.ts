/**
 * The Service contract: the one object both HTTP routes and agent tools call (principle 2, parity).
 * core/service.ts implements it. Types only.
 *
 * Rules every implementation follows:
 * - Reads are synchronous where the state is cached in memory (snapshot, chat view, tree, settings) so the SSE
 *   snapshot is consistent with the delta id it is stamped with.
 * - Every mutating method takes an Origin, validates its input, serialises on the resource's mutex, commits, then
 *   publishes exactly one AppEvent (shared/events.ts) per changed resource, after the commit.
 * - Failures throw ServiceError (core/errors.ts) with a code that maps to the HTTP status and to a tool error result.
 *
 * P1-P3 methods are declared here. Planned P4-P8 methods are listed in DESIGN.md (Service) and are added to this
 * interface in their phase; each planned method gets an agent tool in the same phase (no method is UI-only).
 * The chat methods (chatView, loadEarlier, sendMessage, stopRun) and status/snapshot/getSettings are infrastructure:
 * routes only, in shared/capabilities.ts INFRA_ROUTES (DESIGN 10).
 */
import type {
  CeilingInfo,
  CompactionPoints,
  CronEntry,
  CompactResult,
  ContextInfo,
  HotkeyAction,
  JevInput,
  JevVerdict,
  Json,
  ModeValues,
  ModelSelection,
  NavbarId,
  NavbarSlot,
  ThemeCheck,
  ThemeInfo,
  WidgetOptions,
  WidgetPlacement,
  ChatItem,
  ChatView,
  FactoryStatus,
  FolderNode,
  ModelInfo,
  Origin,
  PromptInfo,
  PromptList,
  RefreshModelsResult,
  ThinkingLevel,
  ToolDescription,
  ModelRef,
  Page,
  PageEdit,
  PagePath,
  PageTree,
  RunDetail,
  RunSummary,
  Selection,
  Settings,
  Snapshot,
  ToolInfo,
  LayerInfo,
  UiConfig,
  UiConfigPatch,
  CreateLayerInput,
  ExportLayerInput,
  RebuildWebResult,
  RestartInput,
  RestartResult,
  ScreenshotInput,
  ScreenshotResult,
  ExportLayerResult,
  ImportLayerInput,
  ImportLayerResult,
  DefineWidgetInput,
  DefineWidgetResult,
  DeleteLayerFileResult,
  DeleteLayerResult,
  LayerFileContent,
  LayerFileInput,
  LayerFileList,
  UndefineWidgetInput,
  UndefineWidgetResult,
  WriteLayerFileInput,
  WriteLayerFileResult,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------------------------------------------
// Inputs and results

export interface SendMessageInput {
  readonly text: string;
  /** Client-generated id (UUID). Namespaced "chat:<requestId>" for pi-durable; a retry with the same id never submits twice. */
  readonly requestId: string;
  /** pi-durable whenBusy; default "followUp". */
  readonly mode?: "followUp" | "steer";
}

export interface SendResult {
  readonly submissionId: number;
  readonly requestId: string;
  /** From Submission.status(): the POST never waits for the answer (spec 7.1). */
  readonly status: "queued" | "placed" | "done" | "unanswered";
}

export interface EarlierInput {
  /** Load entries with id < before. pi-durable's EntryId is a branded number with no exported constructor, so the
   * feed passes `(before - 1) as EntryId` as `maxEntryId`. */
  readonly before: number;
  /** Default 50, max 200. */
  readonly limit?: number;
}

export interface EarlierPage {
  readonly items: readonly ChatItem[];
  readonly hasEarlier: boolean;
}

export interface CreatePageInput {
  readonly path: PagePath;
  /** Default: "# <name>\n". */
  readonly content?: string;
}

/** Exactly one of `content` and `edits`. */
export interface UpdatePageInput {
  readonly path: PagePath;
  readonly content?: string;
  /** Applied in order; each oldText must match exactly once. */
  readonly edits?: readonly PageEdit[];
  /** Page.version the caller edited; a mismatch is a conflict. */
  readonly baseVersion?: string;
}

export interface MovePageInput {
  /** A page or a folder. */
  readonly from: PagePath;
  /** The new path; for a page it ends in ".md". Parent folders are created. Fails if `to` exists. */
  readonly to: PagePath;
}

export interface MoveResult {
  readonly from: PagePath;
  readonly to: PagePath;
  readonly kind: "page" | "folder";
  /** Every page path that changed, old to new. The selection follows a moved page. */
  readonly moved: readonly { readonly from: PagePath; readonly to: PagePath }[];
}

export interface DeletePageInput {
  readonly path: PagePath;
  /** Required to delete a non-empty folder. */
  readonly recursive?: boolean;
}

export interface DeleteResult {
  readonly path: PagePath;
  readonly kind: "page" | "folder";
  readonly removed: readonly PagePath[];
}

export interface UpdateUiConfigInput {
  readonly patch: UiConfigPatch;
  /** UiConfig.version the caller saw; omitted means last writer wins (pane drags). */
  readonly baseVersion?: number;
}

export interface RunListInput {
  /** Default 20, max 200. */
  readonly limit?: number;
  /** Runs with id < before. */
  readonly before?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// P4: widgets, hotkeys, themes, panels, layer handlers

/** A widget type that can be placed: a built-in or a layer contribution. */
export interface WidgetType {
  /** "context_bar" or "<layer>.<widget>". */
  readonly widget: string;
  readonly title: string;
  readonly description: string;
  readonly navbars: readonly NavbarId[];
  /** The contributing layer; null for a built-in. */
  readonly layer: string | null;
  readonly defaultOptions: WidgetOptions;
}

/** A widget placed in a navbar (the UI config's placement plus the navbar it sits in). */
export interface PlacedWidget extends WidgetPlacement {
  readonly navbar: NavbarId;
}

export interface WidgetList {
  readonly available: readonly WidgetType[];
  /** Both navbars, global first, in array order. */
  readonly placements: readonly PlacedWidget[];
}

export interface AddWidgetInput {
  readonly navbar: NavbarId;
  readonly widget: string;
  readonly slot: NavbarSlot;
  /** Position in the navbar's item list; default: the end. */
  readonly index?: number;
  readonly options?: WidgetOptions;
}

export interface MoveWidgetInput {
  readonly id: string;
  /** Default: the navbar the widget is in. */
  readonly navbar?: NavbarId;
  /** Default: the widget's slot. */
  readonly slot?: NavbarSlot;
  /** Position in the target navbar's item list after the widget is taken out of its old place. */
  readonly index: number;
}

export interface SetWidgetOptionsInput {
  readonly id: string;
  /** Merged into the widget's options; a `null` value deletes that option. */
  readonly options: { readonly [option: string]: Json };
}

export interface HotkeyInfo {
  /** A built-in HotkeyAction or "<layer>.<action>". */
  readonly action: HotkeyAction | string;
  readonly title: string;
  /** The bound key; null when a layer action has none. */
  readonly key: string | null;
  readonly defaultKey: string | null;
  /** The contributing layer; null for a built-in. */
  readonly layer: string | null;
}

export interface SetHotkeyInput {
  readonly action: string;
  /** One key ("s", "[", "F2") or "mod+key". */
  readonly key: string;
}

export interface CreateThemeInput {
  /** Lowercase letters, digits and hyphens, starting with a letter. Must not be a PW theme name. */
  readonly name: string;
  readonly title?: string;
  /** A PW theme name. */
  readonly base: string;
  readonly seeds?: { readonly [seed: string]: ModeValues<string> | string };
  readonly tokens?: { readonly [token: string]: ModeValues | string | number };
}

export interface SetThemeValuesInput {
  readonly name: string;
  readonly title?: string;
  /** Merged over the stored seeds; a `null` value deletes a seed. */
  readonly seeds?: { readonly [seed: string]: ModeValues<string> | string | null };
  /** Merged over the stored tokens; a `null` value deletes a token override. */
  readonly tokens?: { readonly [token: string]: ModeValues | string | number | null };
}

/** What a theme command returns: the theme as listed, whether it is the active one, and its contrast check. */
export interface ThemeResult {
  readonly theme: ThemeInfo;
  readonly active: boolean;
  readonly check: ThemeCheck;
}

export interface FixThemeResult extends ThemeResult {
  /** The fixes that were written as token overrides. */
  readonly applied: ThemeCheck["fixes"];
}

export interface DeleteThemeResult {
  readonly name: string;
  /** The theme that is active afterwards (Neon when the deleted one was active). */
  readonly active: string;
}

export interface OpenPanelInput {
  readonly target: "settings" | "cron";
  /** A section of the target ("essentials", "core4", "advanced"). */
  readonly section?: string;
}

export interface LayerQueryInput {
  readonly layer: string;
  readonly name: string;
  readonly input?: Json;
}

export interface LayerActionInput {
  readonly layer: string;
  readonly name: string;
  readonly input?: Json;
}

// ---------------------------------------------------------------------------------------------------------------
// P5: Core 4

export interface CompactInput {
  /** Extra instructions for the summary (at most 2 000 characters). */
  readonly instructions?: string;
}

export interface CreateCustomPromptInput {
  readonly name: string;
  readonly text: string;
  /** Default true. */
  readonly enabled?: boolean;
}

export interface UpdateCustomPromptInput {
  readonly id: string;
  readonly name?: string;
  readonly text?: string;
}

export interface DescribeToolInput {
  readonly name: string;
  /** Default: both representations. */
  readonly syntax?: "json" | "typescript";
}

// ---------------------------------------------------------------------------------------------------------------
// P6: cron

export interface CreateCronInput {
  /** 1..64 characters, unique. */
  readonly name: string;
  /** croner expression with 5 fields (minute first) or 6 (seconds first), in the server's time zone. */
  readonly expr: string;
  readonly prompt: string;
  /** Default true. */
  readonly enabled?: boolean;
}

export interface UpdateCronInput {
  readonly id: string;
  readonly name?: string;
  readonly expr?: string;
  readonly prompt?: string;
  readonly enabled?: boolean;
}

/** What `runCronNow` returns: the run it admitted. `slot` is the time it was asked for (a manual run has no schedule). */
export interface CronRunResult {
  readonly cronId: string;
  readonly name: string;
  readonly slot: number;
  readonly submissionId: number;
  readonly status: NonNullable<CronEntry["lastStatus"]>;
  readonly manual: boolean;
  readonly catchUp: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// The Service

export interface FactoryService {
  // --- P1: status, snapshot, chat, models (read) -------------------------------------------------------------
  /** GET /api/status. */
  status(): FactoryStatus;
  /** The SSE snapshot; synchronous so it matches the hub's head id. */
  snapshot(): Snapshot;
  /** GET /api/chat. */
  chatView(): ChatView;
  /** GET /api/chat/earlier. Pages Conversation.entries() below the view. */
  loadEarlier(input: EarlierInput): Promise<EarlierPage>;
  /** POST /api/chat/send. Conversation.submit({ type: "input", ... }); returns once admitted. */
  sendMessage(input: SendMessageInput, origin: Origin): Promise<SendResult>;
  /** POST /api/chat/stop. Conversation.abort(): withdraws queued inputs and stops the run. */
  stopRun(origin: Origin): Promise<{ readonly stopped: boolean }>;
  /** GET /api/models: the active provider's models (faux, or the enabled provider layers). */
  listModels(): readonly ModelInfo[];
  /** get_settings, GET /api/settings: the Settings document (no secret values: environment variables are never in Settings). */
  getSettings(): Settings;

  // --- P2: layers, tools, ceiling, runs (read) ---------------------------------------------------------------
  /** GET /api/layers. Load order. */
  listLayers(): readonly LayerInfo[];
  /** GET /api/tools. Only tools inside the ceiling. */
  listTools(): readonly ToolInfo[];
  /** GET /api/ceiling. Read-only: no method writes permissions.json. */
  getCeiling(): CeilingInfo;
  /** GET /api/runs. Newest first. */
  listRuns(input: RunListInput): readonly RunSummary[];
  /** GET /api/runs/:id. */
  getRun(id: number): RunDetail;

  // --- P2: pages (tools in page_harness) ---------------------------------------------------------------------
  /** list_pages, GET /api/pages. */
  listPages(): PageTree;
  /** read_page, GET /api/pages/read?path= */
  readPage(input: { readonly path: PagePath }): Promise<Page>;
  /** create_page, POST /api/pages/create. Fails with conflict if the path exists. */
  createPage(input: CreatePageInput, origin: Origin): Promise<Page>;
  /** update_page, POST /api/pages/update. */
  updatePage(input: UpdatePageInput, origin: Origin): Promise<Page>;
  /** move_page, POST /api/pages/move. */
  movePage(input: MovePageInput, origin: Origin): Promise<MoveResult>;
  /** delete_page, POST /api/pages/delete. Clears the selection when it pointed inside. */
  deletePage(input: DeletePageInput, origin: Origin): Promise<DeleteResult>;
  /** create_folder, POST /api/pages/create-folder. Idempotent: an existing folder is returned. */
  createFolder(input: { readonly path: PagePath }, origin: Origin): Promise<FolderNode>;
  /** select_page, POST /api/pages/select. The centre view follows (selection.changed). */
  selectPage(input: { readonly path: PagePath }, origin: Origin): Promise<Selection>;
  /** unselect_page, POST /api/pages/unselect. */
  unselectPage(origin: Origin): Promise<Selection>;
  /** Snapshot field. */
  getSelection(): Selection;

  // --- P3: UI config (agent tools for it arrive in P4) -------------------------------------------------------
  /** GET /api/ui-config. */
  getUiConfig(): UiConfig;
  /** POST /api/ui-config/update. JSON Merge Patch, schema-validated, version + 1, ui_config.changed. */
  updateUiConfig(input: UpdateUiConfigInput, origin: Origin): Promise<UiConfig>;
  /**
   * The active theme's full CSS (Snapshot.themeCss), cached in memory. server/static.ts inlines it into index.html as
   * <style id="tsf-theme"> so the first paint is themed. P1-P2: Neon + glass read from the @pw/ui package files.
   */
  getThemeCss(): string;

  // --- P4: widgets (tools in factory_controls) -------------------------------------------------------------------
  /** list_widgets, GET /api/widgets. */
  listWidgets(): WidgetList;
  /** add_widget, POST /api/widgets/add. The id is generated ("<widget>-<n>"; from the call id for the agent). */
  addWidget(input: AddWidgetInput, origin: Origin): Promise<PlacedWidget>;
  /** remove_widget, POST /api/widgets/remove. */
  removeWidget(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string; readonly navbar: NavbarId }>;
  /** move_widget, POST /api/widgets/move. */
  moveWidget(input: MoveWidgetInput, origin: Origin): Promise<PlacedWidget>;
  /** set_widget_options, POST /api/widgets/options. */
  setWidgetOptions(input: SetWidgetOptionsInput, origin: Origin): Promise<PlacedWidget>;

  // --- P4: hotkeys ---------------------------------------------------------------------------------------------
  /** list_hotkeys, GET /api/hotkeys. */
  listHotkeys(): readonly HotkeyInfo[];
  /** set_hotkey, POST /api/hotkeys/set. A key already bound to another action is `invalid`. */
  setHotkey(input: SetHotkeyInput, origin: Origin): Promise<HotkeyInfo>;

  // --- P4: themes ----------------------------------------------------------------------------------------------
  /** list_themes, GET /api/themes. PW themes, then custom themes. The active one is `getUiConfig().theme.name`. */
  listThemes(): readonly ThemeInfo[];
  /** set_theme, POST /api/themes/set. Writes ui_config.theme and publishes theme.applied with the full CSS. */
  setTheme(input: { readonly name: string; readonly mode?: "light" | "dark" | "system" }, origin: Origin): Promise<ThemeResult>;
  /** create_theme, POST /api/themes/create. The new theme becomes the active one. */
  createTheme(input: CreateThemeInput, origin: Origin): Promise<ThemeResult>;
  /** set_theme_values, POST /api/themes/values. Custom themes only; applies live when the theme is active. */
  setThemeValues(input: SetThemeValuesInput, origin: Origin): Promise<ThemeResult>;
  /** check_theme, POST /api/themes/check. pw-ui contrast() and fixes(); warnings never block a change. */
  checkTheme(input: { readonly name: string }): ThemeCheck;
  /** fix_theme, POST /api/themes/fix. Writes pw-ui's fixes into a custom theme as token overrides. */
  fixTheme(input: { readonly name: string }, origin: Origin): Promise<FixThemeResult>;
  /** delete_theme, POST /api/themes/delete. Custom themes only; deleting the active one falls back to Neon. */
  deleteTheme(input: { readonly name: string }, origin: Origin): Promise<DeleteThemeResult>;

  // --- P4: panels and layer handlers ---------------------------------------------------------------------------
  /** open_panel, POST /api/ui/open. Publishes ui.open; every open page opens the modal. */
  openPanel(input: OpenPanelInput, origin: Origin): Promise<OpenPanelInput>;
  // --- P5: context and compaction ----------------------------------------------------------------------------
  /** get_context, GET /api/context. The context bar's readings: tokens, window, stored points, effective thresholds. */
  getContext(): ContextInfo;
  /**
   * set_compaction, POST /api/compaction/set. Merges the given points over the stored ones (absolute token counts).
   * Stored as given; both thresholds are clamped to the current model's window at read time (D3). Applies from the
   * next request (the Harness reads its policy at every use).
   */
  setCompaction(points: Partial<CompactionPoints>, origin: Origin): Promise<ContextInfo>;
  /** compact, POST /api/compact. Admits a manual compaction; it summarises while the agent keeps working. */
  compact(input: CompactInput, origin: Origin): Promise<CompactResult>;

  // --- P5: model and thinking ----------------------------------------------------------------------------------
  /** refresh_models, POST /api/models/refresh. Refetches the enabled provider layers' live lists; publishes models.changed. */
  refreshModels(origin: Origin): Promise<RefreshModelsResult>;
  /** set_model, POST /api/model/set. `conversation.configure({ model })`; the model must be in the catalog. */
  setModel(ref: ModelRef, origin: Origin): Promise<ModelSelection>;
  /** set_thinking_level, POST /api/thinking/set. Stored as given; the model gets it clamped to what it supports. */
  setThinkingLevel(level: ThinkingLevel, origin: Origin): Promise<ModelSelection>;

  // --- P5: prompts (four layers) -------------------------------------------------------------------------------
  /** list_prompts, GET /api/prompts. */
  listPrompts(): Promise<PromptList>;
  /** get_prompt, GET /api/prompts/get?id=. An extension section is rendered. */
  getPrompt(input: { readonly id: string }): Promise<PromptInfo>;
  /** set_system_prompt, POST /api/prompts/system. `text: null` restores the shipped default. */
  setSystemPrompt(input: { readonly text: string | null }, origin: Origin): Promise<PromptInfo>;
  /** create_custom_prompt, POST /api/prompts/custom/create. Names are unique; an agent call's id keys the row. */
  createCustomPrompt(input: CreateCustomPromptInput, origin: Origin): Promise<PromptInfo>;
  /** update_custom_prompt, POST /api/prompts/custom/update. */
  updateCustomPrompt(input: UpdateCustomPromptInput, origin: Origin): Promise<PromptInfo>;
  /** delete_custom_prompt, POST /api/prompts/custom/delete. */
  deleteCustomPrompt(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string }>;
  /** toggle_prompt, POST /api/prompts/toggle. A custom prompt (`custom:<id>`) or an extension section (`section:<key>`). */
  togglePrompt(input: { readonly id: string; readonly enabled: boolean }, origin: Origin): Promise<PromptInfo>;
  /** append_runtime_prompt, POST /api/prompts/runtime/append. Joins `configure({ instructions })`; next request. */
  appendRuntimePrompt(input: { readonly text: string }, origin: Origin): Promise<PromptInfo>;
  /** remove_runtime_prompt, POST /api/prompts/runtime/remove. */
  removeRuntimePrompt(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string }>;
  /** clear_runtime_prompts, POST /api/prompts/runtime/clear. */
  clearRuntimePrompts(origin: Origin): Promise<{ readonly removed: number }>;

  // --- P5: tools and layers ------------------------------------------------------------------------------------
  /** describe_tool, GET /api/tools/describe?name=&syntax=. Description, JSON Schema and TypeScript signature. */
  describeTool(input: DescribeToolInput): ToolDescription;
  /**
   * set_tool_enabled, POST /api/tools/set-enabled. Applied with `configure({ tools })`, no restart. A tool outside the
   * permissions ceiling is `forbidden` either way.
   */
  setToolEnabled(input: { readonly name: string; readonly enabled: boolean }, origin: Origin): Promise<ToolInfo>;
  /** set_layer_enabled, POST /api/layers/set-enabled. Required layers cannot be disabled (`forbidden`). */
  setLayerEnabled(input: { readonly name: string; readonly enabled: boolean }, origin: Origin): Promise<LayerInfo>;

  // --- P6: cron --------------------------------------------------------------------------------------------------
  /** list_crons, GET /api/cron. Oldest first, with next and last run and the last run's status. */
  listCrons(): readonly CronEntry[];
  /** create_cron, POST /api/cron/create. Names are unique; an agent call's id keys the row (a replay finds it). */
  createCron(input: CreateCronInput, origin: Origin): Promise<CronEntry>;
  /** update_cron, POST /api/cron/update. A changed expression or an enable recomputes `nextRunAt` from now. */
  updateCron(input: UpdateCronInput, origin: Origin): Promise<CronEntry>;
  /** delete_cron, POST /api/cron/delete. Removes the entry and its run rows; chat items already placed stay. */
  deleteCron(input: { readonly id: string }, origin: Origin): Promise<{ readonly id: string; readonly name: string }>;
  /** run_cron_now, POST /api/cron/run-now. Submits the prompt now (queued behind a running turn); the schedule is untouched. */
  runCronNow(input: { readonly id: string }, origin: Origin): Promise<CronRunResult>;

  // --- P7: jev ---------------------------------------------------------------------------------------------------
  /**
   * jev_judge, POST /api/jev/judge. One System One question (noul, choice or score) over TypeSafe's api.typesafe.ai.
   * `invalid` for a bad input, `unavailable` without TYPESAFE_API_KEY, `upstream` (502) for a non-2xx answer.
   */
  jevJudge(input: JevInput): Promise<JevVerdict>;

  // --- P9: layer authoring (DESIGN 8, "Declarative layers"). All folder changes take the `layers` mutex and end with a
  // reload, so the change is live (events: layers.changed, tools.changed, and prompts.changed / settings.changed
  // when the set of layers or sections changed). Only project layers are written; built-ins are read-only.
  /** create_layer, POST /api/layers/create. Writes `tsf/layers/<name>/manifest.json` (empty ui, no capabilities) and reloads. */
  createLayer(input: CreateLayerInput, origin: Origin): Promise<LayerInfo>;
  /** delete_layer, POST /api/layers/delete. Project layers only (`forbidden` for a built-in); also drops its layerToggles entry and its widget placements. */
  deleteLayer(input: { readonly name: string }, origin: Origin): Promise<DeleteLayerResult>;
  /** list_layer_files, GET /api/layers/files?name=. Any layer, built-in ones read-only. */
  listLayerFiles(input: { readonly name: string }): Promise<LayerFileList>;
  /** read_layer_file, GET /api/layers/read-file?name=&path=. */
  readLayerFile(input: LayerFileInput): Promise<LayerFileContent>;
  /** write_layer_file, POST /api/layers/write-file. Confined to the folder; .json .ts .md, 256 KiB; a manifest.json that does not validate is refused. */
  writeLayerFile(input: WriteLayerFileInput, origin: Origin): Promise<WriteLayerFileResult>;
  /** delete_layer_file, POST /api/layers/delete-file. Not the manifest (use deleteLayer). */
  deleteLayerFile(input: LayerFileInput, origin: Origin): Promise<DeleteLayerFileResult>;
  /** reload_layers, POST /api/layers/reload. Rescans `tsf/layers/*` and answers the LayerInfo list with statuses. */
  reloadLayers(origin: Origin): Promise<readonly LayerInfo[]>;
  /** define_widget, POST /api/widgets/define. Upserts a widget type in a manifest.json layer's ui.widgets. */
  defineWidget(input: DefineWidgetInput, origin: Origin): Promise<DefineWidgetResult>;
  /** undefine_widget, POST /api/widgets/undefine. Removes the widget type and its placements. */
  removeWidgetType(input: UndefineWidgetInput, origin: Origin): Promise<UndefineWidgetResult>;

  /**
   * export_layer, POST /api/layers/export. Archives a project layer's folder (.json .ts .md files) as
   * `tsf/data/exports/<name>-<version>.tgz` (or `to`, a file name there). Built-in layers: `forbidden`.
   */
  exportLayer(input: ExportLayerInput, origin: Origin): Promise<ExportLayerResult>;
  /**
   * import_layer, POST /api/layers/import. Installs a layer from a local .tgz or folder or an https .tgz URL into
   * `tsf/layers/<name>`: validated like a reload, path traversal refused, an existing layer kept unless `replace`.
   * Answers with the reloaded layer (status "failed" and the reason when, for example, `requires` is unmet).
   */
  importLayer(input: ImportLayerInput, origin: Origin): Promise<ImportLayerResult>;
  /** GET /api/layers/export-file?file= (an infrastructure route, not a capability): the bytes of an archive in `tsf/data/exports`. */
  readExportFile(input: { readonly file: string }): Promise<{ readonly file: string; readonly bytes: Uint8Array }>;

  /** rebuild_web, POST /api/factory/rebuild-web. Builds the web app from the sources now; the old build keeps serving when it fails. */
  rebuildWeb(): Promise<RebuildWebResult>;
  /**
   * restart_factory, POST /api/factory/restart. Answers at once; about 1.5 s later the DESIGN 3 shutdown runs and the
   * process restarts (exit 3 under systemd, else a detached replacement). `conflict` when this process cannot restart.
   */
  restart(input: RestartInput, origin: Origin): Promise<RestartResult>;
  /** screenshot, POST /api/factory/screenshot. Headless Chromium (playwright) captures the factory's own page into `tsf/data/screenshots`. */
  screenshot(input: ScreenshotInput): Promise<ScreenshotResult>;
  /** GET /api/screenshots/:file (an infrastructure route): the bytes of a PNG in `tsf/data/screenshots`. */
  readScreenshot(input: { readonly file: string }): Promise<{ readonly file: string; readonly bytes: Uint8Array }>;

  /** GET /api/layers/:layer/query/:name?input=<url-encoded JSON>. The layer must be loaded and enabled. `name` may be `core:<capabilityId>` (declared in the layer's manifest). */
  layerQuery(input: LayerQueryInput): Promise<Json>;
  /** POST /api/layers/:layer/action/:name { input }. Serialised on `layer:<name>`, then publishes layer.changed. */
  layerAction(input: LayerActionInput, origin: Origin): Promise<Json>;
}

/** The Service method names; shared/capabilities.ts types its `service` column with this. */
export type ServiceMethod = keyof FactoryService;
