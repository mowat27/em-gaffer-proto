/**
 * Layer versions, requires, default placements, export and import (P9 sharing primitives), option shaping and the
 * fresh-copy import of edited layer code. Service-level on faux with the real agent, like layers-authoring.test.ts.
 */
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonManifest } from "../../src/agent/layer-manifest.ts";
import { createTgz, parseTgz } from "../../src/core/layer-archive.ts";
import { projectPaths } from "../../src/core/paths.ts";
import { isSemver, isSemverRange, satisfies } from "../../src/shared/semver.ts";
import { shapeOptions } from "../../src/shared/select-options.ts";
import type { Json, LayerInfo, WidgetContribution } from "../../src/shared/types.ts";
import type { Factory } from "../../src/server/main.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const ui = { by: "ui" } as const;

let factory: Factory & { root: string };
beforeEach(async () => {
  const { root } = await makeProject();
  factory = await createTestFactory({ project: root });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await factory.close();
  await cleanupTmp();
});

const svc = () => factory.service;
const paths = () => projectPaths(factory.root);
const info = (name: string): LayerInfo => svc().listLayers().find((l) => l.name === name)!;
const rejects = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a rejection");
};
const manifestOf = (name: string, extra: object = {}): string =>
  `${JSON.stringify({ name, version: "1.2.3", origin: "local", kind: "harness", title: name, description: "d", enabledByDefault: true, ...extra }, null, 2)}\n`;
const picker = (layer: string, extra: object = {}): WidgetContribution =>
  ({
    id: `${layer}.model_picker`,
    title: "Model picker",
    description: "",
    navbars: ["global", "agent"],
    defaultOptions: {},
    control: { kind: "value", label: "Name", query: "core:settings.get", field: "factoryName", capability: "settings.get" },
    ...extra,
  }) as WidgetContribution;
const placed = (widget: string) => svc().listWidgets().placements.filter((p) => p.widget === widget);

describe("semver", () => {
  it("parses versions and ranges", () => {
    expect(isSemver("0.1.0")).toBe(true);
    expect(isSemver("1.2")).toBe(false);
    expect(isSemverRange(">=0.9.0 <2")).toBe(true);
    expect(isSemverRange("nonsense")).toBe(false);
    expect(satisfies("0.9.0", ">=0.9.0")).toBe(true);
    expect(satisfies("0.9.0", ">0.9.0")).toBe(false);
    expect(satisfies("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.1")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.1")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.5.0", "1.x")).toBe(true);
    expect(satisfies("3.0.0", "<1 || >=3")).toBe(true);
    expect(satisfies("2.0.0", "<1 || >=3")).toBe(false);
  });
});

describe("select option shaping", () => {
  const models = [
    { id: "openrouter/gpt-10", name: "GPT 10", p: "b" },
    { id: "openrouter/gpt-2", name: "GPT 2", p: "b" },
    { id: "anthropic/claude", name: "Claude", p: "a" },
    { id: "plain", name: "Plain" },
  ] as unknown as Json;
  const base = { query: "core:models.list", valueField: "id", labelField: "name" };

  it("keeps the source order without sortBy and groupBy", () => {
    const [g] = shapeOptions(models, base);
    expect(g!.label).toBeNull();
    expect(g!.options.map((o) => o.value)).toEqual(["openrouter/gpt-10", "openrouter/gpt-2", "anthropic/claude", "plain"]);
  });

  it("sorts by label, numeric or not", () => {
    const plain = shapeOptions(models, { ...base, sortBy: "label" })[0]!.options.map((o) => o.label);
    expect(plain).toEqual(["Claude", "GPT 10", "GPT 2", "Plain"]);
    const numeric = shapeOptions(models, { ...base, sortBy: "label", numeric: true })[0]!.options.map((o) => o.label);
    expect(numeric).toEqual(["Claude", "GPT 2", "GPT 10", "Plain"]);
    expect(shapeOptions(models, { ...base, sortBy: "value" })[0]!.options[0]!.value).toBe("anthropic/claude");
  });

  it("groups by a value prefix: ungrouped first, then groups sorted", () => {
    const groups = shapeOptions(models, { ...base, sortBy: "label", numeric: true, groupBy: { prefix: "/" } });
    expect(groups.map((g) => g.label)).toEqual([null, "anthropic", "openrouter"]);
    expect(groups[2]!.options.map((o) => o.label)).toEqual(["GPT 2", "GPT 10"]);
  });

  it("groups by a field and reads plain strings", () => {
    const groups = shapeOptions(models, { ...base, groupBy: { field: "p" } });
    expect(groups.map((g) => g.label)).toEqual([null, "a", "b"]);
    expect(shapeOptions(["b", "a"] as Json, { query: "q", sortBy: "value" })[0]!.options.map((o) => o.value)).toEqual(["a", "b"]);
    expect(shapeOptions({ items: ["x/y", "x/z"] } as Json, { query: "q", field: "items", groupBy: { prefix: "/" } }).map((g) => g.label)).toEqual(["x"]);
    expect(shapeOptions(null, base)).toEqual([{ label: null, options: [] }]);
  });

  it("the manifest validates sortBy, groupBy and numeric", () => {
    const wid = (optionsQuery: object) => ({
      id: "xx.w",
      title: "W",
      description: "",
      navbars: ["global"],
      defaultOptions: {},
      control: { kind: "select", label: "L", query: "core:settings.get", field: "model.modelId", action: "core:model.set", capability: "model.set", optionsQuery },
    });
    const run = (oq: object) => () => parseJsonManifest("xx", manifestOf("xx", { ui: { widgets: [wid({ query: "core:models.list", ...oq })] } }));
    expect(run({ sortBy: "label", numeric: true, groupBy: { prefix: "/" } })).not.toThrow();
    expect(run({ groupBy: { field: "provider" } })).not.toThrow();
    expect(run({ sortBy: "name" })).toThrow(/sortBy: must be value or label/);
    expect(run({ numeric: "yes" })).toThrow(/numeric: must be true or false/);
    expect(run({ groupBy: { field: "a", prefix: "/" } })).toThrow(/exactly one of field and prefix/);
    expect(run({ groupBy: {} })).toThrow(/exactly one of field and prefix/);
  });
});

describe("version, origin and requires", () => {
  it("createLayer writes version 0.1.0 and origin local; LayerInfo exposes them", async () => {
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
    const file = JSON.parse(await readFile(join(paths().layersDir, "extras", "manifest.json"), "utf8"));
    expect(file).toMatchObject({ version: "0.1.0", origin: "local" });
    expect(info("extras")).toMatchObject({ version: "0.1.0", origin: "local" });
  });

  it("a json manifest without a version gets 0.1.0; a given version, requires and origin are checked", () => {
    expect(parseJsonManifest("xx", JSON.stringify({ name: "xx", kind: "harness", title: "t", description: "" })).version).toBe("0.1.0");
    expect(() => parseJsonManifest("xx", manifestOf("xx", { version: "1.2" }))).toThrow(/version: must be a semver/);
    expect(() => parseJsonManifest("xx", manifestOf("xx", { requires: { core: "banana" } }))).toThrow(/requires\/core/);
    expect(() => parseJsonManifest("xx", manifestOf("xx", { requires: { layers: ["Bad Name"] } }))).toThrow(/requires\/layers/);
    expect(() => parseJsonManifest("xx", manifestOf("xx", { requires: { nope: 1 } }))).toThrow(/unknown key nope/);
    const m = parseJsonManifest("xx", manifestOf("xx", { requires: { core: ">=0.1.0", layers: ["page_harness"] } }));
    expect(m).toMatchObject({ version: "1.2.3", origin: "local", requires: { core: ">=0.1.0", layers: ["page_harness"] } });
  });

  it("an unmet core range or a missing layer fails that layer, not the factory", async () => {
    const dir = paths().layersDir;
    for (const [name, requires] of [
      ["needs_new_core", { core: ">=99.0.0" }],
      ["needs_missing", { layers: ["not_there"] }],
      ["needs_chain", { layers: ["needs_missing"] }],
      ["needs_ok", { core: ">=0.1.0", layers: ["page_harness"] }],
    ] as const) {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "manifest.json"), manifestOf(name, { requires }));
    }
    await svc().reloadLayers(ui);
    expect(info("needs_new_core")).toMatchObject({ status: "failed", version: "1.2.3", requires: { core: ">=99.0.0" } });
    expect(info("needs_new_core").error).toMatch(/requires core >=99\.0\.0, but this factory is \d+\.\d+\.\d+/);
    expect(info("needs_missing").error).toMatch(/requires layer not_there, not loaded/);
    expect(info("needs_chain")).toMatchObject({ status: "failed" });
    expect(info("needs_chain").error).toMatch(/requires layer needs_missing/);
    expect(info("needs_ok")).toMatchObject({ status: "loaded" });
  });
});

describe("default placements", () => {
  it("places the widget once, and not again after the user removed it", async () => {
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
    await svc().defineWidget({ layer: "extras", widget: picker("extras", { defaultPlacements: [{ navbar: "agent", slot: "right" }] }) }, ui);
    expect(placed("extras.model_picker")).toMatchObject([{ navbar: "agent", slot: "right" }]);
    const state = JSON.parse(await readFile(join(paths().dataDir, "layer-state", "extras.json"), "utf8"));
    expect(state).toEqual({ appliedPlacements: ["extras.model_picker"] });

    await svc().removeWidget({ id: placed("extras.model_picker")[0]!.id }, ui);
    await svc().setLayerEnabled({ name: "extras", enabled: false }, ui);
    await svc().setLayerEnabled({ name: "extras", enabled: true }, ui);
    await svc().reloadLayers(ui);
    expect(placed("extras.model_picker")).toEqual([]);
  });

  it("does not place a widget that is already placed, and validates the navbar", async () => {
    await svc().createLayer({ name: "extras", title: "Extras", description: "" }, ui);
    await svc().defineWidget({ layer: "extras", widget: picker("extras") }, ui);
    await svc().addWidget({ widget: "extras.model_picker", navbar: "global", slot: "left" }, ui);
    await svc().defineWidget({ layer: "extras", widget: picker("extras", { defaultPlacements: [{ navbar: "agent", slot: "right" }] }) }, ui);
    expect(placed("extras.model_picker")).toHaveLength(1);
    const bad = await rejects(svc().defineWidget({ layer: "extras", widget: picker("extras", { navbars: ["global"], defaultPlacements: [{ navbar: "agent", slot: "right" }] }) }, ui));
    expect(bad.message).toMatch(/not one of the widget's navbars/);
  });
});

describe("edited layer code is imported fresh", () => {
  it("a helper edit alone reloads the layer, and createHandlers sees the new value", async () => {
    await svc().createLayer({ name: "fresh", title: "Fresh", description: "" }, ui);
    await svc().writeLayerFile({ name: "fresh", path: "helper.ts", content: "export const helper = (): number => 1;\n" }, ui);
    const ext = `import { helper } from "./helper.ts";
export function createExtension(ctx) { return ctx.pi.defineExtension({ name: "fresh" }); }
export function createHandlers() { return { queries: { get: () => ({ v: helper() }) }, actions: {} }; }
`;
    const out = await svc().writeLayerFile({ name: "fresh", path: "extension.ts", content: ext }, ui);
    expect(out.layer.status).toBe("loaded");
    expect(await svc().layerQuery({ layer: "fresh", name: "get" })).toEqual({ v: 1 });
    await svc().writeLayerFile({ name: "fresh", path: "helper.ts", content: "export const helper = (): number => 2;\n" }, ui);
    expect(await svc().layerQuery({ layer: "fresh", name: "get" })).toEqual({ v: 2 });
  });

  it("a code manifest (manifest.ts) edit is picked up", async () => {
    const dir = join(paths().layersDir, "coded");
    await mkdir(dir, { recursive: true });
    const manifest = (title: string) =>
      `export const manifest = { name: "coded", kind: "harness", title: "${title}", description: "d", enabledByDefault: true, env: [], vaultHosts: [], ui: { settingsPanels: [], widgets: [], hotkeys: [] } };\n`;
    await writeFile(join(dir, "extension.ts"), `export function createExtension(ctx) { return ctx.pi.defineExtension({ name: "coded" }); }\n`);
    await writeFile(join(dir, "manifest.ts"), manifest("One"));
    await svc().reloadLayers(ui);
    expect(info("coded")).toMatchObject({ status: "loaded", title: "One" });
    await svc().writeLayerFile({ name: "coded", path: "manifest.ts", content: manifest("Two") }, ui);
    expect(info("coded")).toMatchObject({ status: "loaded", title: "Two" });
    expect((await readdir(join(paths().dataDir, "layer-cache", "coded"))).length).toBeLessThanOrEqual(2);
  });
});

describe("archive format", () => {
  it("round-trips files, including a long path", () => {
    const files = [
      { path: "manifest.json", data: Buffer.from("{}") },
      { path: "prompts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/cccccccccccccccccccccccccccccccccccccc/x.md", data: Buffer.from("# hi\n") },
      { path: "big.ts", data: Buffer.alloc(1500, 7) },
    ];
    const back = parseTgz(createTgz(files));
    expect(back.map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect(back[2]!.data.equals(files[2]!.data)).toBe(true);
  });

  it("rejects traversal, absolute paths, links and other file types", () => {
    const evil = (path: string) => () => parseTgz(createTgz([{ path: "manifest.json", data: Buffer.from("{}") }, { path, data: Buffer.from("x") }]));
    expect(evil("../escape.json")).toThrow(/must not contain \. or \.\. segments/);
    expect(evil("a/../../escape.json")).toThrow(/\.\./);
    expect(evil("/etc/passwd.json")).toThrow(/not absolute|relative/);
    expect(evil("run.sh")).toThrow(/only \.json, \.ts, \.md/);
    expect(() => parseTgz(gzipSync(Buffer.alloc(600, 65)))).toThrow();
    expect(() => parseTgz(Buffer.from("plain"))).toThrow(/not a gzip/);
  });

  it("strips one top-level folder that holds the manifest", () => {
    const back = parseTgz(createTgz([{ path: "extras/manifest.json", data: Buffer.from("{}") }, { path: "extras/prompts/a.md", data: Buffer.from("x") }]));
    expect(back.map((f) => f.path)).toEqual(["manifest.json", "prompts/a.md"]);
  });
});

describe("export and import", () => {
  async function seed(): Promise<void> {
    await svc().createLayer({ name: "extras", title: "Extras", description: "shared" }, ui);
    await svc().defineWidget({ layer: "extras", widget: picker("extras") }, ui);
    await svc().writeLayerFile({ name: "extras", path: "prompts/style.md", content: "# Style\nBe brief.\n" }, ui);
  }

  it("exports a project layer to tsf/data/exports and refuses built-ins", async () => {
    await seed();
    const out = await svc().exportLayer({ name: "extras" }, ui);
    expect(out).toMatchObject({ name: "extras", version: "0.1.0", file: "extras-0.1.0.tgz", path: join(paths().dataDir, "exports", "extras-0.1.0.tgz") });
    expect(out.files).toEqual(["manifest.json", "prompts/style.md"]);
    expect(out.size).toBe((await lstat(out.path)).size);
    expect((await rejects(svc().exportLayer({ name: "page_harness" }, ui))).code).toBe("forbidden");
    expect((await rejects(svc().exportLayer({ name: "nope_layer" }, ui))).code).toBe("not_found");
    expect((await rejects(svc().exportLayer({ name: "extras", to: "../x.tgz" }, ui))).code).toBe("invalid");
    const res = await factory.app.request("/api/layers/export-file?file=extras-0.1.0.tgz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("extras-0.1.0.tgz");
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(out.size);
    expect((await factory.app.request("/api/layers/export-file?file=..%2Fsettings.tgz")).status).toBe(400);
    expect((await factory.app.request("/api/layers/export-file?file=missing.tgz")).status).toBe(404);
  });

  it("round trip: importing the archive under another name keeps the files, renames the ids and loads it", async () => {
    await seed();
    const out = await svc().exportLayer({ name: "extras" }, ui);
    const imported = await svc().importLayer({ source: out.path, name: "copy" }, ui);
    expect(imported).toMatchObject({ name: "copy", version: "0.1.0", replaced: false, layer: { status: "loaded" } });
    expect(imported.files).toEqual(["manifest.json", "prompts/style.md"]);
    const style = await readFile(join(paths().layersDir, "copy", "prompts", "style.md"), "utf8");
    expect(style).toBe("# Style\nBe brief.\n");
    expect(info("copy").ui.widgets.map((w) => w.id)).toEqual(["copy.model_picker"]);
    expect(JSON.parse(await readFile(join(paths().layersDir, "copy", "manifest.json"), "utf8")).name).toBe("copy");
    // Same name again: refused unless replace.
    expect((await rejects(svc().importLayer({ source: out.path, name: "copy" }, ui))).code).toBe("conflict");
    const again = await svc().importLayer({ source: out.path, name: "copy", replace: true }, ui);
    expect(again.replaced).toBe(true);
  });

  it("imports a layer folder by path and under its own name; the original name is taken", async () => {
    await seed();
    const out = await svc().exportLayer({ name: "extras" }, ui);
    expect((await rejects(svc().importLayer({ source: out.path }, ui))).code).toBe("conflict");
    const folder = await tmpDir("tsf-folder");
    await writeFile(join(folder, "manifest.json"), manifestOf("fromfolder"));
    await mkdir(join(folder, "prompts"));
    await writeFile(join(folder, "prompts", "p.md"), "# P\n");
    await writeFile(join(folder, "notes.txt"), "ignored");
    const imp = await svc().importLayer({ source: folder }, ui);
    expect(imp).toMatchObject({ name: "fromfolder", version: "1.2.3", files: ["manifest.json", "prompts/p.md"] });
  });

  it("rejects an archive with a traversal entry and writes nothing", async () => {
    const bad = createTgz([
      { path: "manifest.json", data: Buffer.from(manifestOf("evil")) },
      { path: "../../escaped.json", data: Buffer.from("{}") },
    ]);
    const file = join(await tmpDir("tsf-evil"), "evil.tgz");
    await writeFile(file, bad);
    const err = await rejects(svc().importLayer({ source: file }, ui));
    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/\.\./);
    expect(await readdir(paths().layersDir)).not.toContain("evil");
    expect((await readdir(paths().layersDir)).filter((n) => n.startsWith(".import-") || n.startsWith(".old-"))).toEqual([]);
  });

  it("validates the manifest like reload, but an unmet requires imports as a failed layer", async () => {
    const dir = await tmpDir("tsf-req");
    await writeFile(join(dir, "manifest.json"), manifestOf("needy", { requires: { core: ">=99.0.0" } }));
    const res = await svc().importLayer({ source: dir }, ui);
    expect(res.layer).toMatchObject({ status: "failed" });
    expect(res.layer.error).toMatch(/requires core >=99\.0\.0/);

    const broken = await tmpDir("tsf-broken");
    await writeFile(join(broken, "manifest.json"), JSON.stringify({ name: "oops", kind: "harness", title: "x", description: "", version: "1.2" }));
    const err = await rejects(svc().importLayer({ source: broken }, ui));
    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/version: must be a semver/);
    expect(await readdir(paths().layersDir)).not.toContain("oops");
  });

  it("refuses a built-in name, a bad source and http", async () => {
    const dir = await tmpDir("tsf-builtin");
    await writeFile(join(dir, "manifest.json"), manifestOf("page_harness"));
    expect((await rejects(svc().importLayer({ source: dir }, ui))).code).toBe("conflict");
    expect((await rejects(svc().importLayer({ source: join(dir, "nothing.tgz") }, ui))).code).toBe("not_found");
    expect((await rejects(svc().importLayer({ source: "http://example.com/x.tgz" }, ui))).code).toBe("invalid");
    expect((await rejects(svc().importLayer({ source: "" }, ui))).code).toBe("invalid");
  });

  it("downloads an https archive, records the URL as origin, and never echoes a failure's detail", async () => {
    const archive = createTgz([{ path: "manifest.json", data: Buffer.from(manifestOf("remote", { origin: "local" })) }]);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      seen.push(String(url));
      return new Response(new Uint8Array(archive), { status: 200, headers: { "content-type": "application/gzip" } });
    });
    const res = await svc().importLayer({ source: "https://example.com/layers/remote.tgz" }, ui);
    expect(seen).toEqual(["https://example.com/layers/remote.tgz"]);
    expect(res).toMatchObject({ name: "remote", layer: { status: "loaded", origin: "https://example.com/layers/remote.tgz" } });

    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed to http://secret-proxy:3128"), { cause: { code: "ECONNREFUSED" } });
    });
    const err = await rejects(svc().importLayer({ source: "https://example.com/x.tgz", name: "other" }, ui));
    expect(err.code).toBe("upstream");
    expect(err.message).not.toContain("secret-proxy");
    vi.unstubAllGlobals();
  });
});
