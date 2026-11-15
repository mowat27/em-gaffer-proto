/**
 * builder layer: handlers behind the UI panel, the widget and the routes, and the agent tools that call the same
 * handlers through the Service.
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, LayerHandlers } from "../../app/src/agent/layer-context.ts";
import type { Json, Origin } from "../../app/src/shared/types.ts";
import { join } from "node:path";
import { KINDS, KIND_LABEL, describeEntry, filterEntries, fmtDuration, fmtNum, metricsOf, parseSession, type Entry, type Kind } from "./pi-session.ts";
import { findSession, listSessions, readSession, type SessionInfo } from "./pi-session-files.ts";
import { BuilderLayer, SETTING_KEYS, text } from "./lib.ts";

const RULES_TEXT = [
  "The builder is the build server, server.ts (run with node, Node 24 type stripping), started and stopped by this layer. It exposes POST /slices on its host and port, runs one job at a time (503 with Retry-After while busy), checks `requires` (422 with the missing entries), clones the target repository at the requested base into its workspace directory, runs the pi agent in the clone, commits what the agent changed, and POSTs { outcome: done, patch } (git format-patch) or { outcome: failed, reason } to the gaffer's callback. It has no board access and no write access to the repository.",
  "The pi agent is a stub for now, run with an isolated agent dir, pi-agent/ (PI_CODING_AGENT_DIR). Its configuration is plain Pi files, not a settings blob: pi-agent/settings.json (defaultProvider, defaultModel, defaultThinkingLevel, defaultTools, defaultProjectTrust), pi-agent/AGENTS.md (standing instructions) and pi-agent/prompts/build.md (the per-job prompt template, invoked as `/build <sliceFile> <title> <context> <sliceId> <attempt> <base> <model> <now>`). AGENTS.md and prompts/build.md are copied fresh from the Builder/Agent/AGENTS.md and Builder/Agent/Build Prompt.md pages at the start of every job, so edit those pages, not a setting, to change what the agent is told. Drop a `.ts` file into pi-agent/extensions/ or a `SKILL.md` directory into pi-agent/skills/ and it loads automatically, no setting either (see ai-docs/pi.md and Builder/Agent/Readme.md).",
  "What remains a setting is the plain CLI invocation: pi_command, pi_agentDir, pi_provider, pi_model, pi_thinking, pi_args (flags, shell-style, placed before -p) and pi_timeoutMinutes. The server re-reads the config and the two pages at the start of every job, so a change applies to the next build without a restart; host and port need builder_stop then builder_start.",
  "To build out the real agent, edit server.ts with the coding tools and restart the server (builder_stop, builder_start). Tools: builder_status, builder_health, builder_start, builder_stop, builder_get_settings, builder_set_setting (keys: " +
    SETTING_KEYS.join(", ") +
    "), builder_events, builder_clear_events, builder_log, builder_job_log, builder_sessions, builder_session_summary, builder_session_entries. Every build job has a friendly name (for example rustic-dolphin) shown in events, status and the session list. builder_sessions lists the pi session logs (newest first, by start time and job name), builder_session_summary gives one session's metrics, and builder_session_entries reads its entries with the same type, tool and text filters and timestamp sort as the Sessions tab; a session is named by its job name, a job id, or `latest`. The user sees the same state on the Builder screen (left pane > Factory > Builder), which updates live. Never print key values.",
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
  const sessionsDir = () => join(ctx.paths.projectRoot, "pi-agent", "sessions");
  const label = (s: SessionInfo) => ({ name: s.name, started: s.started, jobId: s.jobId, id: s.id, sizeKb: Math.max(1, Math.round(s.size / 1024)) });
  /** The session a tool call names (default: the latest), read and parsed; `error` says what went wrong. */
  const openSession = (ref: unknown): { error: string } | { info: SessionInfo; entries: Entry[] } => {
    const list = listSessions(sessionsDir());
    const info = findSession(list, typeof ref === "string" ? ref : undefined);
    if (!info) return { error: list.length ? `no session matches "${String(ref)}"; list them with builder_sessions` : "no sessions yet" };
    const read = readSession(sessionsDir(), info.id);
    if (!read.ok) return { error: read.message };
    return { info, entries: parseSession(read.content) };
  };
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
      sessions: (input) => {
        const limit = Number(rec(input).limit ?? 20) || 20;
        const all = listSessions(sessionsDir());
        return { count: all.length, sessions: all.slice(0, limit).map(label) } as unknown as Json;
      },
      session_summary: (input) => {
        const s = openSession(rec(input).session);
        if ("error" in s) return { error: s.error };
        const m = metricsOf(s.entries);
        return { session: label(s.info), model: m.model, entries: m.entries, duration: fmtDuration(m.durationMs), assistantTurns: m.turns, toolCalls: m.toolCalls, toolErrors: m.toolErrors, tokens: { input: m.input, output: m.output, cacheRead: m.cacheRead }, recordedCostUsd: Number(m.cost.toFixed(4)), topTools: m.topTools.map(([name, count]) => `${name} ${count}`) } as unknown as Json;
      },
      session_entries: (input) => {
        const r = rec(input);
        const s = openSession(r.session);
        if ("error" in s) return { error: s.error };
        const asList = (v: Json | undefined): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v !== "" ? v.split(",").map((x) => x.trim()) : []);
        const kinds = asList(r.types);
        const bad = kinds.filter((k) => !(KINDS as string[]).includes(k));
        if (bad.length) return { error: `unknown type ${bad.join(", ")}; use ${KINDS.join(", ")}` };
        const rows = filterEntries(s.entries, { kinds: kinds as Kind[], tools: asList(r.tools), text: typeof r.text === "string" ? r.text : "", newestFirst: r.sort !== "oldest" });
        const offset = Math.max(0, Number(r.offset ?? 0) || 0);
        const limit = Math.min(200, Math.max(1, Number(r.limit ?? 40) || 40));
        const page = rows.slice(offset, offset + limit);
        const clock = (ts: number) => new Date(ts).toISOString().slice(11, 23);
        const entries = page.map((e) => `#${e.n} ${clock(e.ts)} ${KIND_LABEL[e.kind]}: ${describeEntry(e)}${r.raw === true ? `\n${JSON.stringify(e.obj).slice(0, 3000)}` : ""}`);
        return { session: label(s.info), total: s.entries.length, matched: rows.length, offset, shown: page.length, order: r.sort === "oldest" ? "oldest first" : "newest first", entries } as unknown as Json;
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
  const { defineExtension, section, defineAppTool, obj, str, int, opt, unknown, arr, bool, oneOf } = ctx.pi;
  const origin = (callId: string): Origin => ({ by: "agent", callId });
  const query = (name: string, input: Json = {}) => ctx.service().layerQuery({ layer: "builder", name, input });
  const action = (name: string, input: Json, callId: string) => ctx.service().layerAction({ layer: "builder", name, input }, origin(callId));
  const show = async (p: Promise<Json>) => text(await p);
  /** Entry listings are long: print the lines as lines, under a short header. */
  const showEntries = async (p: Promise<Json>) => {
    const r = (await p) as Record<string, Json>;
    if (!Array.isArray(r.entries)) return text(r, 12000);
    const { entries, ...head } = r;
    return text(`${JSON.stringify(head)}\n${entries.join("\n")}`, 12000);
  };

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
      description: "Start the build server (node server.ts) on the configured host and port.",
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
      name: "builder_sessions",
      description: "The pi session logs on disk, newest first: friendly job name, start time, job id, size. Same list as the Sessions tab on the Builder screen.",
      parameters: obj({ limit: opt(int({ description: "How many (default 20)", minimum: 1, maximum: 200 })) }),
      replay: "safe",
      run: async (args) => show(query("sessions", { limit: args.limit ?? 20 })),
    }),
    defineAppTool({
      name: "builder_session_summary",
      description: "Summary metrics for one pi session: duration, assistant turns, tool calls and errors, tokens, recorded cost, model, top tools. Cost is the sum of each turn's cost.total as logged.",
      parameters: obj({ session: opt(str({ description: "Job name (rustic-dolphin), job id or its first characters, or `latest` (default)" })) }),
      replay: "safe",
      run: async (args) => show(query("session_summary", { ...(args.session ? { session: args.session } : {}) })),
    }),
    defineAppTool({
      name: "builder_session_entries",
      description:
        "Entries of one pi session as one line each (#line time type: content), filtered and sorted like the Sessions tab. Types: session, meta (model and thinking changes), system, user, assistant, tool (result), tool-error, other. A tool filter matches assistant entries that call the tool and its results. `raw` adds each entry's raw JSON.",
      parameters: obj({
        session: opt(str({ description: "Job name, job id or its first characters, or `latest` (default)" })),
        types: opt(arr(oneOf([...KINDS] as [string, ...string[]]), { description: "Only these message types (any of)" })),
        tools: opt(arr(str(), { description: "Only entries that call or answer these tools (any of), e.g. bash, read, done" })),
        text: opt(str({ description: "Case-insensitive text found anywhere in the raw entry" })),
        sort: opt(oneOf(["newest", "oldest"] as [string, ...string[]])),
        limit: opt(int({ description: "Entries to show (default 40, max 200)", minimum: 1, maximum: 200 })),
        offset: opt(int({ description: "Skip this many matches (paging)", minimum: 0 })),
        raw: opt(bool({ description: "Include each entry's raw JSON (clipped to 3000 characters)" })),
      }),
      replay: "safe",
      run: async (args) =>
        showEntries(
          query("session_entries", {
            ...(args.session ? { session: args.session } : {}),
            ...(args.types ? { types: args.types } : {}),
            ...(args.tools ? { tools: args.tools } : {}),
            ...(args.text ? { text: args.text } : {}),
            ...(args.sort ? { sort: args.sort } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
            ...(args.offset ? { offset: args.offset } : {}),
            ...(args.raw ? { raw: args.raw } : {}),
          }),
        ),
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
