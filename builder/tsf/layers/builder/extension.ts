/**
 * builder layer: handlers behind the Builder screen, the widget and the top bar, and the agent tools that call the same
 * handlers through the Service. Every handler is a builder CLI call with --json (lib.ts); status is the machine feed.
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, LayerHandlers } from "../../app/src/agent/layer-context.ts";
import type { Json, Origin } from "../../app/src/shared/types.ts";
import { BuilderLayer, MODEL_AGENT, text } from "./lib.ts";

const RULES_TEXT = [
  "The builder runs on its own: the build server is `builder server run` (a systemd unit on a VM, a detached run on the laptop), and every capability is a builder tool that the builder CLI (`node builder/cli/builder.ts`), an agent's tools and a run's API reach equally. This layer is a client of the CLI with --json and keeps no settings of its own.",
  "Status is the machine feed, builder/runs/index.jsonl (`builder events`): server.start, server.state (idle, busy with a job at a step, draining), server.stop, run and step events, job.accepted, job.result and the callback's outcome. builder_status summarises it and builder_events lists it. Tool calls are in each run's journal: builder_logs shows a run's journal (or its log), builder_tool with journal_query searches it.",
  "Notifications: agents (the ops agent above all) end an investigation with notify_operator; they are in control/notifications.jsonl, the feed (notification events) and the Builder screen's Ops tab. builder_tool with notifications_list reads them.",
  "Tools: builder_status, builder_events, builder_runs, builder_logs, builder_config (the merged machine config and the layer each value came from), builder_start, builder_stop, builder_restart (the build server, through the process tools), builder_tools (the builder tools this machine allows), builder_tool (call any of them by name: job_get, journal_query, session_entries, metrics, context_get, run_start, run_wait, control_send, ...) and builder_set_model (an agent's provider, model and thinking in its settings.json, a versioned definition change). A run is named by its id, a job id or name (rustic-dolphin), or latest.",
  "Server settings (host, port, job timeout, callback retries, workspaces kept, the active builder, the runs directory, the pi command) are machine config: the operator edits a layer (~/.gaffer/config.yml, $GAFFER_CONFIG or --config) and runs `builder config reload`; no tool changes them. Agents and builders are definitions under builder/agentics/ (each agent a directory with an agent.yml): change them with the definitions tools so each change is validated and versioned. Never print key values.",
].join("\n");

const REG = globalThis as unknown as { __builderLayer?: { instance: BuilderLayer; stop: () => void } };

function layer(ctx: LayerContext): BuilderLayer {
  if (!REG.__builderLayer) {
    const instance = new BuilderLayer(ctx);
    REG.__builderLayer = { instance, stop: instance.follow() };
  }
  return REG.__builderLayer.instance;
}

function resetLayer(): void {
  REG.__builderLayer?.stop();
  REG.__builderLayer = undefined;
}

const rec = (input: Json): Record<string, Json> => (typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, Json>) : {});
const opt = (v: Json | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);

export function createHandlers(ctx: LayerContext): LayerHandlers {
  const b = () => layer(ctx);
  const server = (sub: "start" | "stop" | "restart") => ({ replay: "safe" as const, run: async () => b().cli(["server", sub]) });
  return {
    queries: {
      status: () => b().status(),
      events: (input) => {
        const r = rec(input);
        const events = b().events(Number(r.limit ?? 120) || 120, opt(r.kind));
        const last = events[0];
        return { count: events.length, last: last ? `${last.ts.slice(11, 19)} ${last.kind}: ${last.msg}` : "none", events } as unknown as Json;
      },
      runs: (input) => {
        const r = rec(input);
        return b().cli(["runs", "--limit", String(Number(r.limit ?? 50) || 50), ...(opt(r.state) ? ["--state", opt(r.state)!] : []), ...(opt(r.kind) ? ["--kind", opt(r.kind)!] : []), ...(opt(r.job) ? ["--job", opt(r.job)!] : [])]);
      },
      run: (input) => b().tool("run_get", { run: opt(rec(input).run) ?? "latest" }),
      run_log: (input) => {
        const r = rec(input);
        return b().cli(["logs", opt(r.run) ?? "latest", "--limit", String(Number(r.limit ?? 200) || 200)]);
      },
      // The Sessions tab: the runs with a story (jobs and direct runs), one run's story from the journals, and the
      // Logs tab's job and server logs.
      sessions: (input) => {
        const r = rec(input);
        return b().tool("run_stories", { limit: Number(r.limit ?? 200) || 200, ...(opt(r.since) ? { since: opt(r.since) } : {}) });
      },
      story: (input) => b().tool("run_story", { run: opt(rec(input).run) ?? "latest" }),
      log_tail: (input) => {
        const r = rec(input);
        return b().tool("run_log", { run: opt(r.run) ?? "latest", lines: Number(r.lines ?? 300) || 300 });
      },
      config: () => b().cli(["config"]),
      tools: (input) => b().cli(["tools", ...(opt(rec(input).group) ? ["--group", opt(rec(input).group)!] : [])]),
      model: (input) => b().model(opt(rec(input).agent) ?? MODEL_AGENT),
      notifications: (input) => b().notifications(Number(rec(input).limit ?? 100) || 100),
    },
    actions: {
      start: server("start"),
      stop: server("stop"),
      restart: server("restart"),
      set_model: {
        replay: "safe",
        run: async (input) => {
          const r = rec(input);
          const pick = (k: string) => (typeof r[k] === "string" ? { [k]: r[k] as string } : {});
          return b().setModel({ ...pick("agent"), ...pick("provider"), ...pick("model"), ...pick("thinking") });
        },
      },
      // A builder's tsf notify sink posts here (builder/ops/core/notify.ts): kept for the Ops tab.
      notification: { replay: "safe", run: async (input) => b().receive(rec(input)) },
      tool: {
        replay: "unsafe",
        run: async (input) => {
          const r = rec(input);
          const name = opt(r.name);
          if (!name) throw new Error("tool: name is required");
          const args = r.args && typeof r.args === "object" && !Array.isArray(r.args) ? (r.args as Record<string, unknown>) : {};
          return b().tool(name, args);
        },
      },
    },
  };
}

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section, defineAppTool, obj, str, int, opt: optional, unknown } = ctx.pi;
  const origin = (callId: string): Origin => ({ by: "agent", callId });
  const query = (name: string, input: Json = {}) => ctx.service().layerQuery({ layer: "builder", name, input });
  const action = (name: string, input: Json, callId: string) => ctx.service().layerAction({ layer: "builder", name, input }, origin(callId));
  const show = async (p: Promise<Json>, max = 12000) => text(await p, max);
  const defined = (o: Record<string, Json | undefined>): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Json;

  const tools = [
    defineAppTool({
      name: "builder_status",
      description: "The builder's state from the machine feed: whether the build server runs (pid, URL, builder), idle, busy with a job at a step, or draining; the current job and the last one.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("status")),
    }),
    defineAppTool({
      name: "builder_events",
      description: "Machine feed events, newest first (`builder events`): server, run, step, job, callback, control and config events.",
      parameters: obj({ limit: optional(int({ description: "How many (default 50)", minimum: 1, maximum: 1000 })), kind: optional(str({ description: "A kind, or a prefix ending in * (server.*)" })) }),
      replay: "safe",
      run: async (args) => show(query("events", defined({ limit: args.limit ?? 50, kind: args.kind }))),
    }),
    defineAppTool({
      name: "builder_runs",
      description: "Runs, newest first (`builder runs`): id, agent or workflow, state, step, job, outcome.",
      parameters: obj({
        limit: optional(int({ description: "How many (default 50)", minimum: 1, maximum: 1000 })),
        state: optional(str({ description: "starting, running, done, failed, stopped, live or ended" })),
        kind: optional(str({ description: "agent or workflow" })),
        job: optional(str({ description: "Only the runs of this job (its id or name)" })),
      }),
      replay: "safe",
      run: async (args) => show(query("runs", defined({ limit: args.limit, state: args.state, kind: args.kind, job: args.job }))),
    }),
    defineAppTool({
      name: "builder_logs",
      description: "The end of a run's journal, or its log for a run without one (`builder logs <run>`).",
      parameters: obj({ run: optional(str({ description: "A run id, a job id or name, or latest (default)" })), limit: optional(int({ description: "Events (default 200)", minimum: 1, maximum: 2000 })) }),
      replay: "safe",
      run: async (args) => show(query("run_log", defined({ run: args.run, limit: args.limit }))),
    }),
    defineAppTool({
      name: "builder_config",
      description: "The merged machine config (secrets hidden) and the layer each value came from (`builder config`). Read only: the operator edits a layer and runs `builder config reload`.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("config")),
    }),
    defineAppTool({
      name: "builder_start",
      description: "Start the build server (`builder server start`): the builder-server unit under systemd, else a detached run. Its settings come from the machine config.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("start", {}, api.callId)),
    }),
    defineAppTool({
      name: "builder_stop",
      description: "Stop the build server (`builder server stop`).",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("stop", {}, api.callId)),
    }),
    defineAppTool({
      name: "builder_restart",
      description: "Restart the build server (`builder server restart`): a job in progress finishes first.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("restart", {}, api.callId)),
    }),
    defineAppTool({
      name: "builder_tools",
      description: "The builder tools this machine's limit allows, by group (`builder tools`).",
      parameters: obj({ group: optional(str({ description: "Only this group (observe, runs, operate, process, definitions, ...)" })) }),
      replay: "safe",
      run: async (args) => show(query("tools", defined({ group: args.group }))),
    }),
    defineAppTool({
      name: "builder_tool",
      description: "Call any builder tool by name with its arguments (`builder tool <name> <json>`), within the machine limit. builder_tools lists them with their descriptions.",
      parameters: obj({ name: str({ description: "The tool, e.g. job_get, journal_query, session_entries, metrics, run_start" }), args: optional(unknown({ description: "The tool's arguments, a JSON object" })) }),
      replay: "unsafe",
      run: async (args, api) => show(action("tool", { name: args.name, args: (args.args ?? {}) as Json }, api.callId)),
    }),
    defineAppTool({
      name: "builder_set_model",
      description: `Set an agent's provider, model and thinking level in its settings.json (default agent ${MODEL_AGENT}): a versioned definition change through agent_update, applied from its next run.`,
      parameters: obj({
        agent: optional(str({ description: `An agent id (default ${MODEL_AGENT})` })),
        provider: optional(str()),
        model: optional(str()),
        thinking: optional(str({ description: "off, minimal, low, medium, high, xhigh or max; empty for pi's default" })),
      }),
      replay: "safe",
      run: async (args, api) => show(action("set_model", defined({ agent: args.agent, provider: args.provider, model: args.model, thinking: args.thinking }), api.callId)),
    }),
  ];

  resetLayer();
  queueMicrotask(() => {
    try {
      layer(ctx);
    } catch (err) {
      ctx.log.warn("builder.init_failed", { error: (err as Error).message });
    }
  });

  return defineExtension({
    name: "builder",
    tools,
    sections: [section("builder-rules", () => RULES_TEXT)],
  }) as Extension;
}
