import type { LayerManifest } from "../../../../src/shared/types.ts";

/** Test fixture layer (defines dup_tool, like dup_b). Copied into a temp project's tsf/layers/ by the tests. */
export const manifest: LayerManifest = {
  name: "dup_a",
  kind: "harness",
  title: "dup_a",
  description: "defines dup_tool, like dup_b",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
