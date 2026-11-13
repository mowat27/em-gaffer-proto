import type { LayerManifest } from "../../../../src/shared/types.ts";

/** Test fixture layer (defines dup_tool, like dup_a). Copied into a temp project's tsf/layers/ by the tests. */
export const manifest: LayerManifest = {
  name: "dup_b",
  kind: "harness",
  title: "dup_b",
  description: "defines dup_tool, like dup_a",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
