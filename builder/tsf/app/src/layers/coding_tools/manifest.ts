import type { LayerManifest } from "../../shared/types.ts";

export const manifest: LayerManifest = {
  name: "coding_tools",
  kind: "harness",
  title: "Coding tools",
  description:
    "read, write, edit and bash from pi-durable. File tools stay inside the project and away from the protected paths; bash runs in the project root and is not confined by path.",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
