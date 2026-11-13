import type { LayerManifest } from "../../shared/types.ts";

export const manifest: LayerManifest = {
  name: "page_harness",
  kind: "harness",
  title: "Page harness",
  description:
    "The agent's page tools: list, read, create, update, move and delete Markdown pages and folders under tsf/pages, and select the page the centre pane shows.",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
