import type { LayerManifest } from "../../../../src/shared/types.ts";

/** Test fixture layer (a project layer with one tool and one section, for the ceiling tests). Copied into a temp project's tsf/layers/ by the tests. */
export const manifest: LayerManifest = {
  name: "outside",
  kind: "harness",
  title: "outside",
  description: "a project layer with one tool and one section, for the ceiling tests",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
