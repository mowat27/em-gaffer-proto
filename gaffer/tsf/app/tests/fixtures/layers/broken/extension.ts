import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext } from "../../../../src/agent/layer-context.ts";

/** A project layer whose factory throws: it is recorded `status: "failed"` and the other layers still load. */
export function createExtension(_ctx: LayerContext): Extension {
  throw new Error("broken fixture: createExtension failed on purpose");
}
