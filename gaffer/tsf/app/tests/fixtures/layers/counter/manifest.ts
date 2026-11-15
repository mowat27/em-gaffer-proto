import type { LayerManifest } from "../../../../src/shared/types.ts";

/** Test fixture layer (P4): a counter with a query, two actions, a widget and a hotkey, for the layer handler tests. */
export const manifest: LayerManifest = {
  name: "counter",
  kind: "harness",
  title: "Counter",
  description: "a project layer with one query, two actions, a widget and a hotkey",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: {
    settingsPanels: [],
    widgets: [
      {
        id: "counter.value",
        title: "Counter",
        description: "Shows the counter",
        navbars: ["global"],
        defaultOptions: { fullWidth: false },
        control: { kind: "value", label: "Count", query: "get", field: "count", capability: "counter.get" },
      },
    ],
    hotkeys: [{ action: "counter.bump", title: "Bump the counter", defaultKey: "b", run: { kind: "action", action: "bump" } }],
  },
};
