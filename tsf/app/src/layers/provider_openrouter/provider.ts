/**
 * The OpenRouter live model list (D2, DESIGN 8 "OpenRouter live list"). pi-ai's `openrouterProvider()` ships a static
 * snapshot and has no `fetchModels`, so this wraps it in a delegating `Provider` whose `getModels()` returns the merged
 * list: OpenRouter's public `GET /api/v1/models` laid over the snapshot, cached raw in tsf.sqlite `model_cache`.
 *
 * Vault rules (DESIGN 12): global `fetch` only, the key only as `Authorization: Bearer`, read from OPENROUTER_API_KEY
 * with no format check, host openrouter.ai only, no `baseUrl` override, no proxy code. Neither the key nor any proxy
 * variable is logged.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openRouterCost, type OpenRouterPricing } from "@earendil-works/pi-ai/providers/openrouter-api";
import type { Logger } from "../../core/log.ts";
import type { AppBus } from "../../shared/events.ts";
import type { ProviderLayer } from "../../agent/layer-context.ts";
import { modelInfo, type ModelCacheStore } from "../../agent/models.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "openrouter";
const FETCH_TIMEOUT_MS = 15_000;

type OrApi = "anthropic-messages" | "openai-completions";
type OrModel = Model<OrApi>;

/** The fields read from one entry of OpenRouter's `GET /models`. */
interface LiveModel {
  id: string;
  name?: string;
  context_length?: number | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  pricing?: OpenRouterPricing;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

function positive(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse the raw body; throws when it holds no model list. */
export function parseLiveList(body: string): LiveModel[] {
  const json = JSON.parse(body) as { data?: unknown };
  if (!Array.isArray(json.data)) throw new Error("OpenRouter /models: no data array");
  return json.data.filter(
    (m): m is LiveModel => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string",
  );
}

/**
 * Lay the live list over the snapshot. Live models whose output includes text are kept; a snapshot model keeps its
 * api, baseUrl, compat and thinkingLevelMap and takes the live window, output limit and price; a model the snapshot
 * lacks copies api, baseUrl and compat from a snapshot `openai-completions` model of the same vendor (else the first
 * one). Snapshot models absent from the live list are dropped.
 */
export function mergeLiveList(live: readonly LiveModel[], snapshot: readonly OrModel[]): OrModel[] {
  const byId = new Map(snapshot.map((m) => [m.id, m]));
  const completions = snapshot.filter((m) => m.api === "openai-completions");
  const out: OrModel[] = [];
  for (const l of live) {
    const outputs = l.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    const contextWindow = positive(l.context_length) ?? positive(l.top_provider?.context_length);
    const maxTokens = positive(l.top_provider?.max_completion_tokens);
    const snap = byId.get(l.id);
    if (snap) {
      out.push({
        ...snap,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(l.pricing ? { cost: openRouterCost(l.pricing) } : {}),
      });
      continue;
    }
    const vendor = l.id.split("/")[0];
    const template =
      completions.find((m) => m.id.split("/")[0] === vendor) ?? completions[0] ?? snapshot[0];
    if (!template) continue;
    const inputs = (l.architecture?.input_modalities ?? ["text"]).filter(
      (x): x is "text" | "image" => x === "text" || x === "image",
    );
    const window = contextWindow ?? 128_000;
    out.push({
      id: l.id,
      name: typeof l.name === "string" && l.name !== "" ? l.name : l.id,
      api: template.api,
      provider: template.provider,
      baseUrl: template.baseUrl,
      ...(template.compat !== undefined ? { compat: template.compat } : {}),
      reasoning: Array.isArray(l.supported_parameters) && l.supported_parameters.includes("reasoning"),
      input: inputs.length > 0 ? inputs : ["text"],
      cost: openRouterCost(l.pricing),
      contextWindow: window,
      maxTokens: maxTokens ?? Math.min(16_384, window),
    } as OrModel);
  }
  return out;
}

/**
 * A `Provider` that delegates to `base` with explicit members (never a spread) and returns `models()` from
 * `getModels()`. Optional members are copied only when the base defines them: pi-ai 1.5.0's `filterModels` is an own
 * key whose value is undefined, so an unguarded delegate would throw.
 */
export function delegatingProvider(
  base: Provider<OrApi>,
  models: () => readonly OrModel[],
): Provider<OrApi> {
  return {
    id: base.id,
    name: base.name,
    ...(base.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {}),
    ...(base.headers !== undefined ? { headers: base.headers } : {}),
    auth: base.auth,
    getModels: models,
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
    ...(base.filterModels ? { filterModels: (m, c) => base.filterModels!(m, c) } : {}),
    ...(base.filterAllModels ? { filterAllModels: (m, c) => base.filterAllModels!(m, c) } : {}),
    ...(base.fetchDeferred ? { fetchDeferred: (m, h, o) => base.fetchDeferred!(m, h, o) } : {}),
    ...(base.cancelDeferred ? { cancelDeferred: (m, h, o) => base.cancelDeferred!(m, h, o) } : {}),
  };
}

export function createOpenRouterLayer(opts: {
  cache: ModelCacheStore;
  bus?: AppBus;
  log: Logger;
  /** Test seam; default pi-ai's `openrouterProvider()`. */
  base?: Provider<OrApi>;
}): ProviderLayer {
  const base = opts.base ?? openrouterProvider();
  const snapshot = base.getModels();
  let current: readonly OrModel[] = snapshot;
  let source: "live" | "snapshot" = "snapshot";

  const cached = opts.cache.get(CACHE_KEY);
  if (cached) {
    try {
      const merged = mergeLiveList(parseLiveList(cached.body), snapshot);
      if (merged.length > 0) {
        current = merged;
        source = "live";
      }
    } catch (err) {
      opts.log.warn("openrouter.cache_unreadable", { error: String(err) });
    }
  }

  const provider = delegatingProvider(base, () => current);

  return {
    provider: provider as unknown as Provider,
    models: () => current.map((m) => modelInfo(m as Model<Api>, source)),
    async refresh(signal: AbortSignal): Promise<void> {
      const key = process.env.OPENROUTER_API_KEY?.trim();
      try {
        const res = await fetch(OPENROUTER_MODELS_URL, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
          redirect: "error",
        });
        if (!res.ok) throw new Error(`OpenRouter /models answered ${res.status}`);
        const body = await res.text();
        const merged = mergeLiveList(parseLiveList(body), snapshot);
        if (merged.length === 0) throw new Error("OpenRouter /models: no chat models");
        const fetchedAt = Date.now();
        opts.cache.put(CACHE_KEY, body, fetchedAt);
        current = merged;
        source = "live";
        opts.log.info("openrouter.models_refreshed", { count: merged.length });
        opts.bus?.publish({ type: "models.changed", count: merged.length, fetchedAt });
      } catch (err) {
        // Keep the cached list, else the snapshot.
        opts.log.warn("openrouter.refresh_failed", { error: err instanceof Error ? err.message : String(err), source });
      }
    },
  };
}
