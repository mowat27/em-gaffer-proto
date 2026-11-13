/**
 * Declarative layers (DESIGN 8): manifest.json validation, the synthesised prompt-section extension, core bindings
 * in controls, and `registry.reload()` (new, edited and removed folders, a tool clash, re-import of an edited .ts).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ALLOW_ALL, jevUnavailable, PI_KIT, type LayerContext } from "../../src/agent/layer-context.ts";
import { applyValueTemplate, getPath, parseJsonManifest } from "../../src/agent/layer-manifest.ts";
import { originalSection } from "../../src/agent/prompt-sections.ts";
import { loadLayers } from "../../src/agent/registry.ts";
import { createBus } from "../../src/core/bus.ts";
import { ServiceError } from "../../src/core/errors.ts";
import { silentLogger } from "../../src/core/log.ts";
import { projectPaths, type ProjectPaths } from "../../src/core/paths.ts";
import { settingsDefaults } from "../../src/core/settings.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterAll(cleanupTmp);

const EXAMPLE = fileURLToPath(new URL("../../../template/examples/model-picker.layer.json", import.meta.url));

function layerCtx(paths: ProjectPaths): LayerContext {
  return {
    service: () => {
      throw new ServiceError("unavailable", "the factory is still starting");
    },
    paths,
    log: silentLogger,
    bus: createBus(silentLogger),
    settings: () => {
      throw new ServiceError("unavailable", "settings are not loaded yet");
    },
    ceiling: () => ALLOW_ALL,
    modelCache: { get: () => undefined, put: () => undefined },
    prompts: () => ({ customText: () => "" }),
    jev: jevUnavailable,
    pi: PI_KIT,
  };
}

async function project(): Promise<ProjectPaths> {
  const paths = projectPaths(await tmpDir("tsf-declarative"));
  await mkdir(paths.layersDir, { recursive: true });
  return paths;
}

const load = (paths: ProjectPaths) =>
  loadLayers({ ctx: layerCtx(paths), builtinDir: paths.builtinLayersDir, projectDir: paths.layersDir, cliTools: null });

async function put(paths: ProjectPaths, layer: string, file: string, text: string): Promise<void> {
  await mkdir(join(paths.layersDir, layer, file, ".."), { recursive: true });
  await writeFile(join(paths.layersDir, layer, file), text);
}

const manifestOf = (name: string, extra: object = {}): string =>
  JSON.stringify({ name, version: "0.1.0", kind: "harness", title: name, description: "d", enabledByDefault: true, ...extra });

const settingsFor = (layersEnabled: string[]) => ({ ...settingsDefaults("/tmp/t", []), layersEnabled });

describe("manifest.json validation", () => {
  it("accepts the model-picker example and fills the defaults", async () => {
    const m = parseJsonManifest("extras", await readFile(EXAMPLE, "utf8"));
    expect(m.name).toBe("extras");
    expect(m.ui.widgets.map((w) => w.id)).toEqual(["extras.model_picker"]);
    const minimal = parseJsonManifest("tiny", manifestOf("tiny"));
    expect(minimal).toMatchObject({ enabledByDefault: true, env: [], vaultHosts: [], ui: { settingsPanels: [], widgets: [], hotkeys: [] } });
  });

  it("rejects bad JSON, unknown top-level keys, a wrong name and kind provider, listing every problem", () => {
    expect(() => parseJsonManifest("x", "{nope")).toThrow(/not valid JSON/);
    let message = "";
    try {
      parseJsonManifest("alpha", JSON.stringify({ name: "beta", kind: "provider", title: "", description: "d", required: true, extra: 1 }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/manifest: unknown key required/);
    expect(message).toMatch(/manifest: unknown key extra/);
    expect(message).toMatch(/name: must equal the folder name alpha/);
    expect(message).toMatch(/kind: a json layer must be "harness"/);
    expect(message).toMatch(/title: must be a string/);
  });

  it("reports field-level control errors with their path", () => {
    const widget = (control: object) => ({
      id: "x.w",
      title: "W",
      description: "",
      navbars: ["global"],
      defaultOptions: {},
      control,
    });
    const run = (control: object) => () => parseJsonManifest("x", manifestOf("x", { ui: { widgets: [widget(control)] } }));
    expect(run({ kind: "value", query: "core:settings.get", capability: "settings.get" })).toThrow(/ui\/widgets\/0\/control\/label/);
    expect(run({ kind: "value", label: "L", query: "core:nope.nothing", capability: "settings.get" })).toThrow(/no core capability nope\.nothing/);
    // A query binding needs a non-mutating GET capability; an action binding needs a POST route.
    expect(run({ kind: "value", label: "L", query: "core:model.set", capability: "model.set" })).toThrow(/query binding needs a non-mutating/);
    expect(run({ kind: "button", label: "L", action: "core:models.list", capability: "models.list" })).toThrow(/action binding needs/);
    // capability: this layer's own or a core id.
    expect(run({ kind: "value", label: "L", query: "core:settings.get", capability: "x.unknown" })).toThrow(/neither a capability of this layer nor a core capability id/);
    expect(run({ kind: "value", label: "L", query: "get_it", capability: "settings.get" })).not.toThrow(/core/);
    expect(run({ kind: "select", label: "L", query: "core:settings.get", field: "model", action: "core:model.set", capability: "model.set" })).toThrow(/exactly one of options and optionsQuery/);
    expect(run({ kind: "value", label: "L", query: "core:settings.get", capability: "settings.get", bogus: 1 })).toThrow(/unknown key bogus/);
    expect(run({ kind: "dial", label: "L", capability: "settings.get" })).toThrow(/kind: must be value, button/);
  });

  it("helpers: dotted paths and the $value template", () => {
    expect(getPath({ model: { modelId: "m" } }, "model.modelId")).toBe("m");
    expect(getPath({ model: null }, "model.modelId")).toBeNull();
    expect(getPath({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(applyValueTemplate({ modelId: "$value", nested: ["$value", "keep"] }, "m1")).toEqual({ modelId: "m1", nested: ["m1", "keep"] });
  });
});

describe("loading declarative layers", () => {
  it("loads a json layer with no extension.ts: an extension named after it, no tools", async () => {
    const paths = await project();
    await put(paths, "extras", "manifest.json", await readFile(EXAMPLE, "utf8"));
    const registry = await load(paths);
    const layer = registry.layers().find((l) => l.manifest.name === "extras")!;
    expect(layer.source).toBe("project");
    expect(layer.extension.name).toBe("extras");
    expect(layer.extension.tools ?? []).toEqual([]);
    const info = registry.infos(settingsFor(["extras"])).find((l) => l.name === "extras")!;
    expect(info).toMatchObject({ status: "loaded", enabled: true, tools: [], sections: [] });
    expect(info.ui.widgets[0]?.id).toBe("extras.model_picker");
  });

  it("both manifest.ts and manifest.json fails the layer with a clear message", async () => {
    const paths = await project();
    await put(paths, "both", "manifest.json", manifestOf("both"));
    await put(paths, "both", "manifest.ts", "export const manifest = {};\n");
    const info = (await load(paths)).infos(settingsFor([])).find((l) => l.name === "both")!;
    expect(info.status).toBe("failed");
    expect(info.error).toMatch(/both manifest\.ts and manifest\.json exist/);
  });

  it("an invalid manifest.json fails only that layer, with the field paths", async () => {
    const paths = await project();
    await put(paths, "bad", "manifest.json", manifestOf("bad", { ui: { widgets: [{ id: "other.w" }] } }));
    await put(paths, "good", "manifest.json", manifestOf("good"));
    const registry = await load(paths);
    expect(registry.manifests().map((m) => m.name)).toContain("good");
    const bad = registry.infos(settingsFor([])).find((l) => l.name === "bad")!;
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/ui\/widgets\/0\/id: must be bad\.<name>/);
  });

  it("synthesises prompt sections from prompts/*.md (key <layer>-<file>, title from the first # heading)", async () => {
    const paths = await project();
    await put(paths, "voice", "manifest.json", manifestOf("voice"));
    await put(paths, "voice", "prompts/style.md", "# House style\n\nWrite short sentences.\n");
    await put(paths, "voice", "prompts/tone-two.md", "Be kind.\n");
    await put(paths, "voice", "prompts/empty.md", "\n");
    const registry = await load(paths);
    const layer = registry.layers().find((l) => l.manifest.name === "voice")!;
    expect(layer.extension.sections?.map((s) => s.key)).toEqual(["voice-empty", "voice-style", "voice-tone-two"]);
    expect(registry.sectionTitle("voice-style")).toBe("House style");
    expect(registry.sectionTitle("voice-tone-two")).toBe("tone-two");
    expect(registry.infos(settingsFor(["voice"])).find((l) => l.name === "voice")!.sections).toEqual(["voice-empty", "voice-style", "voice-tone-two"]);
    const render = async (key: string) =>
      originalSection(layer.extension.sections!.find((s) => s.key === key)!).render({} as never, {} as never);
    expect(await render("voice-style")).toContain("Write short sentences.");
    expect(await render("voice-tone-two")).toBe("Be kind.");
    expect(await render("voice-empty")).toBeUndefined();
  });

  it("a prompt file with an invalid name fails the layer", async () => {
    const paths = await project();
    await put(paths, "voice", "manifest.json", manifestOf("voice"));
    await put(paths, "voice", "prompts/Bad Name.md", "x");
    const info = (await load(paths)).infos(settingsFor([])).find((l) => l.name === "voice")!;
    expect(info.status).toBe("failed");
    expect(info.error).toMatch(/prompts\/Bad Name\.md: the file name must match/);
  });

  it("a json layer's capability must name a tool and a handler of its extension", async () => {
    const paths = await project();
    const capability = { id: "cap.thing", summary: "s", kind: "query", handler: "get", tool: "get_thing", control: "cap.thing", mutates: false };
    await put(
      paths,
      "cap",
      "manifest.json",
      manifestOf("cap", {
        capabilities: [capability],
        ui: { widgets: [{ id: "cap.w", title: "W", description: "", navbars: ["global"], defaultOptions: {}, control: { kind: "value", label: "L", query: "get", capability: "cap.thing" } }] },
      }),
    );
    const info = (await load(paths)).infos(settingsFor([])).find((l) => l.name === "cap")!;
    expect(info.status).toBe("failed");
    expect(info.error).toMatch(/extension has no tool get_thing/);
    expect(info.error).toMatch(/no query handler get/);
  });
});

describe("registry.reload()", () => {
  it("picks up a new folder, an edited manifest and a removed folder", async () => {
    const paths = await project();
    await put(paths, "one", "manifest.json", manifestOf("one", { title: "One" }));
    const registry = await load(paths);
    expect(registry.manifests().map((m) => m.name)).not.toContain("two");

    await put(paths, "two", "manifest.json", manifestOf("two"));
    let r = await registry.reload();
    expect(r).toMatchObject({ added: ["two"], removed: [], changed: [] });
    expect(registry.layers().at(-1)!.manifest.name).toBe("two");
    expect(registry.layers().map((l) => l.order)).toEqual(registry.layers().map((_, i) => i));

    // Nothing touched: nothing reported.
    r = await registry.reload();
    expect(r).toMatchObject({ added: [], removed: [], changed: [] });

    await put(paths, "one", "manifest.json", manifestOf("one", { title: "One, edited" }));
    r = await registry.reload();
    expect(r).toMatchObject({ added: [], removed: [], changed: ["one"] });
    expect(registry.infos(settingsFor(["one"])).find((l) => l.name === "one")!.title).toBe("One, edited");

    await rm(join(paths.layersDir, "two"), { recursive: true });
    r = await registry.reload();
    expect(r).toMatchObject({ added: [], removed: ["two"], changed: [] });
    expect(registry.infos(settingsFor([])).map((l) => l.name)).not.toContain("two");
    expect(registry.extension("two")).toBeUndefined();
  });

  it("a layer that breaks goes failed (removed) and comes back when fixed", async () => {
    const paths = await project();
    await put(paths, "flip", "manifest.json", manifestOf("flip"));
    const registry = await load(paths);
    await put(paths, "flip", "manifest.json", "{ broken");
    let r = await registry.reload();
    expect(r).toMatchObject({ removed: ["flip"], failed: ["flip"] });
    expect(registry.infos(settingsFor([])).find((l) => l.name === "flip")!.status).toBe("failed");
    await put(paths, "flip", "manifest.json", manifestOf("flip"));
    r = await registry.reload();
    expect(r).toMatchObject({ added: ["flip"], failed: [] });
  });

  it("re-imports an edited extension.ts (cache-busting) and a new prompt file", async () => {
    const paths = await project();
    const ext = (text: string) =>
      `export function createExtension(ctx) {\n  const { defineExtension, section } = ctx.pi;\n  return defineExtension({ name: "code", sections: [section("code-note", () => ${JSON.stringify(text)})] });\n}\n`;
    await put(paths, "code", "manifest.json", manifestOf("code"));
    await put(paths, "code", "extension.ts", ext("first version"));
    const registry = await load(paths);
    const render = async () => {
      const s = registry.extension("code")!.sections![0]!;
      return originalSection(s).render({} as never, {} as never);
    };
    expect(await render()).toBe("first version");
    await put(paths, "code", "extension.ts", ext("second version, longer"));
    const r = await registry.reload();
    expect(r.changed).toEqual(["code"]);
    expect(await render()).toBe("second version, longer");
  });

  it("a project tool that clashes with a built-in or another layer fails that layer, never the process", async () => {
    const paths = await project();
    const ext = (name: string, tool: string) =>
      `export function createExtension(ctx) {\n  const { defineExtension, defineAppTool, obj } = ctx.pi;\n  return defineExtension({ name: "${name}", tools: [defineAppTool({ name: "${tool}", description: "t", parameters: obj({}), replay: "safe", run: async () => ({}) })] });\n}\n`;
    await put(paths, "aaa", "manifest.json", manifestOf("aaa"));
    await put(paths, "aaa", "extension.ts", ext("aaa", "shared_tool"));
    const registry = await load(paths);
    expect(registry.toolLayer("shared_tool")).toBe("aaa");

    await put(paths, "bbb", "manifest.json", manifestOf("bbb"));
    await put(paths, "bbb", "extension.ts", ext("bbb", "shared_tool"));
    await put(paths, "ccc", "manifest.json", manifestOf("ccc"));
    await put(paths, "ccc", "extension.ts", ext("ccc", "list_pages"));
    const r = await registry.reload();
    expect(r.added).toEqual([]);
    expect([...r.failed].sort()).toEqual(["bbb", "ccc"]);
    const infos = registry.infos(settingsFor([]));
    expect(infos.find((l) => l.name === "bbb")).toMatchObject({ status: "failed" });
    expect(infos.find((l) => l.name === "bbb")!.error).toMatch(/shared_tool is defined by layers aaa and bbb/);
    expect(infos.find((l) => l.name === "ccc")!.error).toMatch(/list_pages is defined by layers page_harness and ccc/);
    expect(registry.toolLayer("shared_tool")).toBe("aaa");
    expect(registry.toolLayer("list_pages")).toBe("page_harness");
    // The ceiling follows the new tool map.
    expect(registry.ceiling().allowsName("shared_tool")).toBe(true);
  });
});
