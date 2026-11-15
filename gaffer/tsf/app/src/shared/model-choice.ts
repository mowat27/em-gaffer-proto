/**
 * Pure rules for choosing models and thinking levels, shared by the Service, the model_controls layer and the web so
 * all three agree: model names without the vendor prefix, vendor groups, the favourites list as a picker shows it,
 * favourite edits, the thinking level a model actually gets, and the next level for the e / shift+e hotkeys.
 */
import {
  THINKING_LEVELS,
  type FavouriteModel,
  type ModelInfo,
  type ModelRef,
  type SetFavouriteInput,
  type ThinkingLevel,
} from "./types.ts";

/** A vendor prefix in a model name: "OpenAI: GPT-6.1 Terra" -> "OpenAI". */
const VENDOR_PREFIX = /^([^:]{1,40}):\s+(.+)$/;

export const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean =>
  !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;

/** The model name without its vendor prefix; the name itself when it has none. */
export function shortName(name: string): string {
  return VENDOR_PREFIX.exec(name)?.[2] ?? name;
}

/** The vendor a model belongs to: the id before its first "/", else the provider. */
export function vendorKey(model: Pick<ModelInfo, "id" | "provider">): string {
  const slash = model.id.indexOf("/");
  return slash > 0 ? model.id.slice(0, slash) : model.provider;
}

/** The vendor as people write it: the name's prefix ("AionLabs") when there is one, else the vendor key. */
export function vendorLabel(model: Pick<ModelInfo, "id" | "provider" | "name">): string {
  return VENDOR_PREFIX.exec(model.name)?.[1] ?? vendorKey(model);
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface VendorGroup {
  readonly key: string;
  readonly label: string;
  readonly models: readonly ModelInfo[];
}

/** Models grouped by vendor, groups by label and models by name, both in natural order ("3.5" before "10"). */
export function groupByVendor(models: readonly ModelInfo[]): VendorGroup[] {
  const groups = new Map<string, { label: string; models: ModelInfo[] }>();
  for (const m of models) {
    const key = vendorKey(m);
    const group = groups.get(key) ?? { label: vendorLabel(m), models: [] };
    group.models.push(m);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, models: g.models.sort((a, b) => collator.compare(a.name, b.name)) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

/** Every word of `query` appears in the model's name, id, provider or vendor (case-insensitive). Empty matches all. */
export function matchesQuery(model: ModelInfo, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const haystack = `${model.name} ${model.id} ${model.provider} ${vendorLabel(model)}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** The favourites as a picker lists them: in order, then the model in use when it is not a favourite. */
export function favouriteList(favourites: readonly ModelRef[], models: readonly ModelInfo[], current: ModelRef | null): FavouriteModel[] {
  const find = (ref: ModelRef): ModelInfo | undefined => models.find((m) => m.provider === ref.provider && m.id === ref.modelId);
  const row = (ref: ModelRef, position: number | null): FavouriteModel => {
    const info = find(ref);
    const name = info ? shortName(info.name) : ref.modelId;
    const isCurrent = sameRef(ref, current);
    const label = !info ? `${name} (not offered)` : position === null ? `${name} (current)` : name;
    return { provider: ref.provider, modelId: ref.modelId, name, label, favourite: position !== null, position, available: info !== undefined, current: isCurrent };
  };
  const rows = favourites.map((ref, i) => row(ref, i + 1));
  if (current && !favourites.some((f) => sameRef(f, current))) rows.push(row(current, null));
  return rows;
}

/**
 * The favourites after an edit. Throws a plain Error with the reason (the Service turns it into `invalid` or
 * `not_found`). Adding needs the model to be offered; removing never does, so a model that left the list can go.
 */
export function editFavourites(favourites: readonly ModelRef[], input: SetFavouriteInput, offered: (ref: ModelRef) => boolean): ModelRef[] {
  const ref: ModelRef = { provider: input.provider, modelId: input.modelId };
  const rest = favourites.filter((f) => !sameRef(f, ref));
  if (!input.favourite) return rest;
  const already = rest.length !== favourites.length;
  if (!already && !offered(ref)) throw new FavouriteError("not_found", `no such model: ${ref.provider}/${ref.modelId}; list_models shows the models of the enabled providers`);
  const position = input.position ?? (already ? favourites.findIndex((f) => sameRef(f, ref)) + 1 : 1);
  if (!Number.isInteger(position) || position < 1) throw new FavouriteError("invalid", "position must be a whole number from 1");
  const at = Math.min(position, rest.length + 1) - 1;
  return [...rest.slice(0, at), ref, ...rest.slice(at)];
}

export class FavouriteError extends Error {
  constructor(
    readonly code: "invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The level the model gets for a stored level: the same rule as pi-ai `clampThinkingLevel` (the level itself when
 * supported, else the nearest supported level above it, else the nearest below). `tests/unit/model-choice.test.ts`
 * checks it against pi-ai.
 */
export function clampLevel(supported: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (supported.includes(level)) return level;
  const at = THINKING_LEVELS.indexOf(level);
  for (let i = at; i < THINKING_LEVELS.length; i++) if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  for (let i = at - 1; i >= 0; i--) if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  return supported[0] ?? "off";
}

/**
 * The next level the model supports, one step in `direction`, wrapping at either end. The step starts from the level
 * the model gets now, so a stored level the model lacks never makes a press look like it did nothing.
 */
export function nextLevel(supported: readonly ThinkingLevel[], level: ThinkingLevel, direction: 1 | -1): ThinkingLevel {
  const levels = THINKING_LEVELS.filter((l) => supported.includes(l));
  if (levels.length === 0) return level;
  const at = levels.indexOf(clampLevel(levels, level));
  return levels[(at + direction + levels.length) % levels.length]!;
}
