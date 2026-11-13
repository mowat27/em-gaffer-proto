/**
 * Declarative layers (DESIGN 8, "Declarative layers"): strict validation of `manifest.json`, of widget contributions
 * (also used by `defineWidget`) and of control bindings, including `core:<capabilityId>` bindings (shared/types.ts
 * `LayerControl`). Pure functions: no file or Service access, so the registry, the Service and the tests share them.
 * Every check collects its problems and the caller reports them all with their field path.
 */
import { CAPABILITIES } from "../shared/capabilities.ts";
import { isSemver, isSemverRange, satisfies } from "../shared/semver.ts";
import type {
  HotkeyContribution,
  Json,
  LayerCapability,
  LayerControl,
  LayerEnvVar,
  LayerManifest,
  LayerRequires,
  SettingsPanelContribution,
  WidgetContribution,
} from "../shared/types.ts";

export const LAYER_NAME = /^[a-z][a-z0-9_]{1,40}$/;
export const HANDLER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const CORE_PREFIX = "core:";
/** The one placeholder `actionInput` templates use. */
export const VALUE_PLACEHOLDER = "$value";

const TOP_LEVEL_KEYS = ["name", "kind", "title", "description", "enabledByDefault", "env", "vaultHosts", "ui", "capabilities", "version", "requires", "origin"] as const;
const SECTIONS = ["essentials", "core4", "advanced"] as const;
const NAVBARS = ["global", "agent"] as const;
const SLOTS = ["left", "center", "right"] as const;
const MAX_ITEMS = 100;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Handler names a layer's own `createHandlers` provides; undefined skips the existence check. */
export interface HandlerNames {
  readonly queries: ReadonlySet<string>;
  readonly actions: ReadonlySet<string>;
}

export const isCoreRef = (name: string): boolean => name.startsWith(CORE_PREFIX);

/** `core:model.set` gives `model.set`. */
export const coreId = (name: string): string => name.slice(CORE_PREFIX.length);

/** The capability a `core:` binding names, or undefined. */
export const coreCapability = (name: string) => CAPABILITIES.find((c) => c.id === coreId(name));

/** Why `name` cannot be a core query or action binding, or null when it can. */
export function coreBindingProblem(name: string, kind: "query" | "action"): string | null {
  const id = coreId(name);
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return `${name}: no core capability ${id}`;
  if (kind === "query") {
    if (cap.mutates || !cap.routes.some((r) => r.method === "GET")) {
      return `${name}: a query binding needs a non-mutating capability with a GET route`;
    }
  } else if (!cap.routes.some((r) => r.method === "POST")) {
    return `${name}: an action binding needs a capability with a POST route`;
  }
  return null;
}

function handlerRefProblem(at: string, name: unknown, kind: "query" | "action", names: HandlerNames | undefined): string | null {
  if (typeof name !== "string" || name === "") return `${at}: must be a handler name or core:<capabilityId>`;
  if (isCoreRef(name)) {
    const p = coreBindingProblem(name, kind);
    return p === null ? null : `${at}: ${p}`;
  }
  if (!HANDLER_NAME.test(name)) return `${at}: ${name} is not a handler name (lowercase letters, digits, underscores) or core:<capabilityId>`;
  if (names && !(kind === "query" ? names.queries : names.actions).has(name)) {
    return `${at}: the layer has no ${kind} handler ${name} (extension.ts createHandlers)`;
  }
  return null;
}

/** Dotted path into a JSON value; a missing key or a path through a non-object reads as null. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === "") return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (!isRecord(cur) || !Object.hasOwn(cur, key)) return null;
    cur = cur[key];
  }
  return cur;
}

/** Replace every string equal to "$value" in a JSON template with `value`. */
export function applyValueTemplate(template: Json, value: Json): Json {
  if (template === VALUE_PLACEHOLDER) return value;
  if (Array.isArray(template)) return template.map((t) => applyValueTemplate(t, value));
  if (isRecord(template)) return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, applyValueTemplate(v as Json, value)]));
  return template;
}

/** Every control of the manifest (panels, then widgets). */
export function manifestControls(ui: LayerManifest["ui"] | undefined): LayerControl[] {
  return [...(ui?.settingsPanels ?? []).flatMap((p) => [...p.controls]), ...(ui?.widgets ?? []).map((w) => w.control)];
}

/** Every `core:` name the manifest's controls and hotkeys bind: the only core calls the layer's routes will carry. */
export function declaredCoreBindings(manifest: LayerManifest): Set<string> {
  const out = new Set<string>();
  const add = (n: unknown) => {
    if (typeof n === "string" && isCoreRef(n)) out.add(n);
  };
  for (const c of manifestControls(manifest.ui)) {
    if ("query" in c) add(c.query);
    if ("action" in c) add(c.action);
    if (c.kind === "select") add(c.optionsQuery?.query);
  }
  for (const h of manifest.ui?.hotkeys ?? []) if (h.run.kind === "action") add(h.run.action);
  return out;
}

/** Problems of the `core:` bindings of a manifest written in code (manifest.ts): its other references are not checked. */
export function coreBindingProblems(manifest: LayerManifest): string[] {
  const out: string[] = [];
  const check = (name: unknown, kind: "query" | "action") => {
    if (typeof name === "string" && isCoreRef(name)) {
      const p = coreBindingProblem(name, kind);
      if (p) out.push(p);
    }
  };
  for (const c of manifestControls(manifest.ui)) {
    if ("query" in c) check(c.query, "query");
    if ("action" in c) check(c.action, "action");
    if (c.kind === "select") check(c.optionsQuery?.query, "query");
  }
  for (const h of manifest.ui?.hotkeys ?? []) if (h.run.kind === "action") check(h.run.action, "action");
  return out;
}

/** The `actionInput` template of the first control whose action is `name`, or undefined. */
export function actionTemplate(manifest: LayerManifest, name: string): Json | undefined {
  for (const c of manifestControls(manifest.ui)) {
    if ("actionInput" in c && c.action === name && c.actionInput !== undefined) return c.actionInput;
  }
  return undefined;
}

interface ControlEnv {
  readonly layerCaps: ReadonlySet<string>;
  readonly handlers?: HandlerNames | undefined;
}

function strictKeys(at: string, obj: Record<string, unknown>, allowed: readonly string[], out: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) out.push(`${at}: unknown key ${k}`);
}

function str(at: string, v: unknown, out: string[], max = 200, min = 1): v is string {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    out.push(`${at}: must be a string of ${min}..${max} characters`);
    return false;
  }
  return true;
}

function jsonValue(v: unknown, depth = 0): v is Json {
  if (depth > 8) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 200 && v.every((i) => jsonValue(i, depth + 1));
  if (isRecord(v)) return Object.keys(v).length <= 200 && Object.values(v).every((i) => jsonValue(i, depth + 1));
  return false;
}

/** Problems of one control: shape, bindings and the `capability` reference. */
export function controlProblems(at: string, control: unknown, env: ControlEnv, out: string[] = []): string[] {
  if (!isRecord(control)) return [...out, `${at}: must be an object`];
  const kind = control.kind;
  const common = ["kind", "label", "capability"];
  const capOk = () => {
    if (!str(`${at}/capability`, control.capability, out, 100)) return;
    if (!env.layerCaps.has(control.capability as string) && !CAPABILITIES.some((c) => c.id === control.capability)) {
      out.push(`${at}/capability: ${String(control.capability)} is neither a capability of this layer nor a core capability id`);
    }
  };
  str(`${at}/label`, control.label, out, 80);
  capOk();
  const query = (key: string, k: "query" | "action") => {
    const p = handlerRefProblem(`${at}/${key}`, control[key], k, env.handlers);
    if (p) out.push(p);
  };
  const template = () => {
    if (control.actionInput !== undefined && (!jsonValue(control.actionInput) || !isRecord(control.actionInput))) {
      out.push(`${at}/actionInput: must be a JSON object (use "${VALUE_PLACEHOLDER}" where the sent value goes)`);
    }
  };
  if (kind === "value") {
    strictKeys(at, control, [...common, "query", "field"], out);
    query("query", "query");
    if (control.field !== undefined) str(`${at}/field`, control.field, out, 200);
  } else if (kind === "button") {
    strictKeys(at, control, [...common, "action", "input", "confirm"], out);
    query("action", "action");
    if (control.input !== undefined && !jsonValue(control.input)) out.push(`${at}/input: must be JSON`);
    if (control.confirm !== undefined) str(`${at}/confirm`, control.confirm, out, 300);
  } else if (kind === "toggle" || kind === "text" || kind === "number") {
    strictKeys(at, control, [...common, "query", "field", "action", "actionInput"], out);
    query("query", "query");
    str(`${at}/field`, control.field, out, 200);
    query("action", "action");
    template();
  } else if (kind === "select") {
    strictKeys(at, control, [...common, "query", "field", "options", "optionsQuery", "action", "actionInput"], out);
    query("query", "query");
    str(`${at}/field`, control.field, out, 200);
    query("action", "action");
    template();
    const hasOptions = control.options !== undefined;
    const hasQuery = control.optionsQuery !== undefined;
    if (hasOptions === hasQuery) out.push(`${at}: give exactly one of options and optionsQuery`);
    if (hasOptions) {
      const o = control.options;
      if (!Array.isArray(o) || o.length === 0 || o.length > 200 || !o.every((i) => typeof i === "string" && i !== "")) {
        out.push(`${at}/options: must be 1..200 non-empty strings`);
      }
    }
    if (hasQuery) {
      const oq = control.optionsQuery;
      if (!isRecord(oq)) out.push(`${at}/optionsQuery: must be an object`);
      else {
        strictKeys(`${at}/optionsQuery`, oq, ["query", "field", "valueField", "labelField", "sortBy", "groupBy", "numeric"], out);
        const p = handlerRefProblem(`${at}/optionsQuery/query`, oq.query, "query", env.handlers);
        if (p) out.push(p);
        for (const k of ["field", "valueField", "labelField"]) if (oq[k] !== undefined) str(`${at}/optionsQuery/${k}`, oq[k], out, 200);
        if (oq.sortBy !== undefined && oq.sortBy !== "value" && oq.sortBy !== "label") out.push(`${at}/optionsQuery/sortBy: must be value or label`);
        if (oq.numeric !== undefined && typeof oq.numeric !== "boolean") out.push(`${at}/optionsQuery/numeric: must be true or false`);
        if (oq.groupBy !== undefined) {
          const g = oq.groupBy;
          if (!isRecord(g)) out.push(`${at}/optionsQuery/groupBy: must be { field } or { prefix }`);
          else {
            strictKeys(`${at}/optionsQuery/groupBy`, g, ["field", "prefix"], out);
            if ((g.field === undefined) === (g.prefix === undefined)) out.push(`${at}/optionsQuery/groupBy: give exactly one of field and prefix`);
            if (g.field !== undefined) str(`${at}/optionsQuery/groupBy/field`, g.field, out, 200);
            if (g.prefix !== undefined) str(`${at}/optionsQuery/groupBy/prefix`, g.prefix, out, 8);
          }
        }
      }
    }
  } else {
    out.push(`${at}/kind: must be value, button, toggle, text, number or select`);
  }
  return out;
}

/** Problems of one widget contribution of layer `layer`. */
export function widgetProblems(layer: string, widget: unknown, env: ControlEnv, at = "widget", out: string[] = []): string[] {
  if (!isRecord(widget)) return [...out, `${at}: must be an object`];
  strictKeys(at, widget, ["id", "title", "description", "navbars", "defaultOptions", "control", "defaultPlacements"], out);
  if (str(`${at}/id`, widget.id, out, 100) && !new RegExp(`^${layer}\\.[a-z0-9_]+$`).test(widget.id)) {
    out.push(`${at}/id: must be ${layer}.<name> (lowercase letters, digits, underscores)`);
  }
  str(`${at}/title`, widget.title, out, 80);
  str(`${at}/description`, widget.description, out, 500, 0);
  const nb = widget.navbars;
  if (!Array.isArray(nb) || nb.length === 0 || !nb.every((n) => (NAVBARS as readonly unknown[]).includes(n)) || new Set(nb).size !== nb.length) {
    out.push(`${at}/navbars: must be a non-empty list of unique values from global, agent`);
  }
  if (!isRecord(widget.defaultOptions) || !jsonValue(widget.defaultOptions)) out.push(`${at}/defaultOptions: must be a JSON object`);
  controlProblems(`${at}/control`, widget.control, env, out);
  if (widget.defaultPlacements !== undefined) {
    const dp = widget.defaultPlacements;
    if (!Array.isArray(dp) || dp.length > 4) out.push(`${at}/defaultPlacements: must be a list of at most 4 { navbar, slot }`);
    else {
      dp.forEach((p, i) => {
        const pat = `${at}/defaultPlacements/${i}`;
        if (!isRecord(p)) return void out.push(`${pat}: must be { navbar, slot }`);
        strictKeys(pat, p, ["navbar", "slot"], out);
        if (!(NAVBARS as readonly unknown[]).includes(p.navbar)) out.push(`${pat}/navbar: must be global or agent`);
        else if (Array.isArray(nb) && !nb.includes(p.navbar)) out.push(`${pat}/navbar: ${String(p.navbar)} is not one of the widget's navbars`);
        if (!SLOTS.includes(p.slot as never)) out.push(`${pat}/slot: must be left, center or right`);
      });
    }
  }
  return out;
}

/** Problems of a manifest's `version`, `requires` and `origin` (shared by the json parser and code manifests). */
export function metadataProblems(raw: { version?: unknown; requires?: unknown; origin?: unknown }, requireVersion: boolean, out: string[] = []): string[] {
  if (raw.version === undefined) {
    if (requireVersion) out.push(`version: required, a semver string such as "0.1.0"`);
  } else if (!isSemver(raw.version)) out.push(`version: must be a semver string such as "0.1.0"`);
  if (raw.origin !== undefined) str("origin", raw.origin, out, 300);
  if (raw.requires !== undefined) {
    const r = raw.requires;
    if (!isRecord(r)) out.push("requires: must be an object { core?, layers? }");
    else {
      strictKeys("requires", r, ["core", "layers"], out);
      if (r.core !== undefined && !isSemverRange(r.core)) out.push(`requires/core: must be a semver range such as ">=0.9.0" or "^1.2"`);
      if (r.layers !== undefined) {
        if (!Array.isArray(r.layers) || r.layers.length > 20 || !r.layers.every((n) => typeof n === "string" && LAYER_NAME.test(n))) {
          out.push("requires/layers: must be a list of at most 20 layer names");
        }
      }
    }
  }
  return out;
}

/** Why a layer cannot load given the app version and the layers loaded, or null. `core` is the app's package.json version. */
export function unmetRequirement(manifest: { requires?: LayerRequires | undefined }, core: string, loaded: ReadonlySet<string>): string | null {
  const r = manifest.requires;
  if (r === undefined) return null;
  if (r.core !== undefined && !satisfies(core, r.core)) return `requires core ${r.core}, but this factory is ${core}`;
  const missing = (r.layers ?? []).filter((n) => !loaded.has(n));
  if (missing.length > 0) return `requires ${missing.length === 1 ? "layer" : "layers"} ${missing.join(", ")}, not loaded`;
  return null;
}

const REPORT_MAX = 40;

function report(folder: string, problems: string[]): never {
  const shown = problems.slice(0, REPORT_MAX);
  const more = problems.length > shown.length ? `\n- ... and ${problems.length - shown.length} more` : "";
  throw new Error(`layer ${folder}: manifest.json is invalid:\n- ${shown.join("\n- ")}${more}`);
}

function list(at: string, v: unknown, out: string[]): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) {
    out.push(`${at}: must be a list of at most ${MAX_ITEMS}`);
    return [];
  }
  return v;
}

/**
 * Parse and validate `manifest.json` text for the layer in folder `folder`. Throws one Error listing every problem
 * with its path. Returns the manifest with defaults filled in (enabledByDefault true, env, vaultHosts, ui, capabilities).
 */
export function parseJsonManifest(folder: string, text: string): LayerManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`layer ${folder}: manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const out: string[] = [];
  if (!isRecord(raw)) return report(folder, ["the manifest must be a JSON object"]);
  strictKeys("manifest", raw, TOP_LEVEL_KEYS, out);
  if (raw.name !== folder) out.push(`name: must equal the folder name ${folder}`);
  else if (!LAYER_NAME.test(folder)) out.push(`name: must match ${LAYER_NAME}`);
  if (raw.kind !== "harness") out.push(`kind: a json layer must be "harness"`);
  str("title", raw.title, out, 80);
  str("description", raw.description, out, 1000, 0);
  if (raw.enabledByDefault !== undefined && typeof raw.enabledByDefault !== "boolean") out.push("enabledByDefault: must be true or false");

  const env: LayerEnvVar[] = [];
  list("env", raw.env, out).forEach((e, i) => {
    const at = `env/${i}`;
    if (!isRecord(e)) return void out.push(`${at}: must be an object`);
    strictKeys(at, e, ["name", "required", "secret", "description"], out);
    if (str(`${at}/name`, e.name, out, 64) && !ENV_NAME.test(e.name)) out.push(`${at}/name: must be an UPPER_SNAKE_CASE variable name`);
    if (typeof e.required !== "boolean") out.push(`${at}/required: must be true or false`);
    if (typeof e.secret !== "boolean") out.push(`${at}/secret: must be true or false`);
    str(`${at}/description`, e.description, out, 300, 0);
    env.push(e as unknown as LayerEnvVar);
  });
  // `version` defaults to 0.1.0 when absent, so a layer written before versions existed keeps loading.
  metadataProblems(raw, false, out);
  const vaultHosts = list("vaultHosts", raw.vaultHosts, out);
  vaultHosts.forEach((h, i) => str(`vaultHosts/${i}`, h, out, 200));

  // Capabilities first: controls may reference them.
  const capabilities: LayerCapability[] = [];
  list("capabilities", raw.capabilities, out).forEach((c, i) => {
    const at = `capabilities/${i}`;
    if (!isRecord(c)) return void out.push(`${at}: must be an object`);
    strictKeys(at, c, ["id", "summary", "kind", "handler", "tool", "control", "mutates"], out);
    if (str(`${at}/id`, c.id, out, 100) && !new RegExp(`^${folder}\\.[a-z0-9_]+$`).test(c.id)) out.push(`${at}/id: must be ${folder}.<name>`);
    str(`${at}/summary`, c.summary, out, 300);
    if (c.kind !== "query" && c.kind !== "action") out.push(`${at}/kind: must be query or action`);
    if (typeof c.handler !== "string" || !HANDLER_NAME.test(c.handler)) out.push(`${at}/handler: must be a handler name`);
    if (typeof c.tool !== "string" || !TOOL_NAME.test(c.tool)) out.push(`${at}/tool: must be a tool name`);
    if (c.control !== c.id) out.push(`${at}/control: must equal id`);
    if (typeof c.mutates !== "boolean") out.push(`${at}/mutates: must be true or false`);
    capabilities.push(c as unknown as LayerCapability);
  });
  const layerCaps = new Set(capabilities.map((c) => c.id));
  const cenv: ControlEnv = { layerCaps };

  const ui = raw.ui === undefined ? {} : raw.ui;
  const panels: SettingsPanelContribution[] = [];
  const widgets: WidgetContribution[] = [];
  const hotkeys: HotkeyContribution[] = [];
  if (!isRecord(ui)) out.push("ui: must be an object");
  else {
    strictKeys("ui", ui, ["settingsPanels", "widgets", "hotkeys"], out);
    const ids = new Set<string>();
    list("ui/settingsPanels", ui.settingsPanels, out).forEach((p, i) => {
      const at = `ui/settingsPanels/${i}`;
      if (!isRecord(p)) return void out.push(`${at}: must be an object`);
      strictKeys(at, p, ["id", "title", "section", "controls"], out);
      if (str(`${at}/id`, p.id, out, 100)) {
        if (!new RegExp(`^${folder}\\.[a-z0-9_]+$`).test(p.id)) out.push(`${at}/id: must be ${folder}.<name>`);
        if (ids.has(p.id)) out.push(`${at}/id: ${p.id} is used twice`);
        ids.add(p.id);
      }
      str(`${at}/title`, p.title, out, 80);
      if (!(SECTIONS as readonly unknown[]).includes(p.section)) out.push(`${at}/section: must be one of ${SECTIONS.join(", ")}`);
      if (!Array.isArray(p.controls) || p.controls.length > MAX_ITEMS) out.push(`${at}/controls: must be a list`);
      else p.controls.forEach((c, j) => controlProblems(`${at}/controls/${j}`, c, cenv, out));
      panels.push(p as unknown as SettingsPanelContribution);
    });
    const wids = new Set<string>();
    list("ui/widgets", ui.widgets, out).forEach((w, i) => {
      widgetProblems(folder, w, cenv, `ui/widgets/${i}`, out);
      const id = isRecord(w) ? w.id : undefined;
      if (typeof id === "string") {
        if (wids.has(id)) out.push(`ui/widgets/${i}/id: ${id} is used twice`);
        wids.add(id);
      }
      widgets.push(w as WidgetContribution);
    });
    list("ui/hotkeys", ui.hotkeys, out).forEach((h, i) => {
      const at = `ui/hotkeys/${i}`;
      if (!isRecord(h)) return void out.push(`${at}: must be an object`);
      strictKeys(at, h, ["action", "title", "defaultKey", "run"], out);
      if (str(`${at}/action`, h.action, out, 100) && !new RegExp(`^${folder}\\.[a-z0-9_]+$`).test(h.action)) {
        out.push(`${at}/action: must be ${folder}.<name>`);
      }
      str(`${at}/title`, h.title, out, 80);
      str(`${at}/defaultKey`, h.defaultKey, out, 40);
      const run = h.run;
      if (!isRecord(run)) out.push(`${at}/run: must be an object`);
      else if (run.kind === "action") {
        strictKeys(`${at}/run`, run, ["kind", "action", "input"], out);
        const p = handlerRefProblem(`${at}/run/action`, run.action, "action", undefined);
        if (p) out.push(p);
        if (run.input !== undefined && !jsonValue(run.input)) out.push(`${at}/run/input: must be JSON`);
      } else if (run.kind === "panel") {
        strictKeys(`${at}/run`, run, ["kind", "panel"], out);
        if (typeof run.panel !== "string" || !ids.has(run.panel)) out.push(`${at}/run/panel: must be the id of a settings panel of this layer`);
      } else out.push(`${at}/run/kind: must be action or panel`);
      hotkeys.push(h as unknown as HotkeyContribution);
    });
  }
  if (out.length > 0) report(folder, out);

  // Two controls bound to the same action with different templates would be ambiguous (the Service picks by action).
  const templates = new Map<string, string>();
  const clash: string[] = [];
  for (const c of manifestControls({ settingsPanels: panels, widgets, hotkeys })) {
    if ("actionInput" in c && c.actionInput !== undefined) {
      const text = JSON.stringify(c.actionInput);
      const seen = templates.get(c.action);
      if (seen !== undefined && seen !== text) clash.push(`action ${c.action} has two different actionInput templates`);
      templates.set(c.action, text);
    }
  }
  if (clash.length > 0) report(folder, clash);

  return {
    name: folder,
    kind: "harness",
    title: raw.title as string,
    description: raw.description as string,
    enabledByDefault: raw.enabledByDefault !== false,
    env,
    vaultHosts: vaultHosts as string[],
    ui: { settingsPanels: panels, widgets, hotkeys },
    capabilities,
    version: (raw.version as string | undefined) ?? "0.1.0",
    ...(raw.requires !== undefined ? { requires: raw.requires as LayerRequires } : {}),
    ...(typeof raw.origin === "string" ? { origin: raw.origin } : {}),
  };
}

/**
 * Checks that need the loaded module: each capability's tool is a tool of the extension and its handler exists, and
 * every control handler name resolves. Throws like `parseJsonManifest`.
 */
export function crossCheckJsonLayer(folder: string, manifest: LayerManifest, tools: readonly string[], handlers: HandlerNames): void {
  const out: string[] = [];
  const toolSet = new Set(tools);
  (manifest.capabilities ?? []).forEach((c, i) => {
    const at = `capabilities/${i}`;
    if (!toolSet.has(c.tool)) out.push(`${at}/tool: the layer's extension has no tool ${c.tool}`);
    if (!(c.kind === "query" ? handlers.queries : handlers.actions).has(c.handler)) out.push(`${at}/handler: no ${c.kind} handler ${c.handler}`);
    if (!manifestControls(manifest.ui).some((ctl) => ctl.capability === c.id)) out.push(`${at}/control: no control has capability ${c.id}`);
  });
  const env: ControlEnv = { layerCaps: new Set((manifest.capabilities ?? []).map((c) => c.id)), handlers };
  (manifest.ui.settingsPanels ?? []).forEach((p, i) => p.controls.forEach((c, j) => controlProblems(`ui/settingsPanels/${i}/controls/${j}`, c, env, out)));
  (manifest.ui.widgets ?? []).forEach((w, i) => controlProblems(`ui/widgets/${i}/control`, w.control, env, out));
  if (out.length > 0) report(folder, out);
}
