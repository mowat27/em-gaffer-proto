import { THINKING_LEVELS, type LayerManifest } from "../../shared/types.ts";

/**
 * model_controls (DESIGN 8, built-in layers): quick model, thinking and context controls over core capabilities. The
 * favourites themselves are core settings (`models.favourites`, `model.favourite`), so the Model panel and the agent
 * reach them with the layer off; switching the layer off removes only these widgets and keys.
 */
export const manifest: LayerManifest = {
  name: "model_controls",
  kind: "harness",
  title: "Model controls",
  description:
    "Quick controls for the model: the Favourite and Thinking pickers in the top bar, Compact in the agent bar, and the keys p (open the Model settings), 1 to 3 (favourites) and e / shift+e (thinking level).",
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: {
    settingsPanels: [],
    widgets: [
      {
        id: "model_controls.favourite",
        title: "Favourite model",
        description: "Switch between your favourite models. Lists the model in use too, when it is not a favourite.",
        navbars: ["global", "agent"],
        defaultOptions: {},
        defaultPlacements: [{ navbar: "global", slot: "right" }],
        control: {
          kind: "select",
          label: "Model",
          query: "current_model",
          field: "modelId",
          optionsQuery: { query: "core:models.favourites", valueField: "modelId", labelField: "label" },
          action: "core:model.set",
          actionInput: { modelId: "$value" },
          capability: "model.set",
        },
      },
      {
        id: "model_controls.thinking",
        title: "Thinking level",
        description: "How much the model thinks before it answers. A model gets the nearest level it supports.",
        navbars: ["global", "agent"],
        defaultOptions: {},
        defaultPlacements: [{ navbar: "global", slot: "right" }],
        control: {
          kind: "select",
          label: "Thinking",
          query: "core:settings.get",
          field: "thinkingLevel",
          options: THINKING_LEVELS,
          action: "core:thinking.set",
          actionInput: { level: "$value" },
          capability: "thinking.set",
        },
      },
      {
        id: "model_controls.compact",
        title: "Compact",
        description: "Summarise older turns now to free context, after a confirmation.",
        navbars: ["agent", "global"],
        defaultOptions: {},
        defaultPlacements: [{ navbar: "agent", slot: "right" }],
        control: {
          kind: "button",
          label: "Compact",
          action: "core:compaction.compact",
          input: {},
          confirm: "Summarise the older turns of this conversation now? The agent keeps working while it summarises.",
          capability: "compaction.compact",
        },
      },
    ],
    hotkeys: [
      { action: "model_controls.open_models", title: "Open the Model settings", defaultKey: "p", run: { kind: "panel", panel: "core4.model" } },
      { action: "model_controls.favourite_1", title: "Use favourite model 1", defaultKey: "1", run: { kind: "action", action: "use_favourite", input: { index: 1 } } },
      { action: "model_controls.favourite_2", title: "Use favourite model 2", defaultKey: "2", run: { kind: "action", action: "use_favourite", input: { index: 2 } } },
      { action: "model_controls.favourite_3", title: "Use favourite model 3", defaultKey: "3", run: { kind: "action", action: "use_favourite", input: { index: 3 } } },
      { action: "model_controls.thinking_up", title: "Next thinking level", defaultKey: "e", run: { kind: "action", action: "cycle_thinking", input: { direction: 1 } } },
      { action: "model_controls.thinking_down", title: "Previous thinking level", defaultKey: "shift+e", run: { kind: "action", action: "cycle_thinking", input: { direction: -1 } } },
    ],
  },
};
