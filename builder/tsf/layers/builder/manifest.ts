import type { LayerManifest } from "../../app/src/shared/types.ts";

const cap = (name: string, kind: "query" | "action", summary: string, mutates: boolean, tool = `builder_${name}`) => ({
  id: `builder.${name}`,
  summary,
  kind,
  handler: name,
  tool,
  control: `builder.${name}`,
  mutates,
});

/**
 * The builder, as a client of its CLI: status from the machine feed, every action a `builder` command with --json. No
 * settings: the server's live in the machine config, each agent's model in its settings.json (design section 13).
 */
export const manifest: LayerManifest = {
  name: "builder",
  kind: "harness",
  version: "0.2.0",
  origin: "local",
  title: "Builder",
  description:
    "Watches and drives the builder through its CLI (builder/cli/builder.ts, --json): the machine feed for status, the build server's start, stop and restart, runs and their journals, the merged machine config, and any builder tool. The server's settings are machine config edited by the operator; an agent's model is its settings.json, changed as a versioned definition.",
  enabledByDefault: true,
  env: [{ name: "OPENROUTER_API_KEY", required: false, secret: true, description: "Used by pi through OpenRouter (placeholder on a vault-routed machine)" }],
  vaultHosts: ["openrouter.ai"],
  ui: {
    settingsPanels: [],
    widgets: [
      {
        id: "builder.status_widget",
        title: "Builder status",
        description: "The build server's state from the machine feed, and its last event.",
        navbars: ["global", "agent"],
        defaultOptions: {},
        defaultPlacements: [{ navbar: "global", slot: "center" }],
        control: { kind: "value", label: "Builder", query: "status", field: "summary", capability: "builder.status" },
      },
    ],
    hotkeys: [],
  },
  capabilities: [
    cap("status", "query", "The builder's state from the machine feed: the server, its current job and the last one", false),
    cap("events", "query", "Machine feed events, newest first", false),
    cap("runs", "query", "Runs, newest first (builder runs)", false),
    cap("run", "query", "One run's record (builder tool run_get)", false, "builder_tool"),
    cap("run_log", "query", "A run's journal, or its log (builder logs)", false, "builder_logs"),
    cap("sessions", "query", "The runs with a story, newest first: jobs and direct runs, with duration and totals (builder tool run_stories)", false, "builder_tool"),
    cap("story", "query", "One run's whole story from the journals: prompts, thinking, replies, tool calls, tokens (builder tool run_story)", false, "builder_tool"),
    cap("log_tail", "query", "The end of a run's log or the build server's, secrets hidden (builder tool run_log)", false, "builder_tool"),
    cap("config", "query", "The merged machine config and the layer of each value (builder config)", false),
    cap("tools", "query", "The builder tools this machine allows (builder tools)", false),
    cap("model", "query", "An agent's provider, model and thinking (builder resolve)", false, "builder_set_model"),
    cap("notifications", "query", "The operator's notifications, newest first (builder tool notifications_list, and those posted here)", false, "builder_tool"),
    cap("notification", "action", "Receive a notification from a builder's tsf notify sink (POST /api/layers/builder/action/notification)", false, "builder_tool"),
    cap("start", "action", "Start the build server (builder server start)", true),
    cap("stop", "action", "Stop the build server (builder server stop)", true),
    cap("restart", "action", "Restart the build server (builder server restart)", true),
    cap("set_model", "action", "Change an agent's model in its settings.json (agent_update, versioned)", true),
    cap("tool", "action", "Call any builder tool (builder tool <name>)", true),
  ],
};
