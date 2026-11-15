import type { LayerManifest } from "../../app/src/shared/types.ts";

/** The gaffer's colour theme, Ember, kept in git and installed in the factory at startup. */
export const manifest: LayerManifest = {
  name: "theme",
  kind: "harness",
  version: "0.1.0",
  origin: "local",
  title: "Theme",
  description:
    "Installs the Ember colour theme (theme.ts) at startup: creates it or brings its colours back in step with theme.ts, and makes it the active theme in dark mode while the factory is still on its default theme.",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
  capabilities: [],
};
