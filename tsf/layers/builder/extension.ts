/**
 * builder layer: handlers behind the UI panel, the widget and the routes, and the agent tools that call the same
 * handlers through the Service.
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, LayerHandlers } from "../../app/src/agent/layer-context.ts";
import type { Json, Origin } from "../../app/src/shared/types.ts";
import { BuilderLayer, SETTING_KEYS, text } from "./lib.ts";

const RULES_TEXT = [
  "The builder is the build server, builder/server.ts (run with node, Node 24 type stripping), started and stopped by this layer. It exposes POST /slices on its host and port, runs one job at a time (503 with Retry-After while busy), checks `requires` (422 with the missing entries), clones the target repository at the requested base into its workspace directory, runs the pi agent in the clone, commits what the agent changed, and POSTs { outcome: done, patch } (git format-patch) or { outcome: failed, reason } to the gaffer's callback. It has no board access and no write access to the repository.",
  "The pi agent is a stub for now, run with an isolated agent dir, builder/pi-agent/ (PI_CODING_AGENT_DIR). Its configuration is plain Pi files, not a settings blob: builder/pi-agent/settings.json (defaultProvider, defaultModel, defaultThinkingLevel, defaultTools, defaultProjectTrust), builder/pi-agent/AGENTS.md (standing instructions) and builder/pi-agent/prompts/build.md (the per-job prompt template, invoked as `/build <title> <context> <sliceId> <attempt> <logbook> <base> <model> <now>`). AGENTS.md and prompts/build.md are copied fresh from the Builder/Agent/AGENTS.md and Builder/Agent/Build Prompt.md pages at the start of every job, so edit those pages, not a setting, to change what the agent is told. Drop a `.ts` file into builder/pi-agent/extensions/ or a `SKILL.md` directory into builder/pi-agent/skills/ and it loads automatically, no setting either (see ai-docs/pi.md and Builder/Agent/Readme.md).",
  "What remains a setting is the plain CLI invocation: pi_command, pi_agentDir, pi_provider, pi_model, pi_thinking, pi_args (flags, shell-style, placed before -p) and pi_timeoutMinutes. The server re-reads the config and the two pages at the start of every job, so a change applies to the next build without a restart; host and port need builder_stop then builder_start.",
  "To build out the real agent, edit builder/server.ts with the coding tools and restart the server (builder_stop, builder_start). Tools: builder_status, builder_health, builder_start, builder_stop, builder_get_settings, builder_set_setting (keys: " +
    SETTING_KEYS.join(", ") +
    "), builder_events, builder_clear_events, builder_log, builder_job_log. The user sees the same state on the Builder screen (left pane > Factory > Builder), which updates live. Never print key values.",
].join("\n");

const REG = globalThis as unknown as { __builderLayer?: { instance: BuilderLayer; stop: () => void } };

function layer(ctx: LayerContext): BuilderLayer {
  if (!REG.__builderLayer) {
    const instance = new BuilderLayer(ctx);
    REG.__builderLayer = { instance, stop: instance.watch() };
  }
  return REG.__builderLayer.instance;
}

function resetLayer(): void {
  REG.__builderLayer?.stop();
  REG.__builderLayer = undefined;
}

export function createHandlers(ctx: LayerContext): LayerHandlers {
  const b = () => layer(ctx);
  const rec = (input: Json): Record<string, Json> => (typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, Json>) : {});
  return {
    queries: {
      status: () => b().status(),
      health: async () => {
        const h = (await b().health()) as Record<string, unknown>;
        const job = h.job as Record<string, unknown> | null | undefined;
        const summary = h.ok
          ? `${h.busy ? `busy: ${job?.context}/${job?.title} (${job?.step})` : "idle"} · pi ${(h.pi as Record<string, unknown> | undefined)?.provider}/${(h.pi as Record<string, unknown> | undefined)?.model}`
          : `unreachable: ${h.error}`;
        return { ...h, summary } as Json;
      },
      get_settings: () => {
        const s = b().getSettings();
        return { ...s, json: JSON.stringify(s, null, 2) } as Json;
      },
      settings: () => b().getSettings() as unknown as Json,
      events: (input) => {
        const limit = Number(rec(input).limit ?? 50) || 50;
        const events = b().events(limit);
        const last = events[0];
        return { count: events.length, last: last ? `${last.ts.slice(11, 19)} ${last.kind}: ${last.msg}` : "none", events } as unknown as Json;
      },
      log: (input) => ({ tail: b().logTail(Number(rec(input).lines ?? 60) || 60) }),
      job_log: (input) => {
        const r = rec(input);
        let jobId = typeof r.jobId === "string" ? r.jobId : "";
        if (!jobId) {
          const withJob = b()
            .events(200)
            .find((e) => typeof e.jobId === "string" && e.jobId);
          jobId = (withJob?.jobId as string) ?? "";
        }
        return { jobId: jobId || null, tail: jobId ? b().jobLog(jobId, Number(r.lines ?? 200) || 200) : "no job yet" };
      },
    },
    actions: {
      set_setting: {
        replay: "safe",
        run: async (input) => {
          const r = rec(input);
          const next = b().setSetting(String(r.key), r.value);
          b().scheduleRender();
          return next as unknown as Json;
        },
      },
      start: {
        replay: "safe",
        run: async () => {
          const out = b().start();
          b().scheduleRender();
          return out;
        },
      },
      stop: {
        replay: "safe",
        run: async () => {
          const out = b().stop();
          b().scheduleRender();
          return out;
        },
      },
      clear_events: {
        replay: "safe",
        run: async () => {
          b().clearEvents();
          b().scheduleRender();
          return { cleared: true };
        },
      },
    },
  };
}

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section, defineAppTool, obj, str, int, opt, unknown } = ctx.pi;
  const origin = (callId: string): Origin => ({ by: "agent", callId });
  const query = (name: string, input: Json = {}) => ctx.service().layerQuery({ layer: "builder", name, input });
  const action = (name: string, input: Json, callId: string) => ctx.service().layerAction({ layer: "builder", name, input }, origin(callId));
  const show = async (p: Promise<Json>) => text(await p);

  const tools = [
    defineAppTool({
      name: "builder_status",
      description: "The build server's state (running, pid, URL) and the pi configuration the next job will use.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("status")),
    }),
    defineAppTool({
      name: "builder_health",
      description: "Ask the running build server for its status: busy, current job and step, last job, the pi config it loaded.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("health")),
    }),
    defineAppTool({
      name: "builder_get_settings",
      description: "Read the builder settings, including the pi invocation.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("settings")),
    }),
    defineAppTool({
      name: "builder_set_setting",
      description: `Change one builder setting. Keys: ${SETTING_KEYS.join(", ")}. pi_* keys apply to the next job; host and port need a stop and start.`,
      parameters: obj({ key: str({ description: "Setting key" }), value: unknown({ description: "New value (string or number)" }) }),
      replay: "safe",
      run: async (args, api) => show(action("set_setting", { key: args.key, value: args.value as Json }, api.callId)),
    }),
    defineAppTool({
      name: "builder_start",
      description: "Start the build server (node builder/server.ts) on the configured host and port.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("start", {}, api.callId)),
    }),
    defineAppTool({
      name: "builder_stop",
      description: "Stop the build server. A job in progress is abandoned (the gaffer times out or retries).",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("stop", {}, api.callId)),
    }),
    defineAppTool({
      name: "builder_events",
      description: "Recent builder events, newest first (accepted, clone, pi start and end, patch, callback, failures).",
      parameters: obj({ limit: opt(int({ description: "How many (default 50)", minimum: 1, maximum: 500 })) }),
      replay: "safe",
      run: async (args) => show(query("events", { limit: args.limit ?? 50 })),
    }),
    defineAppTool({
      name: "builder_clear_events",
      description: "Clear the builder event log.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("clear_events", {}, api.callId)),
    }),
    defineAppTool({
      name: "builder_log",
      description: "The tail of the build server's own log.",
      parameters: obj({ lines: opt(int({ description: "Lines (default 60)", minimum: 1, maximum: 2000 })) }),
      replay: "safe",
      run: async (args) => show(query("log", { lines: args.lines ?? 60 })),
    }),
    defineAppTool({
      name: "builder_job_log",
      description: "The pi command, prompt and output of one job (default: the latest job).",
      parameters: obj({ jobId: opt(str({ description: "Job id (default: latest)" })), lines: opt(int({ description: "Lines (default 200)", minimum: 1, maximum: 5000 })) }),
      replay: "safe",
      run: async (args) => show(query("job_log", { ...(args.jobId ? { jobId: args.jobId } : {}), lines: args.lines ?? 200 })),
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
