import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, LayerHandlers } from "../../../../src/agent/layer-context.ts";

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension } = ctx.pi;
  return defineExtension({ name: "counter", tools: [], sections: [] }) as Extension;
}

export function createHandlers(_ctx: LayerContext): LayerHandlers {
  let count = 0;
  return {
    queries: {
      get: () => ({ count }),
      echo: (input) => ({ input }),
    },
    actions: {
      bump: {
        replay: "safe",
        run: async (input) => {
          const by = typeof input === "object" && input !== null && !Array.isArray(input) && typeof input.by === "number" ? input.by : 1;
          count += by;
          return { count };
        },
      },
      fail: {
        replay: "unsafe",
        run: async () => {
          throw new Error("the counter refuses");
        },
      },
    },
  };
}
