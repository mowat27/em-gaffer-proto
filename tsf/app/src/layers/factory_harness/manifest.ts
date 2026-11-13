import type { LayerManifest } from "../../shared/types.ts";

export const manifest: LayerManifest = {
  name: "factory_harness",
  kind: "harness",
  title: "Factory harness",
  description: "The factory's system prompt and identity, the permissions-ceiling guard (P2) and jev (P7).",
  required: true,
  enabledByDefault: true,
  env: [
    {
      name: "TYPESAFE_API_KEY",
      required: false,
      secret: true,
      description: "TypeSafe System One key for jev judgments (P7). On a vault-routed VM the value is agent-vault.",
    },
  ],
  vaultHosts: ["api.typesafe.ai"],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
};
