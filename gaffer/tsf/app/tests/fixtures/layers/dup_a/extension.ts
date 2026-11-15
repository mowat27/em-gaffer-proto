import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext } from "../../../../src/agent/layer-context.ts";

/** Defines `dup_tool`, which the other dup fixture defines too: startup must fail naming both layers (D8). */
export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, defineAppTool, obj } = ctx.pi;
  return defineExtension({
    name: "dup_a",
    tools: [
      defineAppTool({
        name: "dup_tool",
        description: "A tool name two layers define.",
        parameters: obj({}),
        replay: "safe",
        run: async () => "dup_a",
      }),
    ],
  }) as Extension;
}
