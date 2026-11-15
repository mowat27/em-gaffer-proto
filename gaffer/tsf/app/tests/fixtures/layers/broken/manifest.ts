import type { LayerManifest } from "../../../../src/shared/types.ts";

/** Test fixture layer (its extension throws while it is created). Copied into a temp project's tsf/layers/ by the tests. */
export const manifest: LayerManifest = {
  name: "broken",
  kind: "harness",
  title: "broken",
  description: "its extension throws while it is created",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
