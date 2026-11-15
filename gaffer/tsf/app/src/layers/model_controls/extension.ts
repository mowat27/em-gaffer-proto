/**
 * model_controls (DESIGN 8): no tools and no prompt section (the agent has list_favourite_models, set_favourite_model,
 * set_model and set_thinking_level in factory_controls). Its two actions back the hotkeys: `use_favourite` picks the
 * favourite at an index and `cycle_thinking` steps through the levels the current model supports. Each runs under the
 * Service's `layer:model_controls` lock, so quick presses apply in order.
 *
 * The query `current_model` is the model the agent uses (the catalog default while none is stored, which
 * `core:settings.get` reports as null), so the Model picker never shows a blank. The model in use changes with the
 * settings and the catalog, so the layer announces `layer.changed` on those events and its controls re-read.
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, LayerHandlers } from "../../agent/layer-context.ts";
import { ServiceError } from "../../core/errors.ts";
import { nextLevel } from "../../shared/model-choice.ts";
import { THINKING_LEVELS, type Json, type Origin } from "../../shared/types.ts";

export function createExtension(ctx: LayerContext): Extension {
  return ctx.pi.defineExtension({ name: "model_controls" }) as Extension;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createHandlers(ctx: LayerContext): LayerHandlers {
  const svc = () => ctx.service();

  const useFavourite = async (input: Json, origin: Origin): Promise<Json> => {
    const index = isRecord(input) ? input.index : undefined;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1) throw new ServiceError("invalid", "index must be a whole number from 1");
    const favourites = svc().getSettings().favouriteModels;
    const ref = favourites[index - 1];
    if (!ref) {
      const have = favourites.length === 0 ? "there are no favourites yet" : `there ${favourites.length === 1 ? "is 1 favourite" : `are ${favourites.length} favourites`}`;
      throw new ServiceError("not_found", `No favourite model ${index}: ${have}. Star models in Settings > Core 4 > Model (press p).`);
    }
    if (!svc().listModels().some((m) => m.provider === ref.provider && m.id === ref.modelId)) {
      throw new ServiceError("not_found", `Favourite ${index} (${ref.modelId}) is not offered by the enabled providers now.`);
    }
    return (await svc().setModel(ref, origin)) as unknown as Json;
  };

  const cycleThinking = async (input: Json, origin: Origin): Promise<Json> => {
    const direction = isRecord(input) ? input.direction : undefined;
    if (direction !== 1 && direction !== -1) throw new ServiceError("invalid", "direction must be 1 or -1");
    const current = svc().listFavouriteModels().find((m) => m.current);
    const info = current ? svc().listModels().find((m) => m.provider === current.provider && m.id === current.modelId) : undefined;
    const level = nextLevel(info?.thinkingLevels ?? THINKING_LEVELS, svc().getSettings().thinkingLevel, direction);
    return (await svc().setThinkingLevel(level, origin)) as unknown as Json;
  };

  const currentModel = (): Json => {
    const current = svc().listFavouriteModels().find((m) => m.current);
    return current ? { provider: current.provider, modelId: current.modelId, name: current.name } : null;
  };

  ctx.bus.subscribe((event) => {
    const moved = (event.type === "settings.changed" && event.keys.includes("model")) || event.type === "models.changed";
    if (moved) ctx.bus.publish({ type: "layer.changed", layer: "model_controls", by: event.type === "settings.changed" ? event.by : "system" });
  });

  return {
    queries: { current_model: currentModel },
    actions: {
      use_favourite: { replay: "safe", run: useFavourite },
      cycle_thinking: { replay: "unsafe", run: cycleThinking },
    },
  };
}
