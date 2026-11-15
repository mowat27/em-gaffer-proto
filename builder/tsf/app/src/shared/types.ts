/**
 * The contract between the server, the layers and the web app. Read this first (DESIGN.md).
 * Types and constants only: no runtime logic, no node or pi-durable imports, so the browser can import it.
 * Shapes that mirror pi-durable or pi-ai types are restated here as plain JSON so the web never imports those packages.
 *
 * Name clashes: pi-ai also exports ThinkingLevel (without "off") and THINKING_LEVELS (without "off"), and pi-durable
 * exports Page, Settings and RunSummary with other shapes. A server file that needs both imports the library types
 * under a namespace (`import type * as pd from "@earendil-works/pi-durable"`, `import type * as ai from
 * "@earendil-works/pi-ai"`), never by bare name (DESIGN 7).
 */
import type { AppEvent } from "./events.ts";

export const API_VERSION = 1 as const;

/** Plain JSON. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// Who did it

/** The source of a change, recorded on events and runs. */
export type Actor = "ui" | "agent" | "cron" | "system";

/** Passed to every mutating Service method. `callId` is the model's tool call id when `by === "agent"`. */
export interface Origin {
  readonly by: Actor;
  readonly callId?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Models (mirrors pi-durable ModelRef and pi-ai ModelThinkingLevel / Model)

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/** pi-ai MODEL_THINKING_LEVELS / ModelThinkingLevel, in order (not pi-ai's ThinkingLevel, which has no "off"). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  /** pi-ai getSupportedThinkingLevels(model). */
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly input: readonly ("text" | "image")[];
  /** Dollars per 1M tokens (pi-ai ModelCost). */
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  /** "live": OpenRouter /models fetch (or its cache); "snapshot": pi-ai's shipped catalog; "faux": the test provider. */
  readonly source: "live" | "snapshot" | "faux";
}

// ---------------------------------------------------------------------------------------------------------------
// Pages (markdown files under <project>/tsf/pages)

/** POSIX path relative to tsf/pages. A page ends in ".md"; a folder does not. The root folder is "". */
export type PagePath = string;

export interface PageNode {
  readonly kind: "page";
  readonly path: PagePath;
  /** File name without ".md". */
  readonly name: string;
  /** First "# " heading, else `name`. */
  readonly title: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface FolderNode {
  readonly kind: "folder";
  readonly path: PagePath;
  readonly name: string;
  /** Folders first, then pages, each sorted by name (locale compare, numeric). */
  readonly children: readonly TreeNode[];
}

export type TreeNode = PageNode | FolderNode;

/** The root folder, path "". */
export type PageTree = FolderNode;

export interface Page {
  readonly path: PagePath;
  readonly title: string;
  readonly content: string;
  /** First 12 hex chars of sha256(content): the optimistic-concurrency token for update_page. */
  readonly version: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface PageEdit {
  readonly oldText: string;
  readonly newText: string;
}

/** The page the centre pane shows. Shared by the UI and the agent (select_page / unselect_page). */
export interface Selection {
  readonly path: PagePath | null;
  readonly by: Actor;
  readonly at: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings (tsf.sqlite `settings`, one row per key)

/** The user-facing compaction numbers: absolute token counts (D3). */
export interface CompactionPoints {
  readonly enabled: boolean;
  /** Background compaction starts at this many context tokens. */
  readonly background: number;
  /** The next request waits for a summary at this many context tokens. */
  readonly forced: number;
  /** pi-durable keepRecentTokens. */
  readonly keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_POINTS: CompactionPoints = {
  enabled: true,
  background: 200_000,
  forced: 500_000,
  keepRecentTokens: 20_000,
};

/** The points mapped onto the current model's window (agent/compaction.ts toPolicy). */
export interface EffectiveCompaction {
  readonly window: number;
  readonly enabled: boolean;
  /** Effective absolute thresholds after clamping to the window. */
  readonly background: number | null;
  readonly forced: number;
  /** What pi-durable receives. */
  readonly reserveTokens: number;
  readonly backgroundTokens: number;
  /** True when the stored points did not fit the window and were clamped. */
  readonly clamped: boolean;
}

export interface Settings {
  readonly factoryName: string;
  /**
   * Enabled layer names, in load order. Derived, never stored whole: each loaded layer's `enabledByDefault`,
   * overridden by the stored non-config key `layerToggles` ({ [layer]: boolean }); required layers are always in it.
   * So a new layer folder is picked up with its default on restart (DESIGN 4.2).
   */
  readonly layersEnabled: readonly string[];
  /** Tool names switched off by the UI or the agent (inside the ceiling only). */
  readonly toolsDisabled: readonly string[];
  /** Null: the first model of the active provider. */
  readonly model: ModelRef | null;
  /** The favourite models, in order: the first three are the 1, 2 and 3 hotkeys of the model_controls layer. */
  readonly favouriteModels: readonly ModelRef[];
  readonly thinkingLevel: ThinkingLevel;
  readonly compaction: CompactionPoints;
  /** Prompt layer 1 override; null uses factory_harness/system-prompt.md. */
  readonly systemPrompt: string | null;
  /** pi-durable maxTurns per run; null for no limit. */
  readonly maxTurns: number | null;
}

export type SettingKey = keyof Settings;

// ---------------------------------------------------------------------------------------------------------------
// UI config (one document, validated by shared/ui-config-schema.ts)

export type BuiltinWidget = "context_bar" | "agent_status" | "factory_name" | "cron_status";
export const BUILTIN_WIDGETS: readonly BuiltinWidget[] = ["context_bar", "agent_status", "factory_name", "cron_status"];

export type NavbarId = "global" | "agent";
export type NavbarSlot = "left" | "center" | "right";

export interface WidgetOptions {
  readonly fullWidth?: boolean;
  readonly [option: string]: Json | undefined;
}

export interface WidgetPlacement {
  /** Instance id, unique across both navbars (e.g. "context_bar-1"). */
  readonly id: string;
  /** Widget type: a built-in or a layer contribution id ("<layer>.<widget>"). */
  readonly widget: string;
  readonly slot: NavbarSlot;
  readonly options: WidgetOptions;
}

export interface NavbarConfig {
  readonly visible: boolean;
  /** Render order within each slot follows array order. */
  readonly items: readonly WidgetPlacement[];
}

export interface PaneState {
  readonly visible: boolean;
  /** Pixels, snapped to 4. */
  readonly width: number;
}

/** Hotkey actions. Values are single keys or "mod+key" chords; ignored while focus is in a text input. */
export type HotkeyAction =
  | "settings.open"
  | "cron.open"
  | "panes.left.toggle"
  | "panes.right.toggle"
  | "agent.focus"
  | "agent.maximise";

export interface UiConfig {
  /** Incremented by every write; clients drop older documents. */
  readonly version: number;
  readonly panes: {
    readonly left: PaneState;
    readonly right: PaneState;
    /** The agent pane covers the centre ("go back and forth", spec 8.1). */
    readonly agentMaximised: boolean;
  };
  readonly navbars: { readonly global: NavbarConfig; readonly agent: NavbarConfig };
  readonly theme: {
    /** A PW theme name ("precision-weave-neon") or a custom theme name. */
    readonly name: string;
    readonly mode: "light" | "dark" | "system";
  };
  readonly hotkeys: Readonly<Record<HotkeyAction, string>> & { readonly [layerAction: string]: string };
  readonly animations: {
    /** How the agent shows that it is working. */
    readonly agentWorking: "pulse" | "glow" | "spinner" | "none";
    readonly agentIdle: "still" | "breathe";
    readonly reducedMotion: "system" | "on" | "off";
  };
}

/** JSON Merge Patch (RFC 7386) over UiConfig minus `version`: objects merge, arrays replace, null deletes. */
export type UiConfigPatch = { readonly [key: string]: Json };

export const DEFAULT_UI_CONFIG: UiConfig = {
  version: 1,
  panes: { left: { visible: true, width: 280 }, right: { visible: true, width: 440 }, agentMaximised: false },
  navbars: {
    global: {
      visible: true,
      items: [
        { id: "factory_name-1", widget: "factory_name", slot: "left", options: {} },
        // The status lives in the top bar, so the agent bar keeps room for the context bar and Stop at narrow widths.
        { id: "agent_status-1", widget: "agent_status", slot: "left", options: {} },
        { id: "cron_status-1", widget: "cron_status", slot: "right", options: {} },
      ],
    },
    agent: {
      visible: true,
      items: [{ id: "context_bar-1", widget: "context_bar", slot: "right", options: {} }],
    },
  },
  theme: { name: "precision-weave-neon", mode: "system" },
  hotkeys: {
    "settings.open": "s",
    "cron.open": "r",
    "panes.left.toggle": "[",
    "panes.right.toggle": "]",
    "agent.focus": "/",
    "agent.maximise": "m",
  },
  animations: { agentWorking: "glow", agentIdle: "still", reducedMotion: "system" },
};

// ---------------------------------------------------------------------------------------------------------------
// Layers (D5): each layer folder has manifest.ts (LayerManifest) and extension.ts

export type LayerKind = "harness" | "provider";

export interface LayerEnvVar {
  readonly name: string;
  readonly required: boolean;
  /** Secret values are never shown; the UI shows presence only (vault rule 8). */
  readonly secret: boolean;
  readonly description: string;
}

/**
 * Layer UI is declarative (DESIGN 8, "Layer UI and handlers"): a project layer cannot ship React (no build step), so
 * it describes controls and the web app's one generic renderer (web/layers/LayerControl.tsx) draws them with pw-ui.
 * `query` and `action` name the layer's own handlers (extension.ts `createHandlers`), reached through the generic
 * Service methods layerQuery / layerAction and the routes GET /api/layers/<layer>/query/<name> and
 * POST /api/layers/<layer>/action/<name>.
 *
 * Core bindings: a `query`, `action` or `optionsQuery.query` of the form `core:<capabilityId>` names a capability in
 * shared/capabilities.ts instead of a layer handler. A query binding needs a non-mutating capability with a GET
 * route (`core:settings.get`, `core:models.list`), an action binding a capability with a POST route (`core:model.set`).
 * The same two generic routes carry them (`.../query/core:settings.get`); the Service runs the capability's own method
 * with the given input, so a core binding gives a declarative layer no power the UI does not already have.
 *
 * `capability` is the data-cap id the rendered control carries; it must be a LayerCapability id of the same layer
 * or a core capability id. `field` picks a value out of the query result: a top-level key, or a dotted path
 * ("model.modelId"); the whole result when absent. A path through null or a missing key reads as null.
 * Text, number, toggle and select controls send `{ value }` to their action. With `actionInput` the Service turns
 * `{ value }` into the action's input: every string equal to "$value" in the template is replaced by the sent value
 * (`{ "modelId": "$value" }`); without it the body is passed through. A button sends its `input` as it is.
 * Select options are `options` (fixed strings) or `optionsQuery` (dynamic): the query result, or `field` of it,
 * is an array whose items are strings (value and label) or objects (`valueField`, default "value", and
 * `labelField`, default the value). Every query of a layer is re-read when the bus publishes `layer.changed` for that layer.
 */
export interface SelectOptionsQuery {
  /** A layer handler name or `core:<capabilityId>`. */
  readonly query: string;
  /** Dotted path of the array in the query result; the result itself when absent. */
  readonly field?: string;
  readonly valueField?: string;
  readonly labelField?: string;
  /** Sort the options by their value or label (source order when absent). */
  readonly sortBy?: "value" | "label";
  /**
   * Group the options (rendered as <optgroup>): by a string `field` of each object item, or by the part of the value
   * before the separator `prefix` ("/" puts "openrouter/anthropic/claude" under "openrouter"). An option without a
   * group is listed first, ungrouped. Groups are listed in sorted order.
   */
  readonly groupBy?: { readonly field: string } | { readonly prefix: string };
  /** Compare digits as numbers when sorting ("gpt-4" before "gpt-10"; Intl.Collator numeric). */
  readonly numeric?: boolean;
}

export type LayerControl =
  | { readonly kind: "value"; readonly label: string; readonly query: string; readonly field?: string; readonly capability: string }
  | {
      readonly kind: "button";
      readonly label: string;
      readonly action: string;
      readonly input?: Json;
      /** Shown in a ConfirmDialog before the action runs. */
      readonly confirm?: string;
      readonly capability: string;
    }
  | {
      readonly kind: "toggle" | "text" | "number";
      readonly label: string;
      readonly query: string;
      readonly field: string;
      readonly action: string;
      /** Input template for the action: "$value" is replaced by the sent value. */
      readonly actionInput?: Json;
      readonly capability: string;
    }
  | {
      readonly kind: "select";
      readonly label: string;
      readonly query: string;
      readonly field: string;
      /** Fixed options; one of `options` and `optionsQuery` is required. */
      readonly options?: readonly string[];
      readonly optionsQuery?: SelectOptionsQuery;
      readonly action: string;
      readonly actionInput?: Json;
      readonly capability: string;
    };

export interface SettingsPanelContribution {
  /** "<layer>.<panel>". */
  readonly id: string;
  readonly title: string;
  readonly section: "essentials" | "core4" | "advanced";
  /** Rendered in order by the generic renderer. */
  readonly controls: readonly LayerControl[];
}

export interface WidgetContribution {
  /** Unique: "<layer>.<widget>". */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly navbars: readonly NavbarId[];
  readonly defaultOptions: WidgetOptions;
  /** What the widget shows: one declarative control. */
  readonly control: LayerControl;
  /**
   * Where to place the widget when its layer loads: applied once per widget type (see DESIGN 8, "Versions, requires
   * and default placements"). `navbar` must be one of `navbars`.
   */
  readonly defaultPlacements?: readonly DefaultPlacement[];
}

export interface DefaultPlacement {
  readonly navbar: NavbarId;
  readonly slot: NavbarSlot;
}

export interface HotkeyContribution {
  /** "<layer>.<action>". */
  readonly action: string;
  readonly title: string;
  readonly defaultKey: string;
  /** Run a layer action, or open one of the layer's settings panels. */
  readonly run:
    | { readonly kind: "action"; readonly action: string; readonly input?: Json }
    | { readonly kind: "panel"; readonly panel: string };
}

/**
 * A capability a layer adds to the parity list (spec 8.7). Its Service method is always the generic layerQuery
 * (kind "query") or layerAction (kind "action"), and its route is derived:
 * GET /api/layers/<layer>/query/<handler> or POST /api/layers/<layer>/action/<handler>.
 * Every column is required: a layer capability always has a tool and a UI control (spec 2.2).
 */
export interface LayerCapability {
  /** "<layer>.<name>"; also the data-cap id. */
  readonly id: string;
  readonly summary: string;
  readonly kind: "query" | "action";
  /** The handler name in createHandlers(). */
  readonly handler: string;
  /** A tool of the same layer. */
  readonly tool: string;
  /** A LayerControl.capability in this manifest (equal to `id`). */
  readonly control: string;
  readonly mutates: boolean;
}

export interface LayerRequires {
  /** A semver range on the app's package.json version (`>=0.9.0`, `^1.2`). */
  readonly core?: string;
  /** Names of layers that must be loaded (built-in or project). */
  readonly layers?: readonly string[];
}

export interface LayerManifest {
  /** snake_case; equals the pi-durable extension name. */
  readonly name: string;
  readonly kind: LayerKind;
  readonly title: string;
  readonly description: string;
  /** factory_harness only: Service refuses to disable or remove it (D7). */
  readonly required?: boolean;
  /** In pi-durable's host default selection (HarnessSettings.extensions). */
  readonly enabledByDefault: boolean;
  readonly env: readonly LayerEnvVar[];
  /** Hosts the layer's code calls; each must be covered by the Agent Vault (spec 9). */
  readonly vaultHosts: readonly string[];
  readonly ui: {
    readonly settingsPanels: readonly SettingsPanelContribution[];
    readonly widgets: readonly WidgetContribution[];
    readonly hotkeys: readonly HotkeyContribution[];
  };
  readonly capabilities?: readonly LayerCapability[];
  /** Semver (`1.2.3`). Required in manifest.json; `create_layer` writes "0.1.0". Optional in a code manifest. */
  readonly version?: string;
  /** What must be present for the layer to load; an unmet entry makes it load with status "failed". */
  readonly requires?: LayerRequires;
  /** Where the layer came from: a URL, or "local". Free text. */
  readonly origin?: string;
  /** kind "provider": the pi-ai provider id it registers ("openrouter"). */
  readonly providerId?: string;
}

export interface LayerInfo {
  readonly name: string;
  readonly kind: LayerKind;
  readonly title: string;
  readonly description: string;
  readonly source: "builtin" | "project";
  /** Load order index (0 = first). */
  readonly order: number;
  readonly required: boolean;
  readonly enabled: boolean;
  readonly status: "loaded" | "failed";
  readonly error?: string;
  /** Tool names inside the ceiling that this layer registers. */
  readonly tools: readonly string[];
  /** Tool names this layer defines that the ceiling removed. */
  readonly toolsOutsideCeiling: readonly string[];
  /** Prompt section keys, "<layer>-<key>" (pi-durable 1.5.0 section keys must match /^[a-z][a-z0-9_-]*$/; DESIGN 7). */
  readonly sections: readonly string[];
  readonly env: readonly { readonly name: string; readonly required: boolean; readonly present: boolean }[];
  readonly ui: LayerManifest["ui"];
  readonly version?: string;
  readonly origin?: string;
  readonly requires?: LayerRequires;
}

// Layer authoring (P9, factory_controls): create and edit declarative project layers, define widget types, reload.

/** One file of a layer folder: POSIX path relative to the folder, size in bytes. */
export interface LayerFileEntry {
  readonly path: string;
  readonly size: number;
}

/** `list_layer_files`: the files of one layer. Built-in layers are listed read-only (`editable: false`). */
export interface LayerFileList {
  readonly name: string;
  readonly source: "builtin" | "project";
  readonly editable: boolean;
  readonly files: readonly LayerFileEntry[];
}

/** `read_layer_file`. */
export interface LayerFileContent {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly content: string;
}

export interface CreateLayerInput {
  /** `^[a-z][a-z0-9_]{1,40}$`, also the folder name. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Default true. */
  readonly enabledByDefault?: boolean;
}

/** export_layer, POST /api/layers/export. */
export interface ExportLayerInput {
  /** A project layer. */
  readonly name: string;
  /** Archive file name inside `tsf/data/exports` (`<name>-<version>.tgz` when absent). */
  readonly to?: string;
}

export interface ExportLayerResult {
  readonly name: string;
  readonly version: string;
  /** Absolute path of the archive. */
  readonly path: string;
  /** The archive's file name; download it with GET /api/layers/export-file?file=. */
  readonly file: string;
  /** Archive size in bytes. */
  readonly size: number;
  /** Paths of the files archived. */
  readonly files: readonly string[];
}

/** import_layer, POST /api/layers/import. */
export interface ImportLayerInput {
  /** Layer name to install under; defaults to the manifest's name (which must then match). */
  readonly name?: string;
  /** A local path to a .tgz or a layer folder, or an https URL to a .tgz. */
  readonly source: string;
  /** Overwrite an existing project layer of the same name. */
  readonly replace?: boolean;
}

export interface ImportLayerResult {
  readonly name: string;
  readonly version: string;
  readonly files: readonly string[];
  /** True when an existing layer was overwritten. */
  readonly replaced: boolean;
  /** The layer after reload; `status: "failed"` carries the reason (for example an unmet `requires`). */
  readonly layer: LayerInfo;
}

export interface LayerFileInput {
  readonly name: string;
  readonly path: string;
}

export interface WriteLayerFileInput extends LayerFileInput {
  readonly content: string;
}

export interface WriteLayerFileResult {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  /** The layer as the reload found it: `status: "failed"` carries the validation message in `error`. */
  readonly layer: LayerInfo;
}

export interface DeleteLayerFileResult {
  readonly name: string;
  readonly path: string;
  readonly layer: LayerInfo;
}

export interface DeleteLayerResult {
  readonly name: string;
  /** Placement ids removed from the UI config because their widget type went with the layer. */
  readonly placementsRemoved: readonly string[];
}

export interface DefineWidgetInput {
  /** A project layer whose folder holds manifest.json. */
  readonly layer: string;
  /** `id` must be `<layer>.<name>`; an existing id is replaced. */
  readonly widget: WidgetContribution;
}

export interface DefineWidgetResult {
  readonly layer: string;
  readonly widget: WidgetContribution;
  /** True when the id was new, false when it replaced an existing widget type. */
  readonly created: boolean;
  /** The layer after reload; `status: "failed"` when the manifest no longer validates (the file is still written). */
  readonly info: LayerInfo;
}

export interface UndefineWidgetInput {
  readonly layer: string;
  /** The widget type id, `<layer>.<name>`. */
  readonly id: string;
}

export interface UndefineWidgetResult {
  readonly layer: string;
  readonly id: string;
  /** Placement ids removed from the UI config. */
  readonly placementsRemoved: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Tools and the ceiling

export interface ToolInfo {
  /** Plain name (D8), unique across layers. */
  readonly name: string;
  readonly layer: string;
  readonly description: string;
  /** JSON Schema (pi-schema builders emit plain JSON Schema). */
  readonly parameters: Json;
  readonly replay: "safe" | "unsafe";
  /** Always true for listed tools: tools outside the ceiling are never registered or listed here. */
  readonly inCeiling: true;
  /** Not in Settings.toolsDisabled. */
  readonly enabled: boolean;
  /** Enabled and its layer is enabled: the model is offered it on the next request. */
  readonly offered: boolean;
}

export interface CeilingInfo {
  /** "file": tsf/permissions.json was read; "default": it was missing, so everything is allowed. */
  readonly source: "file" | "default";
  readonly file: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  /** `--tools` patterns for this run, or null. They narrow, never widen. */
  readonly cliPatterns: readonly string[] | null;
  /** "layer.tool" of every defined tool, split by the verdict. */
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// P5: Core 4 (context, model, prompts, tools)

/** `GET /api/context`, tool `get_context`: what the context bar and the Settings > Core 4 context panel show. */
export interface ContextInfo {
  readonly model: ModelRef | null;
  readonly modelName: string | null;
  /** Newest assistant usage total: the size the next request starts from. */
  readonly contextTokens: number;
  readonly contextWindow: number;
  /** contextTokens / contextWindow, 0..1 (0 when the window is unknown). */
  readonly fraction: number;
  /** The stored points (absolute token counts, D3). */
  readonly points: CompactionPoints;
  /** The points mapped onto the current window (`clamped` when they did not fit). */
  readonly compaction: EffectiveCompaction;
  /** A compaction is running now. */
  readonly compacting: boolean;
  readonly compactionFailure?: string;
  readonly usage: { readonly totalTokens: number; readonly costUsd: number };
}

/** What `compact` answers: the manual compaction task was admitted; it summarises while the agent keeps working. */
export interface CompactResult {
  readonly taskId: number;
  readonly instructions: string | null;
}

/** `refresh_models`: provider ids whose live list was refetched, and the model count now listed. */
export interface RefreshModelsResult {
  readonly refreshed: readonly string[];
  readonly count: number;
}

/** `set_model` and `set_thinking_level` answer with the selection as it applies. */
export interface ModelSelection {
  /** The model the agent uses now (the stored one, or the catalog default when that is gone). */
  readonly model: ModelRef;
  readonly modelName: string | null;
  /** The stored level (what Settings shows). */
  readonly thinkingLevel: ThinkingLevel;
  /** The level the model gets: the stored one clamped to what the model supports. */
  readonly effectiveThinkingLevel: ThinkingLevel;
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
}

/**
 * `list_favourite_models`, GET /api/models/favourites: the favourites in order, then the model in use when it is not
 * one of them (`favourite: false`), so a picker over this list always names the current model.
 */
export interface FavouriteModel {
  readonly provider: string;
  readonly modelId: string;
  /** The model's name without its vendor prefix ("GPT-6.1 Terra", not "OpenAI: GPT-6.1 Terra"); the id when unknown. */
  readonly name: string;
  /** What a picker shows: the name, marked "(current)" or "(not offered)" when that applies. */
  readonly label: string;
  readonly favourite: boolean;
  /** 1-based place in the favourites; null for the current model that is not a favourite. */
  readonly position: number | null;
  /** Offered by an enabled provider now. A favourite that is not stays in the list, marked, and cannot be chosen. */
  readonly available: boolean;
  readonly current: boolean;
}

/**
 * `set_favourite_model`, POST /api/model/favourite. `favourite: true` adds the model (it must be offered) at
 * `position` (1-based, default 1: the front) or moves it there when it is already a favourite; `false` removes it.
 */
export interface SetFavouriteInput {
  readonly provider: string;
  readonly modelId: string;
  readonly favourite: boolean;
  readonly position?: number;
}

/** The four prompt layers (spec 8.5): 1 system, 2 custom, 3 extension sections, 4 runtime. */
export type PromptLayer = "system" | "custom" | "extension" | "runtime";

export interface PromptInfo {
  /** `system`, `custom:<id>`, `section:<key>` or `runtime:<id>`. Methods that take an id also take the bare form. */
  readonly id: string;
  readonly layer: PromptLayer;
  readonly title: string;
  /** Custom prompts and extension sections can be switched off; system and runtime prompts are always on. */
  readonly enabled: boolean;
  /** system, custom and runtime text can be edited or removed; extension sections are read-only (on/off only). */
  readonly editable: boolean;
  /** Extension sections: the contributing layer and the section key (`<layer>-<key>`). */
  readonly layerName?: string;
  readonly key?: string;
  /** system: true when settings hold an override. */
  readonly override?: boolean;
  /** Custom prompts: who made it. Runtime prompts: who appended it. */
  readonly by?: Actor;
  readonly length: number;
  /** The text. In the list it is `null` for extension sections (use get_prompt, which renders them). */
  readonly text: string | null;
}

/** `GET /api/prompts`, tool `list_prompts`. */
export interface PromptList {
  readonly system: PromptInfo;
  readonly custom: readonly PromptInfo[];
  readonly extensions: readonly PromptInfo[];
  readonly runtime: readonly PromptInfo[];
}

/** `GET /api/tools/describe`, tool `describe_tool`. `schema` and `signature` are present as the syntax asked for. */
export interface ToolDescription {
  readonly name: string;
  readonly layer: string;
  readonly description: string;
  readonly replay: "safe" | "unsafe";
  readonly enabled: boolean;
  readonly offered: boolean;
  readonly syntax: "json" | "typescript" | "both";
  /** JSON Schema of the parameters (syntax json or both). */
  readonly schema?: Json;
  /** `name(args: { ... }): Promise<unknown>` (syntax typescript or both). */
  readonly signature?: string;
  /** The requested representation as text: pretty JSON Schema, or the signature (both: the signature). */
  readonly text: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Cron (P6)

export interface CronEntry {
  readonly id: string;
  readonly name: string;
  /** croner expression, 5 or 6 fields. */
  readonly expr: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastSlot: number | null;
  readonly lastStatus: "queued" | "running" | "answered" | "failed" | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A cron fire is submitted as `{ type: "input", content: prompt, requestId: "cron:<cronId>:<slot>" (or
 * "cron-now:<cronId>:<callId|uuid>"), whenBusy: "followUp", entry: { kind: CRON_ENTRY_KIND, data: CronEntryData } }`.
 * pi-durable places it as an entry of that kind whose `model` is the user message, and while it waits the pi.inbox
 * item carries the same `entry`. agent/chat-view.ts turns the entry into a ChatItem of kind "cron" and the inbox item
 * into ChatLive.inbox[].cron; the recorder gives its run the trigger "cron" (DESIGN 4.1).
 */
export const CRON_ENTRY_KIND = "tsf.cron" as const;

export interface CronEntryData {
  readonly cronId: string;
  readonly name: string;
  /** The scheduled slot (ms epoch) this fire stands for; for a manual run, the time it was asked for. */
  readonly slot: number;
  readonly catchUp: boolean;
  readonly manual: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// jev (P7): TypeSafe System One, POST https://api.typesafe.ai/v1/systemone, model "jev-latest" (DESIGN 8, jev)

/** What a jev question judges: a string, an object or an array (System One rejects bare numbers and booleans). */
export type JevState = string | { readonly [key: string]: Json } | readonly Json[];

/**
 * One question. `question` becomes the System One `instructions`. noul: yes/no probability (`criteria` optional);
 * choice: 2..255 options, each with an optional rubric; score: 2..10 levels, low to high.
 */
export type JevInput =
  | {
      readonly kind: "noul";
      readonly question: string;
      readonly state: JevState;
      readonly criteria?: { readonly true?: string; readonly false?: string };
    }
  | {
      readonly kind: "choice";
      readonly question: string;
      readonly state: JevState;
      readonly options: { readonly [option: string]: string | null };
    }
  | { readonly kind: "score"; readonly question: string; readonly state: JevState; readonly levels: readonly string[] };

/** The answer, flattened from System One's `answers.q`. `model` is the versioned model that answered. */
export type JevVerdict =
  | { readonly kind: "noul"; readonly probability: number; readonly model: string }
  | {
      readonly kind: "choice";
      readonly choice: string;
      readonly probabilities: { readonly [option: string]: number };
      readonly confidence: number;
      readonly model: string;
    }
  | {
      readonly kind: "score";
      /** Probability-weighted position along the levels, 0-based as System One returns it (0 = first level), may land between levels. */
      readonly score: number;
      readonly probabilities: { readonly [level: string]: number };
      readonly confidence: number;
      readonly model: string;
    };

// ---------------------------------------------------------------------------------------------------------------
// Themes (P4)

export type ThemeMode = "light" | "dark";
export type ModeValues<T extends string | number = string | number> = { readonly light?: T; readonly dark?: T };

export interface ThemeInfo {
  readonly name: string;
  readonly title: string;
  readonly kind: "pw" | "custom";
  /** Custom themes: the PW theme they extend. */
  readonly base: string | null;
  readonly style: string;
  /** Custom themes: the stored seeds and tokens, so the editor can show them. PW themes: absent. */
  readonly definition?: CustomTheme;
  /** The effective colours per mode after inheritance (the base value unless overridden), for the editor. */
  readonly resolved?: ResolvedColours;
}

/** Effective seeds (keys in pw-ui SEEDS) and tokens (the keys the editor offers) per mode, as hex or css strings. */
export interface ResolvedColours {
  readonly seeds: { readonly [seed: string]: ModeValues<string> };
  readonly tokens: { readonly [token: string]: ModeValues<string> };
}

/** A custom theme as stored in tsf.sqlite: the pw-ui source-theme format (seeds, tokens) on top of a PW base. */
export interface CustomTheme {
  readonly name: string;
  readonly title: string;
  readonly base: string;
  readonly seeds: { readonly [seed: string]: ModeValues<string> };
  readonly tokens: { readonly [token: string]: ModeValues | string | number };
}

export interface ThemeCheck {
  readonly name: string;
  /** pw-ui contrast() lines; warnings never block a change. */
  readonly warnings: readonly string[];
  /** pw-ui fixes() proposals. */
  readonly fixes: readonly { readonly mode: string; readonly token: string; readonly from: string; readonly to: string }[];
  readonly problems: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Chat view: what the web renders, built on the server from Conversation.watch + ConversationTranscript

export interface ChatUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/**
 * Mapping from a Harness-written result's first diagnostic code (agent/chat-view.ts): blocked -> "blocked",
 * interrupted -> "interrupted", tool_unavailable -> "unavailable", aborted and invalid_arguments -> "failed" (the code
 * stays in `diagnostic`), any other isError result -> "failed". "truncated" is a warning on a successful result: "done".
 */
export type ToolStatus = "pending" | "running" | "done" | "failed" | "blocked" | "interrupted" | "unavailable";

export type ChatItem =
  | {
      readonly kind: "user";
      /** "e<entryId>" */
      readonly id: string;
      readonly entryId: number;
      readonly text: string;
    }
  | {
      /** A cron prompt placed as entry kind CRON_ENTRY_KIND with CronEntryData (P6); `text` is its user message. */
      readonly kind: "cron";
      readonly id: string;
      readonly entryId: number;
      readonly cronId: string;
      readonly name: string;
      readonly slot: number;
      readonly text: string;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly entryId: number;
      readonly text: string;
      readonly thinking?: string;
      readonly model?: string;
      /** pi-ai stopReason; "aborted" or "error" marks a failed attempt. */
      readonly stopReason?: string;
      readonly error?: string;
      readonly usage?: ChatUsage;
      readonly durationMs?: number;
    }
  | {
      readonly kind: "tool";
      /** "t<callId>" */
      readonly id: string;
      readonly callId: string;
      /** The assistant entry that made the call. */
      readonly entryId: number;
      readonly name: string;
      readonly layer?: string;
      readonly args: Json;
      readonly status: ToolStatus;
      /** Result text, capped at 4 000 chars for the view. */
      readonly output?: string;
      readonly resultEntryId?: number;
      readonly durationMs?: number;
      /** First diagnostic code of a Harness-written result: blocked, interrupted, tool_unavailable, ... */
      readonly diagnostic?: string;
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly entryId: number;
      readonly event: "compaction" | "reset" | "note";
      readonly text: string;
    };

export type LivePhase = "idle" | "waiting" | "streaming" | "tools" | "retrying" | "compacting";

export interface ChatLive {
  /** pi.live.run !== undefined */
  readonly busy: boolean;
  readonly phase: LivePhase;
  readonly runTaskId?: number;
  readonly turns?: number;
  /** pi.live.generation.message, flattened. */
  readonly streaming?: {
    readonly text: string;
    readonly thinking?: string;
    readonly toolCalls: readonly { readonly callId: string; readonly name: string }[];
  };
  /** pi.live.tools: the current tool round. `output` is the tail, at most 4 000 chars. */
  readonly tools: readonly { readonly callId: string; readonly name: string; readonly status: "pending" | "running" | "done"; readonly output?: string }[];
  readonly retry?: { readonly at: number; readonly error: string };
  readonly compactions: readonly { readonly trigger: "manual" | "threshold" | "overflow"; readonly blocking: boolean }[];
  readonly compactionFailure?: { readonly error: string };
  /** pi.live.runFailure: why the newest run ended without an answer. */
  readonly runFailure?: { readonly reason: string; readonly detail?: string };
  /** pi.inbox items waiting for the run. */
  readonly inbox: readonly {
    readonly id: string;
    readonly mode: "steer" | "followUp" | "write";
    readonly text: string;
    /** Set when the inbox item's `entry.kind` is CRON_ENTRY_KIND, from its CronEntryData. */
    readonly cron?: { readonly cronId: string; readonly name: string };
  }[];
}

export interface ChatMeta {
  readonly model: ModelRef | null;
  readonly modelName: string | null;
  readonly thinkingLevel: ThinkingLevel;
  /** Newest pi.assistant usage totalTokens: the size the next request starts from. */
  readonly contextTokens: number;
  readonly contextWindow: number;
  readonly compaction: EffectiveCompaction;
  /** pi.usage summed over models and tools. */
  readonly usage: { readonly totalTokens: number; readonly costUsd: number };
  /** Resolved Conversation.agent(): selected extension names and offered tool names. */
  readonly extensions: readonly string[];
  readonly offeredTools: readonly string[];
}

export interface ChatView {
  /** Oldest first. At most the newest 200 items are kept in the server's view. */
  readonly items: readonly ChatItem[];
  /** Older entries exist: GET /api/chat/earlier?before=<oldest entryId>. */
  readonly hasEarlier: boolean;
  readonly live: ChatLive;
  readonly meta: ChatMeta;
}

/** Chat deltas, built by agent/feed.ts from each Conversation.watch value. */
export type ChatDelta =
  | { readonly type: "chat.append"; readonly items: readonly ChatItem[] }
  /** Replaces items with the same id (a tool item gaining its result). */
  | { readonly type: "chat.update"; readonly items: readonly ChatItem[] }
  | { readonly type: "chat.live"; readonly live: ChatLive }
  | { readonly type: "chat.meta"; readonly meta: ChatMeta }
  /** The whole view, when the feed cannot express the change as the above (watch root replacement). */
  | { readonly type: "chat.reset"; readonly chat: ChatView };

// ---------------------------------------------------------------------------------------------------------------
// Runs (the recorder, spec 11 Logging)

/**
 * One row of the recorder (agent/recorder.ts). It is derived from the feed's raw commits (FeedCommit: the watch's
 * ConversationView, with pi.live.run and the entries), not from ChatItems; DESIGN 8 "Recorder" gives every field's
 * source.
 */
export interface RunSummary {
  /** The first pi.live.run.taskId seen for the run (a run is the span in which pi.live.run is present). */
  readonly id: number;
  readonly trigger: "chat" | "cron" | "continue" | "system";
  readonly status: "running" | "answered" | "failed" | "aborted";
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly model: string | null;
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: ChatUsage;
  /** "provider" when every step carried usage.cost.totalFromProvider, else "estimate". */
  readonly costSource: "provider" | "estimate";
  readonly failure: string | null;
  /** First 300 chars of the input that started the run. */
  readonly prompt: string;
}

export interface RunToolCall {
  readonly callId: string;
  readonly name: string;
  readonly status: ToolStatus;
  readonly durationMs: number | null;
  readonly diagnostic: string | null;
  /** Arguments and output, each capped at 20 000 chars. */
  readonly args: string;
  readonly output: string;
}

export interface RunDetail extends RunSummary {
  readonly tools: readonly RunToolCall[];
}

// ---------------------------------------------------------------------------------------------------------------
// Status

export interface FactoryStatus {
  readonly name: string;
  readonly version: string;
  readonly projectRoot: string;
  readonly pid: number;
  readonly bootId: number;
  readonly startedAt: number;
  readonly url: string;
  readonly busy: boolean;
  readonly model: ModelRef | null;
  /** D1: "faux" when TSF_MODEL_PROVIDER=faux, else "layers". */
  readonly modelSource: "faux" | "layers";
  readonly layers: number;
  readonly tools: number;
  /** The web build the server serves (DESIGN 3 "Web build", live rebuild). */
  readonly web: WebStatus;
}

/**
 * `hash` is the served build's source hash (null when no web app is served: `--dev`, tests, no source), `building` is
 * true while a rebuild runs, `lastError` is vite's trimmed text of the newest failed rebuild (null after a good one).
 * A failed rebuild keeps the previous good build serving.
 */
export interface WebStatus {
  readonly hash: string | null;
  readonly building: boolean;
  readonly lastError: string | null;
}

/** rebuild_web, POST /api/factory/rebuild-web. */
export interface RebuildWebResult {
  readonly ok: boolean;
  readonly hash: string | null;
  readonly error?: string;
  readonly durationMs: number;
}

export interface RestartInput {
  readonly reason?: string;
}

/** restart_factory, POST /api/factory/restart. The restart begins `restartingInMs` later; clients reconnect on their own. */
export interface RestartResult {
  readonly restartingInMs: number;
  /** How the process comes back: "systemd" exits 3 for Restart=on-failure, "respawn" starts a detached replacement. */
  readonly mode: "systemd" | "respawn";
  /** True when this call id had already restarted the factory (a replayed tool call): nothing was done. */
  readonly alreadyRestarted?: boolean;
}

export interface ScreenshotInput {
  /** "/" (default) or an app path such as "/?x=1"; always on the factory's own origin. */
  readonly page?: string;
  /** CSS selector: capture just that element. */
  readonly selector?: string;
  readonly width?: number;
  readonly height?: number;
  readonly mode?: "light" | "dark";
  readonly fullPage?: boolean;
}

export interface ScreenshotResult {
  /** Absolute path of the PNG (under tsf/data/screenshots, which file tools cannot read; the tool attaches the image). */
  readonly path: string;
  /** File name; GET /api/screenshots/<file>. */
  readonly file: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------------------------------------------
// SSE protocol (D9): GET /api/events

export interface Snapshot {
  readonly apiVersion: typeof API_VERSION;
  readonly bootId: number;
  readonly serverTime: number;
  readonly status: FactoryStatus;
  readonly chat: ChatView;
  readonly pages: PageTree;
  readonly selection: Selection;
  /** The selected page's content, or null. */
  readonly focus: Page | null;
  readonly settings: Settings;
  readonly uiConfig: UiConfig;
  readonly layers: readonly LayerInfo[];
  readonly tools: readonly ToolInfo[];
  readonly ceiling: CeilingInfo;
  readonly runs: readonly RunSummary[];
  /** P4: [] before. */
  readonly themes: readonly ThemeInfo[];
  /**
   * The full CSS of the active theme, PW or custom, from P3 on: the theme's token CSS plus its style preset CSS
   * (glass.css for a glass theme, nothing for flat). The browser puts it in <style id="tsf-theme">; no theme CSS is
   * imported statically (DESIGN 11).
   */
  readonly themeCss: string;
  /** P6: [] before. */
  readonly cron: readonly CronEntry[];
}

/** Every change after the snapshot: chat deltas from the watch, app events from the bus. */
export type Delta = ChatDelta | AppEvent;

/**
 * One SSE message: `event: <type>`, `data: <JSON of the frame>`.
 * `snapshot` and `delta` carry `id: <n>` (monotonic integer, starts at bootId * 1000); `hello` and `ping` carry none.
 */
export type SseFrame =
  | {
      readonly type: "hello";
      readonly apiVersion: typeof API_VERSION;
      readonly bootId: number;
      readonly serverTime: number;
      /** True when the missed deltas follow instead of a snapshot. */
      readonly resumed: boolean;
    }
  | { readonly type: "snapshot"; readonly id: number; readonly snapshot: Snapshot }
  | { readonly type: "delta"; readonly id: number; readonly delta: Delta }
  | { readonly type: "ping"; readonly serverTime: number };

/** Error body of every non-2xx JSON response. */
export interface ApiError {
  readonly error: {
    /** HTTP: invalid 400, forbidden 403, not_found 404, conflict 409, busy 409, too_large 413, internal 500, unavailable 503, upstream 502 (P7: a provider answered non-2xx). */
    readonly code: "invalid" | "not_found" | "conflict" | "busy" | "forbidden" | "too_large" | "unavailable" | "upstream" | "internal";
    readonly message: string;
  };
}
