/**
 * The model catalog (D1): one long-lived pi-ai `MutableModels`. Under `TSF_MODEL_PROVIDER=faux` it holds only the faux
 * provider (installed by `installFaux`, agent/faux.ts); otherwise each enabled provider layer's provider. The Harness
 * reads it through `models: () => catalog.models`, so a provider can be swapped without reopening.
 */
import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { Logger } from "../core/log.ts";
import type { ModelInfo, ModelRef, ThinkingLevel } from "../shared/types.ts";
import type { ProviderLayer } from "./layer-context.ts";

/** tsf.sqlite `model_cache` (D2): the raw JSON of a provider's last live list. */
export interface ModelCacheStore {
  get(provider: string): { fetchedAt: number; body: string } | undefined;
  put(provider: string, body: string, fetchedAt: number): void;
}

/** The OpenRouter default model (T9). */
export const OPENROUTER_DEFAULT: ModelRef = { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" };
/** Window used when a model is unknown. */
const FALLBACK_WINDOW = 128_000;

/** pi-ai model to the web's plain shape. */
export function modelInfo(model: Model<Api>, source: ModelInfo["source"]): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    source,
  };
}

export class ModelCatalog {
  readonly models: MutableModels;
  readonly source: "faux" | "layers";
  readonly #providers: ProviderLayer[];
  readonly #listeners = new Set<() => void>();
  readonly #log: Logger;

  constructor(models: MutableModels, source: "faux" | "layers", providers: readonly ProviderLayer[], log: Logger) {
    this.models = models;
    this.source = source;
    this.#providers = [...providers];
    this.#log = log;
  }

  /** Models of the providers currently in the catalog, in provider order. */
  list(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const provider of this.models.getProviders()) {
      const layer = this.#providers.find((p) => p.provider.id === provider.id);
      if (layer) {
        out.push(...layer.models());
        continue;
      }
      const source: ModelInfo["source"] = this.source === "faux" ? "faux" : "snapshot";
      for (const m of this.models.getModels(provider.id)) out.push(modelInfo(m, source));
    }
    return out;
  }

  info(ref: ModelRef): ModelInfo | undefined {
    const m = this.models.getModel(ref.provider, ref.modelId);
    if (!m) return undefined;
    const layer = this.#providers.find((p) => p.provider.id === ref.provider);
    const fromLayer = layer?.models().find((x) => x.id === ref.modelId);
    return fromLayer ?? modelInfo(m, this.source === "faux" ? "faux" : "snapshot");
  }

  /** The pi-ai model behind a ref, for `clampThinkingLevel`. */
  model(ref: ModelRef): Model<Api> | undefined {
    return this.models.getModel(ref.provider, ref.modelId);
  }

  /** The context window of the effective model for `ref` (null: the default model). */
  window(ref: ModelRef | null): number {
    const m = this.models.getModel(...pair(this.resolve(ref)));
    return m?.contextWindow ?? FALLBACK_WINDOW;
  }

  /** Faux: the first faux model. Layers: the OpenRouter default when listed, else the first model of the first provider. */
  defaultRef(): ModelRef {
    const providers = this.models.getProviders();
    if (this.source === "layers" && this.models.getModel(OPENROUTER_DEFAULT.provider, OPENROUTER_DEFAULT.modelId)) {
      return OPENROUTER_DEFAULT;
    }
    for (const provider of providers) {
      const first = this.models.getModels(provider.id)[0];
      if (first) return { provider: first.provider, modelId: first.id };
    }
    return this.source === "faux" ? { provider: "faux", modelId: "faux-1" } : OPENROUTER_DEFAULT;
  }

  /** `ref` when the catalog has it, else the default (the stored setting stays, so re-enabling restores it). */
  resolve(ref: ModelRef | null): ModelRef {
    if (ref && this.models.getModel(ref.provider, ref.modelId)) return { provider: ref.provider, modelId: ref.modelId };
    return this.defaultRef();
  }

  /** `level` clamped to what the model supports (pi-ai `clampThinkingLevel`); unchanged when the model is unknown. */
  clampThinking(ref: ModelRef, level: ThinkingLevel): ThinkingLevel {
    const m = this.model(ref);
    return m ? (clampThinkingLevel(m, level) as ThinkingLevel) : level;
  }

  /** Provider ids behind the catalog's provider layers (empty under faux). */
  providerIds(): string[] {
    return this.#providers.map((p) => p.provider.id);
  }

  /**
   * Refetch every provider layer's live list (spec 8.5 "refresh models"), then tell listeners. A provider's `refresh`
   * never rejects; a failure keeps its cached or shipped list. Resolves with the provider ids that were refreshed.
   */
  async refresh(signal: AbortSignal): Promise<string[]> {
    const done: string[] = [];
    await Promise.all(
      this.#providers.map(async (p) => {
        try {
          await p.refresh(signal);
          done.push(p.provider.id);
        } catch (err) {
          this.#log.warn("models.refresh_failed", { provider: p.provider.id, error: String(err) });
        }
      }),
    );
    this.changed();
    return done;
  }

  /** A provider layer was enabled: register its provider and fetch its live list in the background. */
  enableProvider(layer: ProviderLayer): void {
    if (this.source === "faux" || this.#providers.some((p) => p.provider.id === layer.provider.id)) return;
    this.#providers.push(layer);
    this.models.setProvider(layer.provider);
    void layer
      .refresh(AbortSignal.timeout(30_000))
      .catch((err: unknown) => this.#log.warn("models.refresh_failed", { provider: layer.provider.id, error: String(err) }))
      .finally(() => this.changed());
    this.changed();
  }

  /** A provider layer was disabled: its models leave the catalog. */
  disableProvider(id: string): void {
    if (this.source === "faux") return;
    const at = this.#providers.findIndex((p) => p.provider.id === id);
    if (at < 0) return;
    this.#providers.splice(at, 1);
    this.models.deleteProvider(id);
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Tell listeners the model list changed (a provider refresh, a provider added or removed). */
  changed(): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn();
      } catch (err) {
        this.#log.error("models.listener_error", { error: err });
      }
    }
  }
}

function pair(ref: ModelRef): [string, string] {
  return [ref.provider, ref.modelId];
}

/**
 * Build the catalog. Faux: an empty collection the caller fills with `installFaux` (the rules are the caller's).
 * Layers: every given provider is registered, and its live list refresh starts in the background (D2, DESIGN 3
 * step 7); a finished refresh notifies `onChange`.
 */
export async function createModelCatalog(opts: {
  faux: boolean;
  providers: readonly ProviderLayer[];
  log: Logger;
}): Promise<ModelCatalog> {
  const models = createModels();
  if (opts.faux) return new ModelCatalog(models, "faux", [], opts.log);
  for (const p of opts.providers) models.setProvider(p.provider);
  const catalog = new ModelCatalog(models, "layers", opts.providers, opts.log);
  for (const p of opts.providers) {
    void p
      .refresh(AbortSignal.timeout(30_000))
      .catch((err: unknown) => opts.log.warn("models.refresh_failed", { provider: p.provider.id, error: String(err) }))
      .finally(() => catalog.changed());
  }
  return catalog;
}
