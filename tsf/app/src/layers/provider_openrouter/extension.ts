/**
 * provider_openrouter (DESIGN 8, D2): no tools and no sections; the layer contributes the OpenRouter provider with its
 * live model list (provider.ts).
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, ProviderLayer } from "../../agent/layer-context.ts";
import { createOpenRouterLayer } from "./provider.ts";

export function createExtension(ctx: LayerContext): Extension {
  return ctx.pi.defineExtension({ name: "provider_openrouter" });
}

export function createProvider(ctx: LayerContext): ProviderLayer {
  return createOpenRouterLayer({ cache: ctx.modelCache, bus: ctx.bus, log: ctx.log });
}
