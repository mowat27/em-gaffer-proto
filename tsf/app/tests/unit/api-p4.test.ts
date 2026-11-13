import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "../../src/shared/events.ts";
import type { ChatItem, Delta, ThemeCheck, ThemeInfo, UiConfig } from "../../src/shared/types.ts";
import type { HotkeyInfo, PlacedWidget, ThemeResult, WidgetList } from "../../src/core/service-api.ts";
import type { Factory } from "../../src/server/main.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/layers/", import.meta.url));

const LIQUID_TOOLS = new Set(["rebuild_web", "restart_factory", "screenshot"]);
const P5_TOOLS = new Set([
  "get_context", "set_compaction", "compact", "list_models", "refresh_models", "set_model", "set_thinking_level", "list_prompts",
  "get_prompt", "set_system_prompt", "create_custom_prompt", "update_custom_prompt", "delete_custom_prompt", "toggle_prompt",
  "append_runtime_prompt", "remove_runtime_prompt", "clear_runtime_prompts", "list_tools", "describe_tool", "set_tool_enabled",
  "list_layers", "set_layer_enabled", "get_ceiling", "list_runs", "get_run",
  // P6 (api-p6.test.ts)
  "list_crons", "create_cron", "update_cron", "delete_cron", "run_cron_now",
  // P9 (layers-authoring.test.ts)
  "get_settings", "create_layer", "delete_layer", "list_layer_files", "read_layer_file", "write_layer_file", "delete_layer_file",
  "reload_layers", "define_widget", "undefine_widget", "export_layer", "import_layer",
]);

let factory: Factory & { root: string };
let events: AppEvent[];

beforeEach(async () => {
  const { root, paths } = await makeProject();
  await cp(join(FIXTURES, "counter"), join(paths.layersDir, "counter"), { recursive: true });
  factory = await createTestFactory({ project: root });
  events = [];
  const publish = factory.hub.publish.bind(factory.hub);
  vi.spyOn(factory.hub, "publish").mockImplementation((d: Delta) => {
    if ("type" in d) events.push(d as AppEvent);
    return publish(d);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await factory.close();
  await cleanupTmp();
});

const get = (path: string) => factory.app.request(`/api/${path}`);
const post = (path: string, body: unknown = {}) =>
  factory.app.request(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const count = (type: string) => events.filter((e) => e.type === type).length;
const config = () => factory.service.getUiConfig();

describe("widgets", () => {
  it("lists the built-in types, the layer's widget and the placements", async () => {
    const list = (await (await get("widgets")).json()) as WidgetList;
    expect(list.available.map((w) => w.widget)).toEqual(
      expect.arrayContaining(["context_bar", "agent_status", "factory_name", "cron_status", "counter.value"]),
    );
    expect(list.available.find((w) => w.widget === "counter.value")).toMatchObject({ layer: "counter", navbars: ["global"] });
    expect(list.placements.map((p) => `${p.navbar}:${p.id}`)).toEqual(["global:factory_name-1", "global:cron_status-1", "agent:agent_status-1"]);
  });

  it("adds a context_bar to the agent navbar: id, event, config", async () => {
    const res = await post("widgets/add", { navbar: "agent", widget: "context_bar", slot: "right" });
    expect(res.status).toBe(200);
    const placed = (await res.json()) as PlacedWidget;
    expect(placed).toMatchObject({ id: "context_bar-1", navbar: "agent", slot: "right", widget: "context_bar" });
    expect(config().navbars.agent.items.map((p) => p.id)).toEqual(["agent_status-1", "context_bar-1"]);
    expect(count("ui_config.changed")).toBe(1);
    const second = (await (await post("widgets/add", { navbar: "agent", widget: "context_bar", slot: "left", index: 0 })).json()) as PlacedWidget;
    expect(second.id).toBe("context_bar-2");
    expect(config().navbars.agent.items[0]!.id).toBe("context_bar-2");
  });

  it("an agent call id gives a stable id: a replayed add finds its own placement", async () => {
    const origin = { by: "agent", callId: "call-1" } as const;
    const a = await factory.service.addWidget({ navbar: "global", widget: "context_bar", slot: "center" }, origin);
    const b = await factory.service.addWidget({ navbar: "global", widget: "context_bar", slot: "center" }, origin);
    expect(b.id).toBe(a.id);
    expect(config().navbars.global.items.filter((p) => p.widget === "context_bar")).toHaveLength(1);
    expect(count("ui_config.changed")).toBe(1);
  });

  it("validates navbar, slot, widget type and layer widget placement", async () => {
    expect(await errorCode(await post("widgets/add", { navbar: "side", widget: "context_bar", slot: "left" }))).toBe("invalid");
    expect(await errorCode(await post("widgets/add", { navbar: "agent", widget: "context_bar", slot: "top" }))).toBe("invalid");
    expect(await errorCode(await post("widgets/add", { navbar: "agent", widget: "nope", slot: "left" }))).toBe("invalid");
    // counter.value is allowed in the global navbar only.
    expect(await errorCode(await post("widgets/add", { navbar: "agent", widget: "counter.value", slot: "left" }))).toBe("invalid");
    expect((await post("widgets/add", { navbar: "global", widget: "counter.value", slot: "right" })).status).toBe(200);
    expect(config().navbars.global.items.at(-1)).toMatchObject({ widget: "counter.value", options: { fullWidth: false } });
  });

  it("moves between slots and navbars, sets options, removes", async () => {
    const moved = (await (await post("widgets/move", { id: "agent_status-1", navbar: "global", slot: "center", index: 0 })).json()) as PlacedWidget;
    expect(moved).toMatchObject({ navbar: "global", slot: "center" });
    expect(config().navbars.global.items.map((p) => p.id)).toEqual(["agent_status-1", "factory_name-1", "cron_status-1"]);
    expect(config().navbars.agent.items).toEqual([]);
    expect(count("ui_config.changed")).toBe(1);

    const opt = (await (await post("widgets/options", { id: "factory_name-1", options: { fullWidth: true } })).json()) as PlacedWidget;
    expect(opt.options).toEqual({ fullWidth: true });
    await post("widgets/options", { id: "factory_name-1", options: { fullWidth: null } });
    expect(config().navbars.global.items.find((p) => p.id === "factory_name-1")!.options).toEqual({});

    expect((await post("widgets/remove", { id: "cron_status-1" })).status).toBe(200);
    expect(config().navbars.global.items.map((p) => p.id)).not.toContain("cron_status-1");
    expect(await errorCode(await post("widgets/remove", { id: "cron_status-1" }))).toBe("not_found");
    expect(await errorCode(await post("widgets/move", { id: "x", index: 0 }))).toBe("not_found");
    expect(await errorCode(await post("widgets/move", { id: "factory_name-1" }))).toBe("invalid");
    expect(await errorCode(await post("widgets/options", { id: "factory_name-1", options: { fullWidth: "yes" } }))).toBe("invalid");
  });
});

describe("hotkeys", () => {
  it("lists built-ins and the layer's hotkey, bound to its default key at boot", async () => {
    const list = (await (await get("hotkeys")).json()) as HotkeyInfo[];
    expect(list.find((h) => h.action === "settings.open")).toMatchObject({ key: "s", defaultKey: "s", layer: null });
    expect(list.find((h) => h.action === "counter.bump")).toMatchObject({ key: "b", defaultKey: "b", layer: "counter" });
    expect(config().hotkeys["counter.bump"]).toBe("b");
  });

  it("sets a key, refuses a duplicate and an unknown action", async () => {
    const res = await post("hotkeys/set", { action: "settings.open", key: "F2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: "settings.open", key: "F2" });
    expect(config().hotkeys["settings.open"]).toBe("F2");
    expect(count("ui_config.changed")).toBe(1);
    expect(await errorCode(await post("hotkeys/set", { action: "cron.open", key: "f2" }))).toBe("invalid");
    expect(await errorCode(await post("hotkeys/set", { action: "nope.nothing", key: "q" }))).toBe("not_found");
    expect(await errorCode(await post("hotkeys/set", { action: "cron.open", key: "two words" }))).toBe("invalid");
  });
});

describe("themes", () => {
  it("lists PW themes and the snapshot carries the list, the active name and the CSS", async () => {
    const list = (await (await get("themes")).json()) as ThemeInfo[];
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(["precision-weave-neon", "precision-weave"]));
    const snap = factory.service.snapshot();
    expect(snap.themes.map((t) => t.name)).toEqual(list.map((t) => t.name));
    expect(snap.uiConfig.theme.name).toBe("precision-weave-neon");
    expect(snap.themeCss).toContain("--pw-ai-glow");
  });

  it("set: another theme and mode, ui_config.changed then theme.applied with the CSS, getThemeCss follows", async () => {
    const res = await post("themes/set", { name: "precision-weave", mode: "dark" });
    expect(res.status).toBe(200);
    const r = (await res.json()) as ThemeResult;
    expect(r).toMatchObject({ active: true, theme: { name: "precision-weave" } });
    expect(config().theme).toEqual({ name: "precision-weave", mode: "dark" });
    const types = events.map((e) => e.type);
    expect(types.indexOf("ui_config.changed")).toBeLessThan(types.indexOf("theme.applied"));
    const applied = events.find((e) => e.type === "theme.applied") as Extract<AppEvent, { type: "theme.applied" }>;
    expect(applied.name).toBe("precision-weave");
    expect(applied.css).toBe(factory.service.getThemeCss());
    expect(applied.css).not.toContain("backdrop-filter");
    expect(await errorCode(await post("themes/set", { name: "nope" }))).toBe("not_found");
    expect(await errorCode(await post("themes/set", { name: "precision-weave", mode: "blue" }))).toBe("invalid");
  });

  it("a theme patch through ui-config/update is still refused", async () => {
    expect(await errorCode(await post("ui-config/update", { patch: { theme: { name: "precision-weave" } } }))).toBe("invalid");
  });

  it("create makes the theme active; values apply live; check/fix; delete falls back to Neon", async () => {
    const created = await post("themes/create", {
      name: "ocean",
      title: "Ocean",
      base: "precision-weave-neon",
      seeds: { brand: "#1A5C8C" },
      tokens: { "text-3": { light: "#CCCCCC" } },
    });
    expect(created.status).toBe(200);
    const c = (await created.json()) as ThemeResult;
    expect(c).toMatchObject({ active: true, theme: { name: "ocean", kind: "custom" } });
    expect(c.check.warnings.some((w) => w.includes("text-3"))).toBe(true);
    expect(config().theme.name).toBe("ocean");
    expect(count("themes.changed")).toBe(1);
    expect(count("theme.applied")).toBe(1);
    expect(factory.service.getThemeCss()).toContain("Theme: Ocean (ocean)");
    expect(factory.service.getThemeCss()).toContain("backdrop-filter");

    // Values: applied live on the active theme.
    const v = (await (await post("themes/values", { name: "ocean", tokens: { canvas: { dark: "#0A1018" } } })).json()) as ThemeResult;
    expect(v.theme.definition?.tokens.canvas).toEqual({ dark: "#0A1018" });
    expect(factory.service.getThemeCss()).toContain("#0A1018");
    expect(count("theme.applied")).toBe(2);
    expect(count("themes.changed")).toBe(2);

    const check = (await (await post("themes/check", { name: "ocean" })).json()) as ThemeCheck;
    expect(check.fixes.length).toBeGreaterThan(0);
    const fixed = (await (await post("themes/fix", { name: "ocean" })).json()) as ThemeResult & { applied: unknown[] };
    expect(fixed.applied.length).toBe(check.fixes.length);
    expect(fixed.check.warnings.filter((w) => w.includes("text-3"))).toEqual([]);

    // A PW theme cannot be edited or deleted.
    expect(await errorCode(await post("themes/values", { name: "precision-weave", tokens: { canvas: "#fff" } }))).toBe("invalid");
    expect(await errorCode(await post("themes/delete", { name: "precision-weave" }))).toBe("invalid");

    const del = (await (await post("themes/delete", { name: "ocean" })).json()) as { active: string };
    expect(del.active).toBe("precision-weave-neon");
    expect(config().theme.name).toBe("precision-weave-neon");
    expect(factory.service.listThemes().some((t) => t.name === "ocean")).toBe(false);
    expect(factory.service.getThemeCss()).toContain("--pw-ai-glow");
    expect(await errorCode(await post("themes/delete", { name: "ocean" }))).toBe("not_found");
  });

  it("an invalid create stores nothing; a custom theme survives a restart and stays active", async () => {
    expect(await errorCode(await post("themes/create", { name: "bad", base: "precision-weave", tokens: { canvas: "oops" } }))).toBe("invalid");
    expect(factory.service.listThemes().some((t) => t.name === "bad")).toBe(false);
    await post("themes/create", { name: "keep", base: "precision-weave", tokens: { canvas: { light: "#F1F1F1" } } });
    const root = factory.root;
    await factory.close();
    factory = await createTestFactory({ project: root });
    expect(factory.service.getUiConfig().theme.name).toBe("keep");
    expect(factory.service.getThemeCss()).toContain("#F1F1F1");
    expect(factory.service.snapshot().themes.some((t) => t.name === "keep")).toBe(true);
  });
});

describe("ui/open", () => {
  it("publishes ui.open with the actor", async () => {
    const res = await post("ui/open", { target: "settings", section: "essentials" });
    expect(res.status).toBe(200);
    expect(events.find((e) => e.type === "ui.open")).toEqual({ type: "ui.open", target: "settings", section: "essentials", by: "ui" });
    expect(await errorCode(await post("ui/open", { target: "elsewhere" }))).toBe("invalid");
    expect(await errorCode(await post("ui/open", {}))).toBe("invalid");
  });
});

describe("layer handlers", () => {
  const q = (name: string, input?: unknown) =>
    get(`layers/counter/query/${name}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`);

  it("runs a query and an action; an action publishes layer.changed and is visible to the next query", async () => {
    expect(await (await q("get")).json()).toEqual({ count: 0 });
    expect(await (await q("echo", { a: [1, 2] })).json()).toEqual({ input: { a: [1, 2] } });
    const res = await post("layers/counter/action/bump", { input: { by: 5 } });
    expect(await res.json()).toEqual({ count: 5 });
    expect(events.find((e) => e.type === "layer.changed")).toEqual({ type: "layer.changed", layer: "counter", by: "ui" });
    expect(await (await q("get")).json()).toEqual({ count: 5 });
  });

  it("not_found for an unknown layer or handler, invalid for bad input, a throwing handler is internal and publishes nothing", async () => {
    expect(await errorCode(await get("layers/nope/query/get"))).toBe("not_found");
    expect(await errorCode(await q("nope"))).toBe("not_found");
    expect(await errorCode(await post("layers/counter/action/get"))).toBe("not_found");
    expect(await errorCode(await post("layers/counter/action/Bad-Name"))).toBe("invalid");
    expect(await errorCode(await get("layers/counter/query/get?input=%7Bnot"))).toBe("invalid");
    expect(await errorCode(await post("layers/counter/action/fail", { input: {} }))).toBe("internal");
    expect(count("layer.changed")).toBe(0);
  });

  it("serialises actions on layer:<name>", async () => {
    await Promise.all(Array.from({ length: 10 }, () => post("layers/counter/action/bump", { input: { by: 1 } })));
    expect(await (await q("get")).json()).toEqual({ count: 10 });
  });
});

describe("the factory_controls tools (probe)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type ToolItem = Extract<ChatItem, { kind: "tool" }>;

  async function probe(tool: string, args: unknown): Promise<ToolItem> {
    const before = factory.service.chatView().items.filter((i) => i.kind === "tool").length;
    await factory.service.sendMessage({ text: `probe ${tool} ${JSON.stringify(args)}`, requestId: `p-${Math.random().toString(36).slice(2)}` }, { by: "ui" });
    const end = Date.now() + 20_000;
    for (;;) {
      const v = factory.service.chatView();
      const tools = v.items.filter((i): i is ToolItem => i.kind === "tool");
      if (!v.live.busy && tools.length > before && v.items.some((i) => i.kind === "assistant" && i.text.includes("probe done"))) return tools.at(-1)!;
      if (Date.now() > end) throw new Error("timed out waiting for the probe");
      await sleep(25);
    }
  }

  it("registers the 17 P4 tools in factory_controls with the replay table", () => {
    // The P5 Core 4 tools join this layer (api-p5.test.ts); this table is the P4 ones.
    const isP4 = (name: string) => !P5_TOOLS.has(name) && !LIQUID_TOOLS.has(name);
    const infos = factory.service.listTools().filter((t) => t.layer === "factory_controls" && isP4(t.name));
    expect(Object.fromEntries(infos.map((t) => [t.name, t.replay]))).toEqual({
      get_ui_config: "safe",
      update_ui_config: "safe",
      list_widgets: "safe",
      add_widget: "safe",
      remove_widget: "unsafe",
      move_widget: "safe",
      set_widget_options: "safe",
      list_hotkeys: "safe",
      set_hotkey: "safe",
      list_themes: "safe",
      set_theme: "safe",
      create_theme: "safe",
      set_theme_values: "safe",
      check_theme: "safe",
      fix_theme: "unsafe",
      delete_theme: "unsafe",
      open_panel: "safe",
    });
    const layer = factory.service.listLayers().find((l) => l.name === "factory_controls")!;
    expect(layer.sections).toEqual(["factory_controls-rules"]);
  });

  it("set_theme changes the theme and the CSS", async () => {
    const t = await probe("set_theme", { name: "precision-weave", mode: "dark" });
    expect(t.status).toBe("done");
    expect(config().theme).toEqual({ name: "precision-weave", mode: "dark" });
    expect(count("theme.applied")).toBe(1);
  });

  it("add_widget then list_widgets show the placement; a bad call is an error result the model can read", async () => {
    const added = await probe("add_widget", { navbar: "agent", widget: "context_bar", slot: "right" });
    expect(added.status).toBe("done");
    expect(config().navbars.agent.items.some((p) => p.widget === "context_bar")).toBe(true);
    const bad = await probe("set_theme", { name: "nope" });
    expect(bad.status).toBe("failed");
    expect(bad.output).toContain("no such theme");
  });

  it("update_ui_config patches panes; the theme stays refused; open_panel publishes ui.open", async () => {
    expect((await probe("update_ui_config", { patch: { panes: { left: { visible: false } } } })).status).toBe("done");
    expect(config().panes.left.visible).toBe(false);
    const refused = await probe("update_ui_config", { patch: { theme: { name: "precision-weave" } } });
    expect(refused.status).toBe("failed");
    expect(refused.output).toContain("set_theme");
    expect((await probe("open_panel", { target: "settings", section: "advanced" })).status).toBe("done");
    expect(events.find((e) => e.type === "ui.open")).toMatchObject({ target: "settings", section: "advanced", by: "agent" });
  });

  it("create_theme through a tool call, replayed with the same call id, makes one theme", async () => {
    const origin = { by: "agent", callId: "c-9" } as const;
    const input = { name: "replayed", base: "precision-weave", tokens: { canvas: "#EEEEEE" } };
    await factory.service.createTheme(input, origin);
    await factory.service.createTheme(input, origin);
    expect(factory.service.listThemes().filter((t) => t.name === "replayed")).toHaveLength(1);
    expect(count("themes.changed")).toBe(1);
  });

  it("the UI config at the end is still valid", () => {
    const c: UiConfig = config();
    expect(c.version).toBeGreaterThanOrEqual(1);
  });
});
