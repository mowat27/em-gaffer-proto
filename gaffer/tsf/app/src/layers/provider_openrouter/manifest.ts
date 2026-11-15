import type { LayerManifest } from "../../shared/types.ts";

export const manifest: LayerManifest = {
  name: "provider_openrouter",
  kind: "provider",
  title: "OpenRouter",
  description: "Models through OpenRouter, with the live model list (fetched, cached, merged over pi-ai's snapshot).",
  enabledByDefault: true,
  env: [
    {
      name: "OPENROUTER_API_KEY",
      required: true,
      secret: true,
      description: "OpenRouter key (required outside faux). On a vault-routed VM the value is agent-vault.",
    },
  ],
  vaultHosts: ["openrouter.ai"],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
  providerId: "openrouter",
};
