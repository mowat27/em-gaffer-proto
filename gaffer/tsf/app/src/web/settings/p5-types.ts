/**
 * The P5 list shapes as the web reads them. `GET /api/prompts` answers `PromptList` and `GET /api/tools/describe`
 * answers `ToolDescription` (shared/types.ts); these readers take those and, leniently, other spellings of the four layers
 * (a flat list with a layer or kind field), so a naming difference does not blank the panel. Anything missing is left out.
 */

export interface SystemPromptView {
  /** The text the agent receives for layer 1. */
  readonly text: string;
  /** True when settings hold an override. */
  readonly override: boolean;
}

export interface CustomPromptView {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly enabled: boolean;
}

export interface SectionPromptView {
  readonly id: string;
  readonly layer: string;
  readonly key: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly text: string | null;
}

export interface RuntimePromptView {
  readonly id: string;
  readonly text: string;
}

export interface PromptsView {
  readonly system: SystemPromptView;
  readonly custom: readonly CustomPromptView[];
  readonly sections: readonly SectionPromptView[];
  readonly runtime: readonly RuntimePromptView[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const first = (r: Rec, keys: readonly string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
};

function system(v: unknown): SystemPromptView {
  if (typeof v === "string") return { text: v, override: false };
  if (!isRec(v)) return { text: "", override: false };
  const text = str(first(v, ["text", "effective", "value", "content"])) ?? "";
  const o = first(v, ["override", "isOverride", "overridden"]);
  const hasOverride = typeof o === "boolean" ? o : isRec(o) || typeof o === "string" ? true : v["overrideText"] != null;
  return { text, override: hasOverride };
}

function custom(r: Rec): CustomPromptView | null {
  const id = str(r["id"]);
  if (id === null) return null;
  return { id, name: str(first(r, ["name", "title"])) ?? id, text: str(first(r, ["text", "content"])) ?? "", enabled: r["enabled"] !== false };
}

function section(r: Rec): SectionPromptView | null {
  const key = str(first(r, ["key", "section"]));
  const id = str(r["id"]) ?? key;
  if (id === null) return null;
  const raw = key ?? id;
  const layer = str(r["layerName"]) ?? (raw.includes("-") ? raw.slice(0, raw.indexOf("-")) : "layer");
  const k = raw;
  return { id, layer, key: k, title: str(r["title"]) ?? k, enabled: r["enabled"] !== false, text: str(first(r, ["text", "content"])) };
}

function runtime(r: Rec): RuntimePromptView | null {
  const id = str(r["id"]);
  if (id === null) return null;
  return { id, text: str(first(r, ["text", "content"])) ?? "" };
}

function pick<T>(list: Rec[], f: (r: Rec) => T | null): T[] {
  return list.map(f).filter((x): x is T => x !== null);
}

/** Read the answer of GET /api/prompts into the four layers. */
export function readPrompts(raw: unknown): PromptsView {
  const empty: PromptsView = { system: { text: "", override: false }, custom: [], sections: [], runtime: [] };
  if (!isRec(raw)) return empty;
  const layers = isRec(raw["layers"]) ? raw["layers"] : raw;
  const flat = arr(first(raw, ["prompts", "items"]));
  if (flat.length > 0 && layers === raw && raw["system"] === undefined) {
    const kind = (r: Rec): string => String(first(r, ["kind", "layer", "type"]) ?? "");
    const of = (names: readonly string[]): Rec[] => flat.filter((r) => names.includes(kind(r)));
    const sys = of(["system", "1"])[0];
    return {
      system: sys ? system(sys) : empty.system,
      custom: pick(of(["custom", "2"]), custom),
      sections: pick(of(["extension", "extensions", "section", "3"]), section),
      runtime: pick(of(["runtime", "4"]), runtime),
    };
  }
  return {
    system: system(layers["system"]),
    custom: pick(arr(layers["custom"]), custom),
    sections: pick(arr(first(layers, ["extensions", "extension", "sections"])), section),
    runtime: pick(arr(layers["runtime"]), runtime),
  };
}

/** The text of GET /api/prompts/get (a string, or an object with the text in `text`). */
export function readPromptText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isRec(raw)) return str(first(raw, ["text", "content", "value", "rendered"])) ?? JSON.stringify(raw, null, 2);
  return "";
}

/** The code of GET /api/tools/describe for the chosen syntax: a string, or an object holding it, or any JSON. */
export function readDescribe(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isRec(raw)) {
    const direct = first(raw, ["text", "signature", "code", "schema", "parameters", "definition"]);
    if (typeof direct === "string") return direct;
    if (direct !== undefined) return JSON.stringify(direct, null, 2);
    return JSON.stringify(raw, null, 2);
  }
  return raw === undefined ? "" : JSON.stringify(raw, null, 2);
}
