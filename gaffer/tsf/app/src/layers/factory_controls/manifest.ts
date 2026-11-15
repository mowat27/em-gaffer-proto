import type { LayerManifest } from "../../shared/types.ts";

export const manifest: LayerManifest = {
  name: "factory_controls",
  kind: "harness",
  title: "Factory controls",
  description:
    "The agent's tools for the factory's own controls: the UI config (panes, navbars, widgets, hotkeys), themes and opening panels, plus the Core 4 (context, model, prompts, tools), layers, the ceiling read-out and runs (P5); the cron tools join in P6.",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
