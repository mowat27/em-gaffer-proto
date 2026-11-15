/**
 * gaffer layer: handlers (queries and actions behind the UI panel, the widget and the routes) and the agent tools
 * that call the same handlers through the Service, so UI, routes and agent share one path.
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext, LayerHandlers } from "../../app/src/agent/layer-context.ts";
import type { Json, Origin } from "../../app/src/shared/types.ts";
import { GafferLayer, SETTING_KEYS, text } from "./lib.ts";

const RULES_TEXT = [
  "The gaffer connects the Eventmodelers board, the build server and the target repository. It is the eventmodelers shared runner (eventmodelers run --exec) with gaffer.ts (kit/templates/build-kit/gaffer.ts) as its --exec command, running in the gaffer's own clone of the target repository under tsf/data/layers/gaffer/gaffers/<name>/repo. The kit is installed there with eventmodelers init --stack gaffer --git from the kit repository built out of kit/; the target repository never receives .build-kit or .eventmodelers.",
  "On a build turn gaffer.ts pushes main, POSTs the slice to the build server (/slices), listens for the callback on the callback host and port, applies the patch with git am -3 on a feature branch, runs the gate, fast-forwards main, pushes it and records Done (or Waiting with handover on) with eventmodelers slice-status. A failed build is commented on the slice and the runner retries (Blocked after 5 attempts).",
  "Tools: gaffer_status, gaffer_setup (clone, kit, config; run it first and after changing the board, repository or name), gaffer_start, gaffer_stop, gaffer_get_settings, gaffer_set_setting (keys: " +
    SETTING_KEYS.join(", ") +
    "), gaffer_events, gaffer_clear_events, gaffer_log, gaffer_slices, gaffer_plan_slice (set a slice to Planned so the gaffer builds it) and gaffer_set_token. The user sees the same state on the Gaffer screen (left pane > Factory > Gaffer), which updates live; tell them to look there rather than pasting event logs.",
  "The board token is never shown: it comes from EVENTMODELERS_TOKEN or tsf/data/layers/gaffer/board-token and goes only into the clone's .eventmodelers/config.json. Never print it, never put it in a page.",
].join("\n");

// One instance per server process, survives a layer reload (the module is re-imported from a fresh copy, so module
// state would leak a second watcher): the previous instance's watcher is stopped before a new one starts.
const REG = globalThis as unknown as { __gafferLayer?: { instance: GafferLayer; stop: () => void } };

function layer(ctx: LayerContext): GafferLayer {
  if (!REG.__gafferLayer) {
    const instance = new GafferLayer(ctx);
    REG.__gafferLayer = { instance, stop: instance.watch() };
  }
  return REG.__gafferLayer.instance;
}

function resetLayer(): void {
  REG.__gafferLayer?.stop();
  REG.__gafferLayer = undefined;
}

export function createHandlers(ctx: LayerContext): LayerHandlers {
  const g = () => layer(ctx);
  const rec = (input: Json): Record<string, Json> => (typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, Json>) : {});
  return {
    queries: {
      status: () => g().status(),
      get_settings: () => {
        const s = g().getSettings();
        return { ...s, json: JSON.stringify(s, null, 2) } as Json;
      },
      settings: () => g().getSettings() as unknown as Json,
      events: (input) => {
        const limit = Number(rec(input).limit ?? 50) || 50;
        const events = g().events(limit);
        const last = events[0];
        return { count: events.length, last: last ? `${last.ts.slice(11, 19)} ${last.kind}: ${last.msg}` : "none", events } as unknown as Json;
      },
      log: (input) => {
        const lines = Number(rec(input).lines ?? 60) || 60;
        return { tail: g().logTail(lines) };
      },
      slices: async () => {
        try {
          const slices = (await g().slices()) as { id: string; title: string; status: string | null; type: string | null }[];
          const withLabel = slices.map((s) => ({ ...s, label: `${s.title} (${s.status ?? "?"})` }));
          return { slices: withLabel, planned: null, summary: slices.map((s) => `${s.title}: ${s.status ?? "?"}`).join(" · ") || "no slices" } as unknown as Json;
        } catch (err) {
          return { slices: [], planned: null, summary: `board unavailable: ${(err as Error).message}` };
        }
      },
    },
    actions: {
      set_setting: {
        replay: "safe",
        run: async (input) => {
          const r = rec(input);
          const next = g().setSetting(String(r.key), r.value);
          g().scheduleRender();
          return next as unknown as Json;
        },
      },
      setup: {
        replay: "safe",
        run: async () => {
          const out = g().setup();
          g().scheduleRender();
          return out;
        },
      },
      start: {
        replay: "safe",
        run: async () => {
          const out = g().start();
          g().scheduleRender();
          return out;
        },
      },
      stop: {
        replay: "safe",
        run: async () => {
          const out = g().stop();
          g().scheduleRender();
          return out;
        },
      },
      clear_events: {
        replay: "safe",
        run: async () => {
          g().clearEvents();
          g().scheduleRender();
          return { cleared: true };
        },
      },
      set_token: {
        replay: "safe",
        run: async (input) => {
          g().setToken(String(rec(input).token ?? ""));
          g().scheduleRender();
          return { stored: true };
        },
      },
      plan_slice: {
        replay: "unsafe",
        run: async (input) => {
          const r = rec(input);
          const slice = String(r.slice ?? r.value ?? "");
          if (!slice) throw new Error("slice (id or title) is required");
          const out = await g().setSliceStatus(slice, String(r.status ?? "Planned"));
          g().scheduleRender();
          return out;
        },
      },
    },
  };
}

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section, defineAppTool, obj, str, int, opt, unknown } = ctx.pi;
  const origin = (callId: string): Origin => ({ by: "agent", callId });
  const query = (name: string, input: Json = {}) => ctx.service().layerQuery({ layer: "gaffer", name, input });
  const action = (name: string, input: Json, callId: string) => ctx.service().layerAction({ layer: "gaffer", name, input }, origin(callId));
  const show = async (p: Promise<Json>) => text(await p);

  const tools = [
    defineAppTool({
      name: "gaffer_status",
      description: "The gaffer's state: running, set up, token present, home, builder URL, callback address, board, last event.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("status")),
    }),
    defineAppTool({
      name: "gaffer_get_settings",
      description: "Read the gaffer settings (board, repository, builder host and port, callback host and port, handover, timeout, requires, gate).",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("settings")),
    }),
    defineAppTool({
      name: "gaffer_set_setting",
      description: `Change one gaffer setting. Keys: ${SETTING_KEYS.join(", ")}. Numbers and booleans are coerced. Run gaffer_setup again after changing name, boardId, orgId, baseUrl or repoUrl; other settings apply at the next gaffer_start.`,
      parameters: obj({ key: str({ description: "Setting key" }), value: unknown({ description: "New value (string, number or boolean)" }) }),
      replay: "safe",
      run: async (args, api) => show(action("set_setting", { key: args.key, value: args.value as Json }, api.callId)),
    }),
    defineAppTool({
      name: "gaffer_setup",
      description:
        "Create or refresh the gaffer home: clone the target repository (or reset it to origin/main), exclude kit paths from git, build the kit repository from kit/, run eventmodelers init --stack gaffer --git, write the runner config. Takes up to a minute.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("setup", {}, api.callId)),
    }),
    defineAppTool({
      name: "gaffer_start",
      description: "Start the eventmodelers runner (eventmodelers run --exec 'node .build-kit/gaffer.ts') in the gaffer's clone. It polls the board and builds Planned slices.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("start", {}, api.callId)),
    }),
    defineAppTool({
      name: "gaffer_stop",
      description: "Stop the runner. A turn in progress is killed; the runner settles leftover claims when it starts again.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("stop", {}, api.callId)),
    }),
    defineAppTool({
      name: "gaffer_events",
      description: "Recent gaffer events, newest first (turn start, dispatch, callback, apply, merge, push, settle, failures).",
      parameters: obj({ limit: opt(int({ description: "How many (default 50)", minimum: 1, maximum: 500 })) }),
      replay: "safe",
      run: async (args) => show(query("events", { limit: args.limit ?? 50 })),
    }),
    defineAppTool({
      name: "gaffer_clear_events",
      description: "Clear the gaffer event log.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => show(action("clear_events", {}, api.callId)),
    }),
    defineAppTool({
      name: "gaffer_log",
      description: "The tail of the runner's own log (the eventmodelers run output, token masked).",
      parameters: obj({ lines: opt(int({ description: "Lines (default 60)", minimum: 1, maximum: 2000 })) }),
      replay: "safe",
      run: async (args) => show(query("log", { lines: args.lines ?? 60 })),
    }),
    defineAppTool({
      name: "gaffer_set_token",
      description: "Store the board token (only when the user hands it to you). It is written to tsf/data/layers/gaffer/board-token and never shown again.",
      parameters: obj({ token: str({ description: "The board token", minLength: 8 }) }),
      replay: "safe",
      run: async (args, api) => show(action("set_token", { token: args.token }, api.callId)),
    }),
    defineAppTool({
      name: "gaffer_slices",
      description: "List the board's slices with their statuses.",
      parameters: obj({}),
      replay: "safe",
      run: async () => show(query("slices")),
    }),
    defineAppTool({
      name: "gaffer_plan_slice",
      description: "Set a slice to Planned on the board (by title or id) so the gaffer picks it up; status may be another slice status. Only statuses and comments ever change on the board.",
      parameters: obj({ slice: str({ description: "Slice title or id" }), status: opt(str({ description: "Status (default Planned)" })) }),
      replay: "unsafe",
      run: async (args, api) => show(action("plan_slice", { slice: args.slice, status: args.status ?? "Planned" }, api.callId)),
    }),
  ];

  // A (re)load: drop the previous instance and start the watcher, so the page follows gaffer.ts before any query.
  resetLayer();
  queueMicrotask(() => {
    try {
      layer(ctx);
    } catch (err) {
      ctx.log.warn("gaffer.init_failed", { error: (err as Error).message });
    }
  });

  return defineExtension({
    name: "gaffer",
    tools,
    sections: [section("gaffer-rules", () => RULES_TEXT)],
  }) as Extension;
}
