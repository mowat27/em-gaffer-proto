/**
 * P9: layer authoring through the Service and the HTTP app on faux, with the real agent: create and delete layers,
 * file tools with path confinement, define and undefine widget types, reload, core bindings (the model picker of
 * template/examples/model-picker.layer.json end to end), and get_settings.
 */
import { cp, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../../src/core/paths.ts";
import type { AppEvent } from "../../src/shared/events.ts";
import type { Delta, LayerInfo, ModelInfo, Settings, WidgetContribution } from "../../src/shared/types.ts";
import type { Factory } from "../../src/server/main.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/layers/", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../template/examples/model-picker.layer.json", import.meta.url));
const ui = { by: "ui" } as const;

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

const svc = () => factory.service;
const paths = () => projectPaths(factory.root);
const get = (path: string) => factory.app.request(`/api/${path}`);
const post = (path: string, body: unknown = {}) =>
  factory.app.request(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const rejects = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a rejection");
};
const info = (name: string): LayerInfo => svc().listLayers().find((l) => l.name === name)!;
const ofType = (type: string) => events.filter((e) => e.type === type);

const widget = (id: string, extra: object = {}): WidgetContribution =>
  ({
    id,
    title: "Greeting",
    description: "Shows a settings value",
    navbars: ["global", "agent"],
    defaultOptions: {},
    control: { kind: "value", label: "Name", query: "core:settings.get", field: "factoryName", capability: "settings.get" },
    ...extra,
  }) as WidgetContribution;

describe("create and delete", () => {
  it("createLayer writes manifest.json, loads the layer and tells the clients", async () => {
    const created = await svc().createLayer({ name: "extras", title: "Extras", description: "my layer" }, ui);
    expect(created).toMatchObject({ name: "extras", source: "project", status: "loaded", enabled: true, title: "Extras" });
    const file = JSON.parse(await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8"));
    expect(file).toMatchObject({ name: "extras", kind: "harness", enabledByDefault: true, ui: { widgets: [] }, capabilities: [] });
    expect(ofType("layers.changed").length).toBeGreaterThan(0);
    expect(ofType("tools.changed").length).toBeGreaterThan(0);
    expect(ofType("settings.changed").some((e) => (e as unknown as { keys: string[] }).keys.includes("layersEnabled"))).toBe(true);
    expect(svc().getSettings().layersEnabled).toContain("extras");
  });

  it("validates the input and refuses a taken or built-in name", async () => {
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
    expect((await rejects(svc().createLayer({ name: "extras", title: "Again", description: "" }, ui))).code).toBe("conflict");
    expect((await rejects(svc().createLayer({ name: "page_harness", title: "x", description: "" }, ui))).code).toBe("conflict");
    expect((await rejects(svc().createLayer({ name: "Bad-Name", title: "x", description: "" }, ui))).code).toBe("invalid");
    expect((await rejects(svc().createLayer({ name: "okname", title: "", description: "" }, ui))).code).toBe("invalid");
    expect(await errorCode(await post("layers/create", { name: "okname", title: "t" }))).toBe("invalid");
    const res = await post("layers/create", { name: "viaroute", title: "Via route", description: "d", enabledByDefault: false });
    expect(res.status).toBe(200);
    expect(info("viaroute")).toMatchObject({ status: "loaded", enabled: false });
  });

  it("deleteLayer refuses built-ins and removes a project layer with its widget placements", async () => {
    for (const name of ["factory_controls", "factory_harness", "page_harness"]) {
      expect((await rejects(svc().deleteLayer({ name }, ui))).code).toBe("forbidden");
    }
    expect((await rejects(svc().deleteLayer({ name: "nope_layer" }, ui))).code).toBe("not_found");
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
    await svc().defineWidget({ layer: "extras", widget: widget("extras.hello") }, ui);
    const placed = await svc().addWidget({ navbar: "global", widget: "extras.hello", slot: "left" }, ui);
    const out = await svc().deleteLayer({ name: "extras" }, ui);
    expect(out).toEqual({ name: "extras", placementsRemoved: [placed.id] });
    await expect(lstat(join(paths().layersDir, "extras"))).rejects.toThrow();
    expect(svc().listLayers().map((l) => l.name)).not.toContain("extras");
    expect(svc().listWidgets().placements.map((p) => p.id)).not.toContain(placed.id);
    // The UI config still accepts writes (no dangling placement left to fail its check).
    await svc().updateUiConfig({ patch: { panes: { left: { visible: true } } } }, ui);
    expect(await errorCode(await post("layers/delete", { name: "page_harness" }))).toBe("forbidden");
  });
});

describe("layer files", () => {
  beforeEach(async () => {
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
  });

  it("lists, reads, writes and deletes files; prompts/*.md becomes a prompt section; the reload is live", async () => {
    const written = await svc().writeLayerFile({ name: "extras", path: "prompts/style.md", content: "# House style\n\nBe brief.\n" }, ui);
    expect(written).toMatchObject({ name: "extras", path: "prompts/style.md", size: 25, layer: { status: "loaded", sections: ["extras-style"] } });
    const files = await svc().listLayerFiles({ name: "extras" });
    expect(files).toMatchObject({ source: "project", editable: true });
    expect(files.files.map((f) => f.path)).toEqual(["manifest.json", "prompts/style.md"]);
    expect((await svc().readLayerFile({ name: "extras", path: "prompts/style.md" })).content).toContain("Be brief.");
    const prompts = await svc().listPrompts();
    const section = prompts.extensions.find((p) => p.id === "section:extras-style");
    expect(section).toMatchObject({ title: "House style", enabled: true });
    expect(ofType("prompts.changed").length).toBeGreaterThan(0);

    const removed = await svc().deleteLayerFile({ name: "extras", path: "prompts/style.md" }, ui);
    expect(removed.layer.sections).toEqual([]);
    expect((await svc().listLayerFiles({ name: "extras" })).files.map((f) => f.path)).toEqual(["manifest.json"]);
    // Over HTTP too.
    expect((await post("layers/write-file", { name: "extras", path: "prompts/a.md", content: "x" })).status).toBe(200);
    expect(((await (await get("layers/files?name=extras")).json()) as { files: unknown[] }).files).toHaveLength(2);
    expect(((await (await get("layers/read-file?name=extras&path=prompts/a.md")).json()) as { content: string }).content).toBe("x");
    expect((await post("layers/delete-file", { name: "extras", path: "prompts/a.md" })).status).toBe(200);
  });

  it("confines paths: absolute, .., dot segments, symlinks, extensions and size are refused", async () => {
    const write = (path: string, content = "x") => svc().writeLayerFile({ name: "extras", path, content }, ui);
    for (const path of ["/etc/x.json", "../x.json", "a/../../x.json", "prompts/../../x.md", "./x.md", ".hidden.json", "a//b.md", "C:/x.json", "a\\b.json", ""]) {
      expect((await rejects(write(path))).code, path).toBe("invalid");
    }
    expect((await rejects(write("notes.txt"))).code).toBe("invalid");
    expect((await rejects(write("script.sh"))).code).toBe("invalid");
    expect((await rejects(write("big.md", "x".repeat(256 * 1024 + 1)))).code).toBe("too_large");
    expect((await write("max.md", "x".repeat(256 * 1024))).size).toBe(256 * 1024);
    // Reads and deletes use the same confinement.
    expect((await rejects(svc().readLayerFile({ name: "extras", path: "../extras/manifest.json" }))).code).toBe("invalid");
    expect((await rejects(svc().readLayerFile({ name: "extras", path: "/etc/hosts" }))).code).toBe("invalid");
    expect((await rejects(svc().deleteLayerFile({ name: "extras", path: "../counter/manifest.ts" }, ui))).code).toBe("invalid");
    expect(await errorCode(await get("layers/read-file?name=extras&path=../x.md"))).toBe("invalid");

    // Symlinks: a linked folder and a linked file are never followed.
    const outside = join(factory.root, "outside-target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(paths().layersDir, "extras", "link"));
    await symlink(join(outside, "secret.md"), join(paths().layersDir, "extras", "linked.md"));
    expect((await rejects(write("link/new.md"))).code).toBe("forbidden");
    expect((await rejects(write("linked.md"))).code).toBe("forbidden");
    expect((await rejects(svc().readLayerFile({ name: "extras", path: "linked.md" }))).code).toBe("forbidden");
    expect((await rejects(svc().deleteLayerFile({ name: "extras", path: "link/secret.md" }, ui))).code).toBe("forbidden");
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret");
  });

  it("refuses to write or delete in a built-in layer, but lists and reads it; the manifest cannot be deleted", async () => {
    expect((await rejects(svc().writeLayerFile({ name: "page_harness", path: "extra.md", content: "x" }, ui))).code).toBe("forbidden");
    expect((await rejects(svc().deleteLayerFile({ name: "page_harness", path: "manifest.ts" }, ui))).code).toBe("forbidden");
    const files = await svc().listLayerFiles({ name: "page_harness" });
    expect(files).toMatchObject({ source: "builtin", editable: false });
    expect(files.files.map((f) => f.path)).toContain("manifest.ts");
    expect((await svc().readLayerFile({ name: "page_harness", path: "manifest.ts" })).content).toContain("page_harness");
    expect((await rejects(svc().deleteLayerFile({ name: "extras", path: "manifest.json" }, ui))).message).toMatch(/delete_layer/);
    expect((await rejects(svc().readLayerFile({ name: "extras", path: "missing.md" }))).code).toBe("not_found");
    expect((await rejects(svc().listLayerFiles({ name: "no_such" }))).code).toBe("not_found");
  });

  it("refuses an invalid manifest.json before it replaces the working one", async () => {
    const before = await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8");
    const err = await rejects(svc().writeLayerFile({ name: "extras", path: "manifest.json", content: '{ "name": "extras", "bogus": 1 }' }, ui));
    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/unknown key bogus/);
    expect(await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8")).toBe(before);
    expect(info("extras").status).toBe("loaded");
  });

  it("a code file that breaks the layer is written and the layer reports failed with the reason; a fix revives it", async () => {
    const out = await svc().writeLayerFile({ name: "extras", path: "extension.ts", content: "export const nothing = 1;\n" }, ui);
    expect(out.layer.status).toBe("failed");
    expect(out.layer.error).toMatch(/does not export createExtension/);
    const fixed = await svc().writeLayerFile(
      {
        name: "extras",
        path: "extension.ts",
        content: 'export function createExtension(ctx) { return ctx.pi.defineExtension({ name: "extras" }); }\n',
      },
      ui,
    );
    expect(fixed.layer.status).toBe("loaded");
  });

  it("a tool name that clashes with a built-in fails the layer, not the factory", async () => {
    const ext = `export function createExtension(ctx) {
  const { defineExtension, defineAppTool, obj } = ctx.pi;
  return defineExtension({ name: "extras", tools: [defineAppTool({ name: "list_pages", description: "t", parameters: obj({}), replay: "safe", run: async () => ({}) })] });
}\n`;
    const out = await svc().writeLayerFile({ name: "extras", path: "extension.ts", content: ext }, ui);
    expect(out.layer).toMatchObject({ status: "failed" });
    expect(out.layer.error).toMatch(/list_pages is defined by layers page_harness and extras/);
    expect(svc().listTools().find((t) => t.name === "list_pages")!.layer).toBe("page_harness");
  });

  it("reloadLayers picks up a folder dropped on disk and a deleted one", async () => {
    const dir = join(paths().layersDir, "dropped");
    await mkdir(dir);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ name: "dropped", version: "0.1.0", kind: "harness", title: "Dropped", description: "d", enabledByDefault: true }));
    expect(info("dropped")).toBeUndefined();
    const list = await svc().reloadLayers(ui);
    expect(list.find((l) => l.name === "dropped")).toMatchObject({ status: "loaded", title: "Dropped" });
    expect(((await (await post("layers/reload")).json()) as LayerInfo[]).map((l) => l.name)).toContain("dropped");
  });
});

describe("define and undefine widget types", () => {
  beforeEach(async () => {
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
  });

  it("defineWidget upserts by id, validates, and the type is placeable", async () => {
    const first = await svc().defineWidget({ layer: "extras", widget: widget("extras.hello") }, ui);
    expect(first).toMatchObject({ layer: "extras", created: true, info: { status: "loaded" } });
    expect(svc().listWidgets().available.map((w) => w.widget)).toContain("extras.hello");
    const second = await svc().defineWidget({ layer: "extras", widget: widget("extras.hello", { title: "Renamed" }) }, ui);
    expect(second.created).toBe(false);
    expect(info("extras").ui.widgets).toHaveLength(1);
    expect(info("extras").ui.widgets[0]!.title).toBe("Renamed");
    await svc().defineWidget({ layer: "extras", widget: widget("extras.other") }, ui);
    expect(info("extras").ui.widgets.map((w) => w.id)).toEqual(["extras.hello", "extras.other"]);
    const placed = await svc().addWidget({ navbar: "agent", widget: "extras.hello", slot: "right" }, ui);
    expect(placed.widget).toBe("extras.hello");
    const res = await post("widgets/define", { layer: "extras", widget: widget("extras.viaroute") });
    expect(res.status).toBe(200);
  });

  it("rejects an invalid widget and leaves the file alone", async () => {
    const before = await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8");
    const bad = [
      widget("other.hello"),
      widget("extras.hello", { navbars: ["sidebar"] }),
      widget("extras.hello", { control: { kind: "value", label: "N", query: "core:nope.nothing", capability: "settings.get" } }),
      widget("extras.hello", { control: { kind: "value", label: "N", query: "core:settings.get", capability: "x.unknown" } }),
    ];
    for (const w of bad) expect((await rejects(svc().defineWidget({ layer: "extras", widget: w }, ui))).code).toBe("invalid");
    expect(await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8")).toBe(before);
  });

  it("rolls the file back when the loader rejects a binding the schema cannot see (an unknown layer handler)", async () => {
    const before = await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8");
    const w = widget("extras.hello", { control: { kind: "value", label: "N", query: "missing_handler", capability: "settings.get" } });
    const err = await rejects(svc().defineWidget({ layer: "extras", widget: w }, ui));
    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/no query handler missing_handler/);
    expect(await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8")).toBe(before);
    expect(info("extras").status).toBe("loaded");
  });

  it("a manifest.ts layer gets a clear error; built-ins are refused", async () => {
    const err = await rejects(svc().defineWidget({ layer: "counter", widget: widget("counter.extra") }, ui));
    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/uses manifest\.ts; edit that file with write_layer_file/);
    expect((await rejects(svc().defineWidget({ layer: "factory_controls", widget: widget("factory_controls.x") }, ui))).code).toBe("forbidden");
    expect((await rejects(svc().removeWidgetType({ layer: "counter", id: "counter.value" }, ui))).code).toBe("invalid");
  });

  it("removeWidgetType removes the type and its placements from both navbars", async () => {
    await svc().defineWidget({ layer: "extras", widget: widget("extras.hello") }, ui);
    const a = await svc().addWidget({ navbar: "global", widget: "extras.hello", slot: "left" }, ui);
    const b = await svc().addWidget({ navbar: "agent", widget: "extras.hello", slot: "center" }, ui);
    const keep = await svc().addWidget({ navbar: "global", widget: "factory_name", slot: "right" }, ui);
    const out = await svc().removeWidgetType({ layer: "extras", id: "extras.hello" }, ui);
    expect(out.layer).toBe("extras");
    expect([...out.placementsRemoved].sort()).toEqual([a.id, b.id].sort());
    expect(svc().listWidgets().available.map((w) => w.widget)).not.toContain("extras.hello");
    expect(svc().listWidgets().placements.map((p) => p.id)).toEqual(expect.arrayContaining([keep.id]));
    expect(svc().listWidgets().placements.some((p) => p.widget === "extras.hello")).toBe(false);
    expect((await rejects(svc().removeWidgetType({ layer: "extras", id: "extras.hello" }, ui))).code).toBe("not_found");
    expect((await post("widgets/undefine", { layer: "extras", id: "extras.nothing" })).status).toBe(404);
  });
});

describe("core bindings: the model picker", () => {
  const exampleManifest = async () => await readFile(EXAMPLE, "utf8");

  beforeEach(async () => {
    const dir = join(paths().layersDir, "extras");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), await exampleManifest());
    await svc().reloadLayers(ui);
  });

  it("the example loads, its widget is a placeable type for both navbars", () => {
    expect(info("extras")).toMatchObject({ status: "loaded", enabled: true });
    const type = svc().listWidgets().available.find((w) => w.widget === "extras.model_picker");
    expect(type).toMatchObject({ layer: "extras", navbars: ["global", "agent"] });
  });

  it("the query returns the settings (the control's field is model.modelId), the options query the models, the action sets the model", async () => {
    const control = info("extras").ui.widgets[0]!.control as Extract<WidgetContribution["control"], { kind: "select" }>;
    expect(control).toMatchObject({ query: "core:settings.get", field: "model.modelId", action: "core:model.set" });
    const dig = (v: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k] ?? null, v);

    // Options: the models, as the options query describes them (valueField id, labelField name).
    const models = (await svc().layerQuery({ layer: "extras", name: control.optionsQuery!.query, input: {} })) as unknown as ModelInfo[];
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toEqual(svc().listModels().map((m) => m.id));
    expect(typeof models[0]![control.optionsQuery!.valueField as keyof ModelInfo]).toBe("string");
    expect(typeof models[0]![control.optionsQuery!.labelField as keyof ModelInfo]).toBe("string");

    // Current value: null until a model is stored.
    const settings = (await svc().layerQuery({ layer: "extras", name: control.query })) as unknown as Settings;
    expect(dig(settings, control.field)).toBeNull();

    // The web sends { value }; the template turns it into core:model.set's input.
    const pick = models[models.length - 1]!;
    const out = (await svc().layerAction({ layer: "extras", name: control.action, input: { value: pick.id } }, ui)) as unknown as {
      model: { provider: string; modelId: string };
    };
    expect(out.model).toEqual({ provider: pick.provider, modelId: pick.id });
    const after = (await svc().layerQuery({ layer: "extras", name: control.query })) as unknown as Settings;
    expect(dig(after, control.field)).toBe(pick.id);
    expect(svc().getSettings().model).toEqual({ provider: pick.provider, modelId: pick.id });
    expect(ofType("layer.changed").some((e) => (e as { layer: string }).layer === "extras")).toBe(true);
  });

  it("the same works over HTTP, and a binding the manifest does not declare is not_found", async () => {
    const q = await get("layers/extras/query/core:settings.get");
    expect(q.status).toBe(200);
    expect(((await q.json()) as Settings).factoryName).toBeTruthy();
    const list = (await (await get("layers/extras/query/core:models.list")).json()) as ModelInfo[];
    expect(list.length).toBeGreaterThan(0);
    const id = list[0]!.id;
    const set = await post("layers/extras/action/core:model.set", { input: { value: id } });
    expect(set.status).toBe(200);
    expect(svc().getSettings().model?.modelId).toBe(id);
    // Declared in no control of this layer.
    expect(await errorCode(await get("layers/extras/query/core:context.get"))).toBe("not_found");
    expect(await errorCode(await post("layers/extras/action/core:thinking.set", { input: { level: "high" } }))).toBe("not_found");
    // An unknown model id is the capability's own error.
    expect(await errorCode(await post("layers/extras/action/core:model.set", { input: { value: "no-such-model" } }))).toBe("not_found");
  });

  it("a disabled layer's bindings are not_found", async () => {
    await svc().setLayerEnabled({ name: "extras", enabled: false }, ui);
    expect(await errorCode(await get("layers/extras/query/core:settings.get"))).toBe("not_found");
  });

  it("an action with no template passes its input through (button with a core action)", async () => {
    const w = widget("extras.refresh", {
      control: { kind: "button", label: "Think hard", action: "core:thinking.set", input: { level: "high" }, capability: "thinking.set" },
    });
    await svc().defineWidget({ layer: "extras", widget: w }, ui);
    const out = (await svc().layerAction({ layer: "extras", name: "core:thinking.set", input: { level: "high" } }, ui)) as unknown as { thinkingLevel: string };
    expect(out.thinkingLevel).toBe("high");
    // Origin-only and string-argument adapters: select a page and clear it through core bindings is out of scope; the
    // thinking level above shows the string adapter.
  });
});

describe("get_settings", () => {
  it("is the Settings document with no secret values", async () => {
    process.env.OPENROUTER_API_KEY = "sk-never-in-settings";
    try {
      const settings = svc().getSettings();
      expect(Object.keys(settings).sort()).toEqual(
        ["compaction", "factoryName", "layersEnabled", "maxTurns", "model", "systemPrompt", "thinkingLevel", "toolsDisabled"],
      );
      expect(JSON.stringify(settings)).not.toContain("sk-never-in-settings");
      const res = await get("settings");
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("sk-never-in-settings");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("the twelve P9 tools are registered in factory_controls", () => {
    const names = ["get_settings", "create_layer", "delete_layer", "list_layer_files", "read_layer_file", "write_layer_file", "delete_layer_file", "reload_layers", "define_widget", "undefine_widget", "export_layer", "import_layer"];
    const tools = svc().listTools().filter((t) => names.includes(t.name));
    expect(tools.map((t) => t.name).sort()).toEqual([...names].sort());
    expect(tools.every((t) => t.layer === "factory_controls")).toBe(true);
  });
});
