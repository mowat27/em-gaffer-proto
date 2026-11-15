import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext } from "../../../../src/agent/layer-context.ts";

/** Counts executions on globalThis so a test can prove a blocked call never ran. */
export const RUNS_KEY = "__tsfOutsideToolRuns";

/** One tool (`outside_tool`) and one section (`outside-note`), for the registry and ceiling-guard tests. */
export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, defineAppTool, obj, section } = ctx.pi;
  return defineExtension({
    name: "outside",
    tools: [
      defineAppTool({
        name: "outside_tool",
        description: "A project layer's tool; the ceiling tests deny it.",
        parameters: obj({}),
        replay: "safe",
        run: async () => {
          const g = globalThis as Record<string, unknown>;
          g[RUNS_KEY] = ((g[RUNS_KEY] as number | undefined) ?? 0) + 1;
          return { ran: true };
        },
      }),
    ],
    sections: [section("outside-note", () => "The outside layer offers outside_tool.")],
  }) as Extension;
}
