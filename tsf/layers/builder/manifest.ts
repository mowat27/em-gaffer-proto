import type { LayerManifest } from "../../app/src/shared/types.ts";

const cap = (name: string, kind: "query" | "action", summary: string, mutates: boolean) => ({
  id: `builder.${name}`,
  summary,
  kind,
  handler: name,
  tool: `builder_${name}`,
  control: `builder.${name}`,
  mutates,
});

const field = (key: string, label: string, kind: "text" | "number" = "text") => ({
  kind,
  label,
  query: "settings",
  field: key,
  action: "set_setting",
  actionInput: { key, value: "$value" },
  capability: "builder.set_setting",
});

/** The build server: one job at a time, a stub pi agent per job, the patch sent back to the gaffer. */
export const manifest: LayerManifest = {
  name: "builder",
  kind: "harness",
  version: "0.1.0",
  origin: "local",
  title: "Builder",
  description:
    "Runs the build server (builder/server.ts): accepts one slice job at a time over HTTP, clones the target repository at the requested base, runs the stub pi agent in it, commits, and posts the patch back to the gaffer's callback. The pi invocation (command, provider, model, thinking, flags, extensions, prompt) is a setting and applies to the next job.",
  enabledByDefault: true,
  env: [{ name: "OPENROUTER_API_KEY", required: false, secret: true, description: "Used by pi through OpenRouter (placeholder on a vault-routed machine)" }],
  vaultHosts: ["openrouter.ai"],
  ui: {
    settingsPanels: [
      {
        id: "builder.panel",
        title: "Builder",
        section: "advanced",
        controls: [
          { kind: "value", label: "Status", query: "status", field: "summary", capability: "builder.status" },
          { kind: "value", label: "Server says", query: "health", field: "summary", capability: "builder.health" },
          { kind: "value", label: "Last event", query: "events", field: "last", capability: "builder.events" },
          { kind: "button", label: "Start build server", action: "start", capability: "builder.start" },
          { kind: "button", label: "Stop build server", action: "stop", confirm: "Stop the build server? A job in progress is abandoned.", capability: "builder.stop" },
          field("host", "Listen host"),
          field("port", "Listen port", "number"),
          field("capabilities", "Capabilities (comma-separated requires it meets)"),
          field("workspaceDir", "Workspace directory"),
          field("jobTimeoutMinutes", "Job timeout (minutes)", "number"),
          field("logbookFile", "Logbook file in the target repository"),
          field("pi_command", "pi command"),
          field("pi_agentDir", "pi agent dir (models.json, settings.json; empty = ~/.pi/agent)"),
          field("pi_provider", "pi provider"),
          field("pi_model", "pi model"),
          field("pi_thinking", "pi thinking level"),
          field("pi_args", "pi flags"),
          field("pi_extensions", "pi extensions (-e, comma-separated)"),
          field("pi_prompt", "pi prompt template"),
          field("pi_timeoutMinutes", "pi timeout (minutes)", "number"),
          { kind: "value", label: "Settings (JSON)", query: "get_settings", field: "json", capability: "builder.get_settings" },
          { kind: "value", label: "Server log (tail)", query: "log", field: "tail", capability: "builder.log" },
          { kind: "value", label: "Last job log", query: "job_log", field: "tail", capability: "builder.job_log" },
          { kind: "button", label: "Clear events", action: "clear_events", confirm: "Clear the builder event log?", capability: "builder.clear_events" },
        ],
      },
    ],
    widgets: [
      {
        id: "builder.status_widget",
        title: "Builder status",
        description: "The build server's state and its last event.",
        navbars: ["global", "agent"],
        defaultOptions: {},
        defaultPlacements: [{ navbar: "global", slot: "center" }],
        control: { kind: "value", label: "Builder", query: "status", field: "summary", capability: "builder.status" },
      },
    ],
    hotkeys: [],
  },
  capabilities: [
    cap("status", "query", "The build server's state and the pi configuration for the next job", false),
    cap("health", "query", "Ask the running build server for its status (busy, current job, pi config it loaded)", false),
    cap("get_settings", "query", "The builder settings", false),
    cap("set_setting", "action", "Change one builder setting (pi_* keys change the agent invocation for the next job)", true),
    cap("start", "action", "Start the build server", true),
    cap("stop", "action", "Stop the build server", true),
    cap("events", "query", "Recent builder events (newest first)", false),
    cap("clear_events", "action", "Clear the builder event log", true),
    cap("log", "query", "The tail of the build server's log", false),
    cap("job_log", "query", "The pi output of one job (default: the latest)", false),
  ],
};
