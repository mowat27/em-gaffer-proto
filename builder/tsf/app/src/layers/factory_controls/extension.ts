/**
 * factory_controls (DESIGN 8, spec 8.2 to 8.4): the agent's tools for the factory's own controls. P4: the UI config,
 * widgets, hotkeys, themes and `open_panel`. P5: the Core 4 (context and compaction, model and thinking, the four prompt
 * layers, the tool matrix, layers, the ceiling read-out and the run list). Each tool calls the FactoryService with `{ by: "agent", callId }`, so the
 * UI, the routes and the agent share one write path (principle 2). P6 adds the cron tools (`cron` below).
 *
 * Replay (DESIGN 7 table): reads and idempotent sets are `safe`; `add_widget` and `create_theme` are keyed by the call
 * (the placement id comes from the call id, a replayed create finds its own row) and so `safe`; `remove_widget`,
 * `fix_theme` and `delete_theme` are `unsafe` (at most once). P5: `compact` and `delete_custom_prompt` are `unsafe`;
 * `create_custom_prompt` and `append_runtime_prompt` key their row on the call id (`safe`); every other Core 4 read or
 * set is `safe` (the same input gives the same state). P6: `list_crons`, `update_cron` (a set) are `safe`; `create_cron`
 * keys its row on the call id and `run_cron_now` keys its request id on it (`cron-now:<cronId>:<callId>`), so both are
 * `safe`; `delete_cron` is `unsafe` (at most once). P9: `get_settings`, `list_layer_files`, `read_layer_file`,
 * `write_layer_file` (same content, same state), `reload_layers` and `define_widget` (an upsert) are `safe`;
 * `create_layer`, `delete_layer`, `delete_layer_file` and `undefine_widget` fail on a second run, so they are `unsafe`.
 * Liquid core: `rebuild_web` (a build is idempotent), `restart_factory` (a replayed call id restarts nothing a second
 * time) and `screenshot` (a new file each time, nothing else changes) are `safe`.
 * `export_layer` rewrites the same archive (`safe`); `import_layer` fails on a second run without `replace` (`unsafe`).
 *
 * The section key is `factory_controls-rules` (pi-durable 1.5.0 section keys match /^[a-z][a-z0-9_-]*$/).
 */
import { readFile } from "node:fs/promises";
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext } from "../../agent/layer-context.ts";
import type { Json, Origin } from "../../shared/types.ts";

/** Stable text: no clock, nothing that changes between requests (the prompt cache). */
export const RULES_TEXT = [
  "You can change the factory's own interface with the factory_controls tools; the open page applies every change at once, with no reload.",
  "UI config: get_ui_config shows the whole document and its version. update_ui_config takes a JSON Merge Patch (objects merge, arrays replace, null deletes) for panes, navbars, hotkeys and animations; pass baseVersion from get_ui_config to detect a change made meanwhile. It cannot change the theme: use set_theme.",
  "Widgets sit in the 'global' navbar (top bar) or the 'agent' navbar (agent pane header), in a slot (left, center, right). list_widgets shows the widget types you can place (context_bar, agent_status, factory_name, cron_status, and ones layers add) and what is placed, with each placement id. Use add_widget, move_widget, set_widget_options (for example fullWidth) and remove_widget with those ids.",
  "Hotkeys: list_hotkeys shows the actions and keys; set_hotkey binds one key (optionally after mod+, shift+ or mod+shift+) to an action. A key can serve only one action.",
  "Themes: list_themes shows the Precision Weave themes and the custom ones; the active theme is theme.name in the UI config. set_theme switches theme (and optionally mode light, dark or system). To change colours, create_theme on a Precision Weave base (seeds brand, accent, ai and ai-to take one colour or a light and dark pair; tokens are pw-ui token names without --pw-), then set_theme_values to refine it; every change applies live. check_theme reports contrast warnings (warnings never block a change) and fix_theme writes pw-ui's fixes into a custom theme. Precision Weave themes cannot be edited. delete_theme removes a custom theme (the active one falls back to Neon).",
  "Cron prompts (spec 8.6): list_crons shows the entries with next and last run. create_cron takes a name, a cron expression (5 fields, minute first, for example '*/15 * * * *'; 6 with seconds first) and the prompt to send; update_cron changes any of them or switches an entry on or off; delete_cron removes one; run_cron_now sends an entry's prompt at once. A fired prompt joins this conversation as a cron message, behind a turn in progress.",
  "open_panel opens Settings (optionally at a section) or the cron list in the user's open page.",
  "Core 4: get_context shows tokens against the window and the two compaction points (absolute token counts, clamped to the model's window); set_compaction changes them and compact summarises older turns now (optionally with instructions). list_models, refresh_models, set_model and set_thinking_level (off, minimal, low, medium, high, xhigh, max; a model that lacks a level gets the nearest one it supports) choose the model, applied from the next request. list_favourite_models and set_favourite_model read and edit the user's ordered favourite models (the first three are the 1, 2 and 3 keys).",
  "Prompts have four layers: the system prompt (set_system_prompt, null restores the default), custom prompts (create_custom_prompt, update_custom_prompt, delete_custom_prompt, toggle_prompt with id custom:<id>), extension sections read-only with on/off (toggle_prompt with id section:<key>) and runtime prompts added to the next request (append_runtime_prompt, remove_runtime_prompt, clear_runtime_prompts). list_prompts shows the ids; get_prompt shows one in full.",
  "Tools and layers: list_tools shows every tool inside the permissions ceiling by layer with its enabled flag, describe_tool shows its description, JSON Schema and TypeScript signature, set_tool_enabled switches one on or off. list_layers and set_layer_enabled do the same for layers (factory_harness is required). You may switch off your own tools, including these controls; the user can switch them back on in Settings. You can switch a tool on again only if it is inside the ceiling (get_ceiling), which no tool can change. list_runs and get_run show recorded runs.",
  "Layers you can author: create_layer makes a declarative project layer (a folder with manifest.json, no code). define_widget adds or replaces a widget type in it (id <layer>.<name>, title, description, navbars, defaultOptions, one control), then add_widget places it. A control's query or action may be core:<capabilityId> to reuse a factory capability: a model picker is { kind: 'select', label: 'Model', query: 'core:settings.get', field: 'model.modelId', optionsQuery: { query: 'core:models.list', valueField: 'id', labelField: 'name' }, action: 'core:model.set', actionInput: { modelId: '$value' }, capability: 'model.set' }. Prompt sections come from prompts/<name>.md files (write_layer_file); the first '# ' heading is the title. list_layer_files and read_layer_file show any layer (built-ins read-only); write_layer_file and delete_layer_file change project layers (.json, .ts, .md only); delete_layer removes one. Every change is live at once; reload_layers rescans after outside edits. A layer with manifest.ts (code) is edited only with write_layer_file. get_settings reads the settings document. A manifest.json has a semver version (create_layer writes 0.1.0) and an origin, and may say requires: { core: '>=0.9.0', layers: ['other'] }: an unmet requirement loads the layer as failed with the reason. A widget's defaultPlacements [{ navbar, slot }] place it once when the layer loads, never again after the user removes it. export_layer writes a layer as a .tgz in tsf/data/exports; import_layer installs one from a local .tgz or folder or an https URL (replace: true overwrites). A select's optionsQuery may add sortBy ('value' or 'label'), numeric: true and groupBy ({ field } or { prefix: '/' }) to order and group the options.",
  "The factory's own source is yours to change. It is at tsf/app inside the project: the web app in src/web, the server in src/server, the core in src/core and src/agent, the built-in layers in src/layers, dependencies in package.json (never edit node_modules; file tools cannot reach tsf/app/node_modules or tsf/app/.tsf-base. To add a dependency edit package.json and call restart_factory: the launcher installs it). Edits to src/web and src/shared rebuild live a moment after the last change and every open page reloads; if the build fails the last good build keeps serving, so call rebuild_web to see the error (the page also shows a banner). Edits to the server or the core need restart_factory (the conversation continues after it). Prefer a layer for a feature; when the core lacks an extension point a feature needs, add the extension point to the core and ship the feature as a layer, so both can be shared (export_layer). Use screenshot to check the rendered UI (selector, mode light or dark). tsf/app/.tsf-base records the skill version the copy came from, so core edits are a diff against it. A project made with --no-app has no tsf/app and runs the shared app: then there is no source to edit.",
].join("\n");

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section, defineAppTool, obj, str, int, bool, opt, oneOf, map, unknown, nullable } = ctx.pi;
  const origin = (callId: string): Origin => ({ by: "agent", callId });
  const svc = () => ctx.service();
  const json = (value: unknown): Json => value as Json;

  const navbar = () => oneOf(["global", "agent"]);
  const slot = () => oneOf(["left", "center", "right"]);
  const themeName = (description: string) => str({ description, minLength: 1, maxLength: 64 });
  const seeds = () =>
    map(unknown(), {
      description:
        "Seed colours: keys brand, accent, ai, ai-to. A value is one opaque colour for both modes ('#336699', 'hsl(210 50% 40%)') or { light, dark }. null deletes a seed.",
    });
  const tokens = () =>
    map(unknown(), {
      description:
        "Token overrides by pw-ui token name without --pw- (for example canvas, surface, text, border). A value is one value for both modes or { light, dark }; a colour, shadow, radius or font as pw-ui accepts it, or '{other-token}' to follow another token. null deletes an override.",
    });

  const MODEL_FIELDS = ["provider", "id", "name", "contextWindow", "reasoning", "thinkingLevels"] as const;

  const core4 = [
    defineAppTool({
      name: "get_context",
      description:
        "Read the context: tokens used against the model's window, the stored compaction points and where compaction really starts after clamping to the window, and whether a compaction is running.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().getContext()),
    }),
    defineAppTool({
      name: "set_compaction",
      description:
        "Change the compaction points (any of them): background (background compaction starts at this many context tokens; at or above forced it is off), forced (the next request waits for a summary at this many tokens), keepRecentTokens (recent tokens kept verbatim) and enabled. Both points are clamped to the current model's context window when read.",
      parameters: obj({
        enabled: opt(bool({ description: "Compaction on or off" })),
        background: opt(int({ description: "Background compaction point, tokens", minimum: 0 })),
        forced: opt(int({ description: "Forced compaction point, tokens (at least 1000)", minimum: 1000 })),
        keepRecentTokens: opt(int({ description: "Recent tokens kept as they are", minimum: 0 })),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().setCompaction(args as never, origin(api.callId))),
    }),
    defineAppTool({
      name: "compact",
      description:
        "Compact the conversation now: older turns are summarised while you keep working, and the summary is placed at the next boundary. Optional instructions steer the summary.",
      parameters: obj({ instructions: opt(str({ description: "What the summary should keep", maxLength: 2000 })) }),
      replay: "unsafe",
      run: async (args, api) =>
        json(await svc().compact({ ...(args.instructions !== undefined ? { instructions: args.instructions } : {}) }, origin(api.callId))),
    }),
    defineAppTool({
      name: "list_models",
      description:
        "List the models of the enabled provider layers (provider, id, name, context window, reasoning, supported thinking levels). Use filter to narrow a long list; the answer says how many there are in all.",
      parameters: obj({
        filter: opt(str({ description: "Keep models whose id or name contains this text (case-insensitive)", maxLength: 100 })),
        limit: opt(int({ description: "Most models to return (default 30)", minimum: 1, maximum: 200 })),
      }),
      replay: "safe",
      run: async (args) => {
        const needle = args.filter?.toLowerCase();
        const all = svc().listModels();
        const hits = all.filter((m) => needle === undefined || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
        const models = hits.slice(0, args.limit ?? 30).map((m) => Object.fromEntries(MODEL_FIELDS.map((k) => [k, m[k]])));
        return json({ total: all.length, matching: hits.length, shown: models.length, models });
      },
    }),
    defineAppTool({
      name: "refresh_models",
      description: "Refetch the live model lists of the enabled provider layers (for example OpenRouter).",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => json(await svc().refreshModels(origin(api.callId))),
    }),
    defineAppTool({
      name: "set_model",
      description: "Switch the model (provider and model id from list_models). Applied with conversation.configure from the next request; the thinking level is clamped to what the model supports.",
      parameters: obj({
        provider: str({ description: "Provider id, for example openrouter", minLength: 1, maxLength: 64 }),
        modelId: str({ description: "Model id from list_models", minLength: 1, maxLength: 200 }),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().setModel({ provider: args.provider, modelId: args.modelId }, origin(api.callId))),
    }),
    defineAppTool({
      name: "set_thinking_level",
      description:
        "Set the thinking level: off, minimal, low, medium, high, xhigh or max. The setting is stored as given; the model gets the nearest level it supports (the answer shows both).",
      parameters: obj({ level: oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"]) }),
      replay: "safe",
      run: async (args, api) => json(await svc().setThinkingLevel(args.level, origin(api.callId))),
    }),
    defineAppTool({
      name: "list_favourite_models",
      description:
        "List the favourite models in order (the user's 1, 2 and 3 keys pick the first three), then the model in use when it is not a favourite. Each row says whether it is still offered.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listFavouriteModels()),
    }),
    defineAppTool({
      name: "set_favourite_model",
      description:
        "Add a model to the favourites (favourite: true; at position, 1 = the front, which is the default for a new one), move a favourite (true with a new position) or remove one (favourite: false). The answer is the new list.",
      parameters: obj({
        provider: str({ description: "Provider id, for example openrouter", minLength: 1, maxLength: 64 }),
        modelId: str({ description: "Model id from list_models", minLength: 1, maxLength: 200 }),
        favourite: bool({ description: "true to add or move, false to remove" }),
        position: opt(int({ description: "1-based place in the favourites", minimum: 1, maximum: 1000 })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().setFavouriteModel(
            { provider: args.provider, modelId: args.modelId, favourite: args.favourite, ...(args.position !== undefined ? { position: args.position } : {}) },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "list_prompts",
      description:
        "List the four prompt layers: the system prompt, custom prompts, extension sections (read-only, with on/off) and runtime prompts, with their ids. Extension section text is left out; use get_prompt.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(await svc().listPrompts()),
    }),
    defineAppTool({
      name: "get_prompt",
      description: "Read one prompt in full by id (system, custom:<id>, section:<key>, runtime:<id>). An extension section is rendered.",
      parameters: obj({ id: str({ description: "Prompt id from list_prompts", minLength: 1, maxLength: 200 }) }),
      replay: "safe",
      run: async (args) => json(await svc().getPrompt({ id: args.id })),
    }),
    defineAppTool({
      name: "set_system_prompt",
      description:
        "Replace the system prompt (prompt layer 1). {{factoryName}} and {{projectRoot}} are filled in. Pass null to restore the default shipped with the factory.",
      parameters: obj({ text: nullable(str({ description: "The new system prompt, or null for the default", maxLength: 50_000 })) }),
      replay: "safe",
      run: async (args, api) => json(await svc().setSystemPrompt({ text: args.text }, origin(api.callId))),
    }),
    defineAppTool({
      name: "create_custom_prompt",
      description: "Add a named custom prompt (layer 2). Enabled prompts are added to every request, in creation order. Names are unique.",
      parameters: obj({
        name: str({ description: "Short unique name, one line", minLength: 1, maxLength: 64 }),
        text: str({ description: "The prompt text", minLength: 1, maxLength: 20_000 }),
        enabled: opt(bool({ description: "On from the start (default true)" })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().createCustomPrompt(
            { name: args.name, text: args.text, ...(args.enabled !== undefined ? { enabled: args.enabled } : {}) },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "update_custom_prompt",
      description: "Rename a custom prompt or change its text (id from list_prompts).",
      parameters: obj({
        id: str({ description: "custom:<id>", minLength: 1, maxLength: 200 }),
        name: opt(str({ description: "New name", minLength: 1, maxLength: 64 })),
        text: opt(str({ description: "New text", minLength: 1, maxLength: 20_000 })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().updateCustomPrompt(
            { id: args.id, ...(args.name !== undefined ? { name: args.name } : {}), ...(args.text !== undefined ? { text: args.text } : {}) },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "delete_custom_prompt",
      description: "Delete a custom prompt (id from list_prompts). Use toggle_prompt to keep it but switch it off.",
      parameters: obj({ id: str({ description: "custom:<id>", minLength: 1, maxLength: 200 }) }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().deleteCustomPrompt({ id: args.id }, origin(api.callId))),
    }),
    defineAppTool({
      name: "toggle_prompt",
      description:
        "Switch a custom prompt (custom:<id>) or an extension prompt section (section:<key>) on or off. The system prompt and runtime prompts cannot be switched off. Applies from the next request.",
      parameters: obj({
        id: str({ description: "custom:<id> or section:<key> from list_prompts", minLength: 1, maxLength: 200 }),
        enabled: bool({ description: "true for on, false for off" }),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().togglePrompt({ id: args.id, enabled: args.enabled }, origin(api.callId))),
    }),
    defineAppTool({
      name: "append_runtime_prompt",
      description:
        "Append text to the prompt (layer 4). It is added after every other section from the next request and stays until removed or cleared.",
      parameters: obj({ text: str({ description: "The text to add", minLength: 1, maxLength: 10_000 }) }),
      replay: "safe",
      run: async (args, api) => json(await svc().appendRuntimePrompt({ text: args.text }, origin(api.callId))),
    }),
    defineAppTool({
      name: "remove_runtime_prompt",
      description: "Remove one runtime prompt (id from list_prompts).",
      parameters: obj({ id: str({ description: "runtime:<id>", minLength: 1, maxLength: 200 }) }),
      replay: "safe",
      run: async (args, api) => json(await svc().removeRuntimePrompt({ id: args.id }, origin(api.callId))),
    }),
    defineAppTool({
      name: "clear_runtime_prompts",
      description: "Remove every runtime prompt.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => json(await svc().clearRuntimePrompts(origin(api.callId))),
    }),
    defineAppTool({
      name: "list_tools",
      description:
        "List every tool inside the permissions ceiling, grouped by layer, with enabled (not switched off) and offered (the model gets it on the next request) flags. Tools the ceiling removes are not listed. Use describe_tool for parameters.",
      parameters: obj({}),
      replay: "safe",
      run: async () => {
        const layers = svc().listLayers();
        const all = svc().listTools();
        return json(
          layers
            .map((l) => ({
              layer: l.name,
              title: l.title,
              enabled: l.enabled,
              tools: all
                .filter((t) => t.layer === l.name)
                .map((t) => ({ name: t.name, description: t.description, enabled: t.enabled, offered: t.offered, replay: t.replay })),
            }))
            .filter((g) => g.tools.length > 0),
        );
      },
    }),
    defineAppTool({
      name: "describe_tool",
      description: "Describe one tool: description, JSON Schema of its parameters and a TypeScript signature (or only one, with syntax).",
      parameters: obj({
        name: str({ description: "Tool name from list_tools", minLength: 1, maxLength: 64 }),
        syntax: opt(oneOf(["json", "typescript"])),
      }),
      replay: "safe",
      run: async (args) => json(svc().describeTool({ name: args.name, ...(args.syntax !== undefined ? { syntax: args.syntax } : {}) })),
    }),
    defineAppTool({
      name: "set_tool_enabled",
      description:
        "Switch a tool on or off (name from list_tools). It applies from the next request with no restart. You may switch off your own tools, including this one and set_layer_enabled; only the user can then switch them back on, in Settings. A tool outside the permissions ceiling cannot be enabled.",
      parameters: obj({
        name: str({ description: "Tool name", minLength: 1, maxLength: 64 }),
        enabled: bool({ description: "true for on, false for off" }),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().setToolEnabled({ name: args.name, enabled: args.enabled }, origin(api.callId))),
    }),
    defineAppTool({
      name: "list_layers",
      description: "List the layers in load order: kind, whether enabled and required, status, the tools inside the ceiling, tools the ceiling removed, prompt sections and environment variables.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listLayers().map(({ ui: _ui, ...layer }) => layer)),
    }),
    defineAppTool({
      name: "set_layer_enabled",
      description:
        "Switch a layer on or off (name from list_layers). factory_harness is required and cannot be disabled. Disabling a layer removes its tools and prompt sections from the next request; the last provider layer must stay on. The user can switch layers back on in Settings.",
      parameters: obj({
        name: str({ description: "Layer name", minLength: 1, maxLength: 64 }),
        enabled: bool({ description: "true for on, false for off" }),
      }),
      replay: "safe",
      run: async (args, api) => {
        const layer = await svc().setLayerEnabled({ name: args.name, enabled: args.enabled }, origin(api.callId));
        const { ui: _ui, ...rest } = layer;
        return json(rest);
      },
    }),
    defineAppTool({
      name: "get_ceiling",
      description:
        "Read the permissions ceiling: which tools the factory may ever use. It is read once at startup and cannot be changed from here.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().getCeiling()),
    }),
    defineAppTool({
      name: "list_runs",
      description: "List recorded agent runs, newest first (trigger, status, model, turns, tool calls, tokens, cost).",
      parameters: obj({
        limit: opt(int({ description: "Most runs to return (default 20)", minimum: 1, maximum: 200 })),
        before: opt(int({ description: "Only runs with an id below this", minimum: 1 })),
      }),
      replay: "safe",
      run: async (args) =>
        json(svc().listRuns({ ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.before !== undefined ? { before: args.before } : {}) })),
    }),
    defineAppTool({
      name: "get_run",
      description: "Read one recorded run with its tool calls (id from list_runs).",
      parameters: obj({ id: int({ description: "Run id", minimum: 0 }) }),
      replay: "safe",
      run: async (args) => json(svc().getRun(args.id)),
    }),
  ];

  const tools = [
    defineAppTool({
      name: "get_ui_config",
      description: "Read the whole UI config: panes, navbars with their widgets, theme, hotkeys, animations, and its version.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().getUiConfig()),
    }),
    defineAppTool({
      name: "update_ui_config",
      description:
        "Change the UI config with a JSON Merge Patch (objects merge, arrays replace, null deletes). Example: { panes: { left: { visible: false } } } hides the pages pane. The theme cannot be patched here: use set_theme. The change is validated as a whole and applied in the open page at once.",
      parameters: obj({
        patch: map(unknown(), { description: "The merge patch, a JSON object" }),
        baseVersion: opt(int({ description: "The version you read; a different current version is a conflict" })),
      }),
      replay: "safe",
      run: async (args) =>
        json(
          await svc().updateUiConfig(
            { patch: args.patch as { [key: string]: Json }, ...(args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}) },
            { by: "agent" },
          ),
        ),
    }),
    defineAppTool({
      name: "list_widgets",
      description: "List the widget types that can be placed in a navbar, and the widgets placed now with their ids, navbar and slot.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listWidgets()),
    }),
    defineAppTool({
      name: "add_widget",
      description: "Place a widget in a navbar. Returns the placement with its generated id.",
      parameters: obj({
        navbar: navbar(),
        widget: str({ description: "Widget type from list_widgets, for example context_bar", minLength: 1, maxLength: 129 }),
        slot: slot(),
        index: opt(int({ description: "Position in the navbar's item list (default: the end)", minimum: 0 })),
        options: opt(map(unknown(), { description: "Widget options, for example { fullWidth: true }" })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().addWidget(
            {
              navbar: args.navbar,
              widget: args.widget,
              slot: args.slot,
              ...(args.index !== undefined ? { index: args.index } : {}),
              ...(args.options !== undefined ? { options: args.options as { [k: string]: Json } } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "remove_widget",
      description: "Remove a placed widget by its placement id (from list_widgets).",
      parameters: obj({ id: str({ description: "Placement id, for example context_bar-1", minLength: 1, maxLength: 64 }) }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().removeWidget({ id: args.id }, origin(api.callId))),
    }),
    defineAppTool({
      name: "move_widget",
      description: "Move a placed widget to a position, and optionally to another slot or navbar.",
      parameters: obj({
        id: str({ description: "Placement id", minLength: 1, maxLength: 64 }),
        index: int({ description: "Position in the target navbar's item list after the widget is taken out", minimum: 0 }),
        navbar: opt(navbar()),
        slot: opt(slot()),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().moveWidget(
            {
              id: args.id,
              index: args.index,
              ...(args.navbar !== undefined ? { navbar: args.navbar } : {}),
              ...(args.slot !== undefined ? { slot: args.slot } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "set_widget_options",
      description: "Change a placed widget's options. The given options merge into the current ones; null deletes an option. Example: { fullWidth: true }.",
      parameters: obj({
        id: str({ description: "Placement id", minLength: 1, maxLength: 64 }),
        options: map(unknown(), { description: "Options to set" }),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(await svc().setWidgetOptions({ id: args.id, options: args.options as { [k: string]: Json } }, origin(api.callId))),
    }),
    defineAppTool({
      name: "list_hotkeys",
      description: "List the hotkey actions with their keys. Hotkeys are ignored while the user types in a text field.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listHotkeys()),
    }),
    defineAppTool({
      name: "set_hotkey",
      description: "Bind a key to a hotkey action. The key is one key ('s', '[', 'F2'), optionally after 'mod+', 'shift+' or 'mod+shift+' ('shift+e'); a key already bound to another action is refused.",
      parameters: obj({
        action: str({ description: "Action from list_hotkeys, for example settings.open", minLength: 1, maxLength: 129 }),
        key: str({ description: "One key, optionally after mod+, shift+ or mod+shift+", minLength: 1, maxLength: 16 }),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().setHotkey({ action: args.action, key: args.key }, origin(api.callId))),
    }),
    defineAppTool({
      name: "list_themes",
      description: "List the themes: the Precision Weave themes and the custom ones (with their seeds and tokens). The active theme is theme.name in the UI config.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listThemes()),
    }),
    defineAppTool({
      name: "set_theme",
      description: "Switch the active theme, and optionally the mode (light, dark or system). Applied in the open page at once; returns the contrast check.",
      parameters: obj({
        name: themeName("Theme name from list_themes"),
        mode: opt(oneOf(["light", "dark", "system"])),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(await svc().setTheme({ name: args.name, ...(args.mode !== undefined ? { mode: args.mode } : {}) }, origin(api.callId))),
    }),
    defineAppTool({
      name: "create_theme",
      description:
        "Create a custom theme on a Precision Weave base theme, with optional seeds and token overrides, and make it the active theme. The name is lowercase letters, digits and hyphens, starting with a letter.",
      parameters: obj({
        name: themeName("New theme name"),
        base: themeName("A Precision Weave theme name from list_themes"),
        title: opt(str({ description: "Display name", maxLength: 80 })),
        seeds: opt(seeds()),
        tokens: opt(tokens()),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().createTheme(
            {
              name: args.name,
              base: args.base,
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.seeds !== undefined ? { seeds: args.seeds as never } : {}),
              ...(args.tokens !== undefined ? { tokens: args.tokens as never } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "set_theme_values",
      description:
        "Change a custom theme's seeds and token overrides (merged into the stored ones; null deletes). Applied live when the theme is active. Precision Weave themes are read-only. Contrast failures come back as warnings.",
      parameters: obj({
        name: themeName("Custom theme name"),
        title: opt(str({ description: "Display name", maxLength: 80 })),
        seeds: opt(seeds()),
        tokens: opt(tokens()),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().setThemeValues(
            {
              name: args.name,
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.seeds !== undefined ? { seeds: args.seeds as never } : {}),
              ...(args.tokens !== undefined ? { tokens: args.tokens as never } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "check_theme",
      description: "Check a theme's contrast with pw-ui's rules. Returns warnings (failing pairs), proposed fixes and resolution problems.",
      parameters: obj({ name: themeName("Theme name") }),
      replay: "safe",
      run: async (args) => json(svc().checkTheme({ name: args.name })),
    }),
    defineAppTool({
      name: "fix_theme",
      description: "Apply pw-ui's contrast fixes to a custom theme as token overrides. Returns the fixes applied and the new check.",
      parameters: obj({ name: themeName("Custom theme name") }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().fixTheme({ name: args.name }, origin(api.callId))),
    }),
    defineAppTool({
      name: "delete_theme",
      description: "Delete a custom theme. When it was the active theme, the active theme falls back to Neon.",
      parameters: obj({ name: themeName("Custom theme name") }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().deleteTheme({ name: args.name }, origin(api.callId))),
    }),
    defineAppTool({
      name: "open_panel",
      description: "Open Settings or the cron list in the user's open page, optionally at a section (essentials, core4, advanced).",
      parameters: obj({
        target: oneOf(["settings", "cron"]),
        section: opt(str({ description: "Settings section", minLength: 1, maxLength: 64 })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(await svc().openPanel({ target: args.target, ...(args.section !== undefined ? { section: args.section } : {}) }, origin(api.callId))),
    }),
  ];

  const cron = [
    defineAppTool({
      name: "list_crons",
      description: "List the cron prompts: id, name, expression, prompt, enabled, the next slot (nextRunAt, ms epoch), the last run and its status.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listCrons()),
    }),
    defineAppTool({
      name: "create_cron",
      description:
        "Add a cron prompt: at every slot of the expression the prompt is sent to this conversation as a cron message (queued behind a running turn). Names are unique. The expression has 5 fields (minute hour day-of-month month weekday) or 6 with seconds first, in the server's time zone.",
      parameters: obj({
        name: str({ description: "Short unique name, one line", minLength: 1, maxLength: 64 }),
        expr: str({ description: "Cron expression, for example '0 9 * * 1-5' or '* * * * *' (every minute)", minLength: 1, maxLength: 120 }),
        prompt: str({ description: "The prompt to send at each slot", minLength: 1, maxLength: 20_000 }),
        enabled: opt(bool({ description: "On from the start (default true)" })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().createCron(
            { name: args.name, expr: args.expr, prompt: args.prompt, ...(args.enabled !== undefined ? { enabled: args.enabled } : {}) },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "update_cron",
      description:
        "Change a cron prompt's name, expression, prompt or enabled flag (any of them). A new expression, or switching it on, schedules the next slot from now.",
      parameters: obj({
        id: str({ description: "Cron id from list_crons", minLength: 1, maxLength: 64 }),
        name: opt(str({ description: "New name", minLength: 1, maxLength: 64 })),
        expr: opt(str({ description: "New cron expression", minLength: 1, maxLength: 120 })),
        prompt: opt(str({ description: "New prompt", minLength: 1, maxLength: 20_000 })),
        enabled: opt(bool({ description: "Switch on or off" })),
      }),
      replay: "safe",
      run: async (args, api) =>
        json(
          await svc().updateCron(
            {
              id: args.id,
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.expr !== undefined ? { expr: args.expr } : {}),
              ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
              ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "delete_cron",
      description: "Delete a cron prompt and its run history. Messages it already sent stay in the chat.",
      parameters: obj({ id: str({ description: "Cron id from list_crons", minLength: 1, maxLength: 64 }) }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().deleteCron({ id: args.id }, origin(api.callId))),
    }),
    defineAppTool({
      name: "run_cron_now",
      description:
        "Send a cron prompt to this conversation now, enabled or not, without changing its schedule. It is queued behind the turn in progress; the answer comes in a later turn, so do not wait for it.",
      parameters: obj({ id: str({ description: "Cron id from list_crons", minLength: 1, maxLength: 64 }) }),
      replay: "safe",
      run: async (args, api) => json(await svc().runCronNow({ id: args.id }, origin(api.callId))),
    }),
  ];

  const authoring = [
    defineAppTool({
      name: "get_settings",
      description: "Read the settings document: factory name, enabled layers, disabled tools, model, thinking level, compaction points, system prompt override and the turn limit. No secrets.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().getSettings()),
    }),
    defineAppTool({
      name: "create_layer",
      description:
        "Create a declarative project layer: tsf/layers/<name>/manifest.json with an empty UI, loaded at once. Then define_widget adds widgets and write_layer_file adds prompts/<section>.md prompt sections. Names are lowercase letters, digits and underscores.",
      parameters: obj({
        name: str({ description: "Layer name, for example extras", minLength: 2, maxLength: 41 }),
        title: str({ description: "Short title, one line", minLength: 1, maxLength: 80 }),
        description: str({ description: "One line on what the layer is for", maxLength: 1000 }),
        enabledByDefault: opt(bool({ description: "On from the start (default true)" })),
      }),
      replay: "unsafe",
      run: async (args, api) =>
        json(
          await svc().createLayer(
            {
              name: args.name,
              title: args.title,
              description: args.description,
              ...(args.enabledByDefault !== undefined ? { enabledByDefault: args.enabledByDefault } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "delete_layer",
      description: "Delete a project layer: its folder, its stored on/off switch and the widgets of its types placed in the navbars. Built-in layers cannot be deleted.",
      parameters: obj({ name: str({ description: "Layer name from list_layers", minLength: 2, maxLength: 41 }) }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().deleteLayer({ name: args.name }, origin(api.callId))),
    }),
    defineAppTool({
      name: "list_layer_files",
      description: "List the files of a layer (paths relative to its folder, with sizes). Built-in layers are listed too, read-only.",
      parameters: obj({ name: str({ description: "Layer name from list_layers", minLength: 2, maxLength: 41 }) }),
      replay: "safe",
      run: async (args) => json(await svc().listLayerFiles({ name: args.name })),
    }),
    defineAppTool({
      name: "read_layer_file",
      description: "Read one .json, .ts or .md file of a layer (any layer, built-in ones included).",
      parameters: obj({
        name: str({ description: "Layer name", minLength: 2, maxLength: 41 }),
        path: str({ description: "Path inside the layer folder, for example manifest.json or prompts/style.md", minLength: 1, maxLength: 200 }),
      }),
      replay: "safe",
      run: async (args) => json(await svc().readLayerFile({ name: args.name, path: args.path })),
    }),
    defineAppTool({
      name: "write_layer_file",
      description:
        "Write one file of a project layer, then reload it so it is live. Only .json, .ts and .md, at most 256 KiB, inside the layer folder. manifest.json is validated first and refused when invalid; for other files, check the layer's status in the answer (a failed layer carries the reason). prompts/<name>.md becomes the prompt section <layer>-<name>. This is the way to edit a layer that has code (manifest.ts, extension.ts); the write and edit tools cannot touch tsf/layers.",
      parameters: obj({
        name: str({ description: "Layer name", minLength: 2, maxLength: 41 }),
        path: str({ description: "Path inside the layer folder", minLength: 1, maxLength: 200 }),
        content: str({ description: "The whole new file content", maxLength: 262_144 }),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().writeLayerFile({ name: args.name, path: args.path, content: args.content }, origin(api.callId))),
    }),
    defineAppTool({
      name: "delete_layer_file",
      description: "Delete one file of a project layer and reload it. The manifest cannot be deleted this way (use delete_layer).",
      parameters: obj({
        name: str({ description: "Layer name", minLength: 2, maxLength: 41 }),
        path: str({ description: "Path inside the layer folder", minLength: 1, maxLength: 200 }),
      }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().deleteLayerFile({ name: args.name, path: args.path }, origin(api.callId))),
    }),
    defineAppTool({
      name: "reload_layers",
      description: "Rescan tsf/layers so files changed outside these tools take effect. Answers every layer with its status (loaded or failed, with the reason).",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => json(await svc().reloadLayers(origin(api.callId))),
    }),
    defineAppTool({
      name: "define_widget",
      description:
        "Add or replace (by id) a widget type in a project layer that has manifest.json. A widget is { id: '<layer>.<name>', title, description, navbars: ['global' and/or 'agent'], defaultOptions: {}, control } where control is { kind: 'value'|'button'|'toggle'|'text'|'number'|'select', label, capability, ... } with query/action naming a layer handler or core:<capabilityId> (see the rules). Place it afterwards with add_widget.",
      parameters: obj({
        layer: str({ description: "Layer name", minLength: 2, maxLength: 41 }),
        widget: map(unknown(), { description: "The widget contribution object" }),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().defineWidget({ layer: args.layer, widget: args.widget as never }, origin(api.callId))),
    }),
    defineAppTool({
      name: "export_layer",
      description:
        "Archive a project layer's folder (.json, .ts, .md files) as a .tgz in tsf/data/exports (default <name>-<version>.tgz). Answers the path, size and files; the user can download it from Settings > Layers. Built-in layers cannot be exported.",
      parameters: obj({
        name: str({ description: "Project layer name from list_layers", minLength: 2, maxLength: 41 }),
        to: opt(str({ description: "Archive file name inside tsf/data/exports, ending in .tgz", minLength: 5, maxLength: 120 })),
      }),
      replay: "safe",
      run: async (args, api) => json(await svc().exportLayer({ name: args.name, ...(args.to !== undefined ? { to: args.to } : {}) }, origin(api.callId))),
    }),
    defineAppTool({
      name: "import_layer",
      description:
        "Install a layer from a .tgz or a layer folder (a local path, relative to the project root) or an https URL to a .tgz, then load it. The manifest is validated like a reload and archive paths are confined to the layer folder. An existing layer is kept unless replace is true. name installs a declarative layer under another name (ids follow); without it the manifest's name is used. A layer whose requires is unmet loads as failed with the reason. Imported code runs in the factory once the layer loads, so import only layers you trust.",
      parameters: obj({
        source: str({ description: "Local path to a .tgz or layer folder, or an https URL to a .tgz", minLength: 1, maxLength: 2000 }),
        name: opt(str({ description: "Layer name to install under (default: the manifest's name)", minLength: 2, maxLength: 41 })),
        replace: opt(bool({ description: "Overwrite an existing project layer of that name (default false)" })),
      }),
      replay: "unsafe",
      run: async (args, api) =>
        json(
          await svc().importLayer(
            { source: args.source, ...(args.name !== undefined ? { name: args.name } : {}), ...(args.replace !== undefined ? { replace: args.replace } : {}) },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "undefine_widget",
      description: "Remove a widget type from a project layer's manifest.json, and every placement of it from the navbars.",
      parameters: obj({
        layer: str({ description: "Layer name", minLength: 2, maxLength: 41 }),
        id: str({ description: "Widget type id, <layer>.<name>", minLength: 3, maxLength: 100 }),
      }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().removeWidgetType({ layer: args.layer, id: args.id }, origin(api.callId))),
    }),
  ];


  // --- Liquid core (P9): the factory's own web build, process and rendered UI ------------------------------------
  const liquid = [
    defineAppTool({
      name: "rebuild_web",
      description:
        "Build the web app from tsf/app/src/web and src/shared now (edits there also rebuild by themselves a moment after the last change). Answers { ok, hash, error?, durationMs }. On failure the previous good build keeps serving and error holds vite's text: fix the source and call it again.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(await svc().rebuildWeb()),
    }),
    defineAppTool({
      name: "restart_factory",
      description:
        "Restart the factory process so edits to the server or core source (tsf/app/src/server, core, agent, layers) take effect. The answer comes at once and the restart follows about 1.5 s later: finish what you were saying first. The conversation continues after the restart (an interrupted turn is continued automatically). Open pages reconnect on their own. Do not call it for web edits: those rebuild live.",
      parameters: obj({ reason: opt(str({ description: "Why, for the log and the page", maxLength: 200 })) }),
      replay: "safe",
      run: async (args, api) => json(await svc().restart(args.reason !== undefined ? { reason: args.reason } : {}, origin(api.callId))),
    }),
    defineAppTool({
      name: "screenshot",
      description:
        "Capture the factory's rendered UI as a PNG with headless Chromium and show it to you. page is / or an app path, selector captures one element, mode light or dark sets the colour mode, fullPage captures the whole scroll height. Answers { path, file, url, width, height }; the image is attached. Needs Chromium installed for playwright (an error says how).",
      parameters: obj({
        page: opt(str({ description: "App path, default /", maxLength: 500 })),
        selector: opt(str({ description: "CSS selector of one element to capture", maxLength: 500 })),
        width: opt(int({ description: "Viewport width in pixels, 100 to 4000 (default 1280)", minimum: 100, maximum: 4000 })),
        height: opt(int({ description: "Viewport height in pixels, 100 to 4000 (default 800)", minimum: 100, maximum: 4000 })),
        mode: opt(oneOf(["light", "dark"])),
        fullPage: opt(bool({ description: "Capture the full scrollable page" })),
      }),
      replay: "safe",
      run: async (args) =>
        json(
          await svc().screenshot({
            ...(args.page !== undefined ? { page: args.page } : {}),
            ...(args.selector !== undefined ? { selector: args.selector } : {}),
            ...(args.width !== undefined ? { width: args.width } : {}),
            ...(args.height !== undefined ? { height: args.height } : {}),
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
          }),
        ),
      attach: async (value) => {
        const path = (value as { path?: unknown }).path;
        if (typeof path !== "string") return [];
        return [{ data: (await readFile(path)).toString("base64"), mimeType: "image/png" }];
      },
    }),
  ];

  return defineExtension({
    name: "factory_controls",
    tools: [...tools, ...core4, ...cron, ...authoring, ...liquid],
    sections: [section("factory_controls-rules", () => RULES_TEXT)],
  }) as Extension;
}
