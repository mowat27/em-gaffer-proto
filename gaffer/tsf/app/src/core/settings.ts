/**
 * Settings defaults and merge (DESIGN 4.2). The db stores only written keys; defaults are computed after the layers
 * load, so the manifests are known (T18). `layersEnabled` is never stored: it is derived from each manifest's
 * `enabledByDefault`, overridden by the stored `layerToggles`, plus every required layer.
 */
import { basename } from "node:path";
import {
  DEFAULT_COMPACTION_POINTS,
  THINKING_LEVELS,
  type CompactionPoints,
  type LayerManifest,
  type ModelRef,
  type Settings,
} from "../shared/types.ts";

/** What the settings table may hold: every Settings field except layersEnabled, plus the per-layer toggles. */
export type StoredSettings = Partial<Omit<Settings, "layersEnabled">> & { layerToggles?: Record<string, boolean> };

/** Default for `maxTurns` (T9): a runaway tool loop ends with `turn_limit`, and `continue` resumes. */
export const DEFAULT_MAX_TURNS = 60;

/** The layers a fresh install enables: required ones and those enabled by default, in load order. */
function enabledLayers(manifests: readonly LayerManifest[], toggles: Readonly<Record<string, boolean>>): string[] {
  return manifests
    .filter((m) => m.required === true || (toggles[m.name] ?? m.enabledByDefault))
    .map((m) => m.name);
}

export function settingsDefaults(projectRoot: string, manifests: readonly LayerManifest[]): Settings {
  return {
    factoryName: basename(projectRoot),
    layersEnabled: enabledLayers(manifests, {}),
    toolsDisabled: [],
    model: null,
    favouriteModels: [],
    thinkingLevel: "low",
    compaction: DEFAULT_COMPACTION_POINTS,
    systemPrompt: null,
    maxTurns: DEFAULT_MAX_TURNS,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lay the stored keys over the defaults. A stored value of the wrong shape is ignored (the default applies), so a
 * hand-edited or older row never breaks startup. `layersEnabled` is derived from the manifests and `layerToggles`.
 */
export function mergeSettings(defaults: Settings, stored: StoredSettings, manifests: readonly LayerManifest[]): Settings {
  const s = stored as Record<string, unknown>;
  const toggles: Record<string, boolean> = {};
  if (isRecord(s.layerToggles)) {
    for (const [name, on] of Object.entries(s.layerToggles)) if (typeof on === "boolean") toggles[name] = on;
  }

  const factoryName =
    typeof s.factoryName === "string" && s.factoryName.trim() !== "" ? s.factoryName : defaults.factoryName;
  const toolsDisabled =
    Array.isArray(s.toolsDisabled) && s.toolsDisabled.every((t) => typeof t === "string")
      ? (s.toolsDisabled as string[])
      : defaults.toolsDisabled;
  const model =
    s.model === null
      ? null
      : isRecord(s.model) && typeof s.model.provider === "string" && typeof s.model.modelId === "string"
        ? { provider: s.model.provider, modelId: s.model.modelId }
        : defaults.model;
  const favouriteModels = Array.isArray(s.favouriteModels) ? favourites(s.favouriteModels) : defaults.favouriteModels;
  const thinkingLevel =
    typeof s.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(s.thinkingLevel)
      ? (s.thinkingLevel as Settings["thinkingLevel"])
      : defaults.thinkingLevel;
  const compaction: CompactionPoints = isRecord(s.compaction)
    ? {
        enabled: typeof s.compaction.enabled === "boolean" ? s.compaction.enabled : defaults.compaction.enabled,
        background: num(s.compaction.background) ?? defaults.compaction.background,
        forced: num(s.compaction.forced) ?? defaults.compaction.forced,
        keepRecentTokens: num(s.compaction.keepRecentTokens) ?? defaults.compaction.keepRecentTokens,
      }
    : defaults.compaction;
  const systemPrompt =
    s.systemPrompt === null ? null : typeof s.systemPrompt === "string" ? s.systemPrompt : defaults.systemPrompt;
  const maxTurns =
    s.maxTurns === null
      ? null
      : typeof s.maxTurns === "number" && Number.isInteger(s.maxTurns) && s.maxTurns >= 1
        ? s.maxTurns
        : defaults.maxTurns;

  return {
    factoryName,
    layersEnabled: enabledLayers(manifests, toggles),
    toolsDisabled,
    model,
    favouriteModels,
    thinkingLevel,
    compaction,
    systemPrompt,
    maxTurns,
  };
}

/** The well-formed refs of a stored favourites list, first occurrence kept: a bad or repeated entry is dropped, not fatal. */
function favourites(list: readonly unknown[]): ModelRef[] {
  const out: ModelRef[] = [];
  for (const v of list) {
    if (!isRecord(v) || typeof v.provider !== "string" || v.provider === "" || typeof v.modelId !== "string" || v.modelId === "") continue;
    if (out.some((r) => r.provider === v.provider && r.modelId === v.modelId)) continue;
    out.push({ provider: v.provider, modelId: v.modelId });
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
