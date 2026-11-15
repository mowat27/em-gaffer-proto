import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ALLOW_ALL, jevUnavailable, PI_KIT, type LayerContext } from "../../src/agent/layer-context.ts";
import { BUILTIN_LAYERS, loadLayers } from "../../src/agent/registry.ts";
import { createBus } from "../../src/core/bus.ts";
import { ServiceError } from "../../src/core/errors.ts";
import { silentLogger } from "../../src/core/log.ts";
import { settingsDefaults } from "../../src/core/settings.ts";
import { projectPaths, type ProjectPaths } from "../../src/core/paths.ts";
import type { Settings } from "../../src/shared/types.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterAll(cleanupTmp);

const FIXTURES = fileURLToPath(new URL("../fixtures/layers/", import.meta.url));

/** A temp project root with `tsf/layers/` holding copies of the named fixtures (`folder` = target folder name). */
async function project(layers: { fixture: string; folder?: string }[] = [], permissions?: object): Promise<ProjectPaths> {
  const paths = projectPaths(await tmpDir("tsf-registry"));
  await mkdir(paths.layersDir, { recursive: true });
  for (const l of layers) await cp(join(FIXTURES, l.fixture), join(paths.layersDir, l.folder ?? l.fixture), { recursive: true });
  if (permissions) await writeFile(paths.permissionsFile, JSON.stringify(permissions));
  return paths;
}

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

function load(paths: ProjectPaths, opts: { cliTools?: string[] | null; skipCeilingFilter?: boolean } = {}) {
  return loadLayers({
    ctx: layerCtx(paths),
    builtinDir: paths.builtinLayersDir,
    projectDir: paths.layersDir,
    cliTools: opts.cliTools ?? null,
    ...(opts.skipCeilingFilter ? { testing: { skipCeilingFilter: true } } : {}),
  });
}

function settingsFor(layersEnabled: string[]): Settings {
  return { ...settingsDefaults("/tmp/t", []), layersEnabled };
}

describe("loadLayers", () => {
  it("loads the built-ins in their fixed order", async () => {
    const registry = await load(await project());
    const names = registry.manifests().map((m) => m.name);
    expect(names.slice(0, 2)).toEqual(["factory_harness", "provider_openrouter"]);
    // Only built-ins that exist in this phase load; their relative order is the fixed one.
    expect(names).toEqual(BUILTIN_LAYERS.filter((n) => names.includes(n)));
    expect(registry.layers().map((l) => l.order)).toEqual(names.map((_, i) => i));
    expect(registry.layers().every((l) => l.source === "builtin")).toBe(true);
    expect(registry.providers()).toHaveLength(1);
  });

  it("a missing tsf/layers/ is treated as empty", async () => {
    const paths = projectPaths(await tmpDir("tsf-registry"));
    const registry = await load(paths);
    expect(registry.layers().every((l) => l.source === "builtin")).toBe(true);
  });

  it("a project layer in tsf/layers loads and appears last", async () => {
    const registry = await load(await project([{ fixture: "outside" }]));
    const last = registry.layers().at(-1)!;
    expect(last.manifest.name).toBe("outside");
    expect(last.source).toBe("project");
    expect(registry.toolLayer("outside_tool")).toBe("outside");
    const info = registry.infos(settingsFor(["factory_harness", "outside"])).at(-1)!;
    expect(info).toMatchObject({ name: "outside", source: "project", status: "loaded", enabled: true, tools: ["outside_tool"] });
    expect(info.sections).toEqual(["outside-note"]);
    expect(registry.toolInfos(settingsFor([]), new Set()).map((t) => t.name)).toContain("outside_tool");
    expect(registry.extension("outside")?.name).toBe("outside");
  });

  it("a tool name defined by two layers fails startup naming both", async () => {
    const paths = await project([{ fixture: "dup_a" }, { fixture: "dup_b" }]);
    await expect(load(paths)).rejects.toThrow("tool dup_tool is defined by layers dup_a and dup_b");
  });

  it("a broken project layer is status failed and the rest load", async () => {
    const registry = await load(await project([{ fixture: "broken" }, { fixture: "outside" }]));
    expect(registry.manifests().map((m) => m.name)).toContain("outside");
    expect(registry.manifests().map((m) => m.name)).not.toContain("broken");
    const infos = registry.infos(settingsFor([]));
    const broken = infos.find((l) => l.name === "broken")!;
    expect(broken.status).toBe("failed");
    expect(broken.error).toMatch(/failed on purpose/);
    expect(broken.enabled).toBe(false);
    // Sorted by order: the failed layer sits between the built-ins and `outside`.
    expect(infos.map((l) => l.name).slice(-2)).toEqual(["broken", "outside"]);
  });

  it("a manifest whose name differs from its folder fails that layer", async () => {
    const registry = await load(await project([{ fixture: "outside", folder: "wrong_name" }]));
    const info = registry.infos(settingsFor([])).find((l) => l.name === "wrong_name")!;
    expect(info.status).toBe("failed");
    expect(info.error).toMatch(/manifest\.name is outside/);
    expect(registry.toolLayer("outside_tool")).toBeUndefined();
  });

  it("filters tools by the ceiling; a layer left without tools loses its sections", async () => {
    const paths = await project([{ fixture: "outside" }], { allow: ["*"], deny: ["outside.*"] });
    const registry = await load(paths);
    const outside = registry.layers().find((l) => l.manifest.name === "outside")!;
    expect(outside.extension.tools ?? []).toEqual([]);
    expect(outside.extension.sections ?? []).toEqual([]);
    expect(outside.outsideCeiling).toEqual(["outside_tool"]);
    const info = registry.infos(settingsFor([])).find((l) => l.name === "outside")!;
    expect(info.tools).toEqual([]);
    expect(info.toolsOutsideCeiling).toEqual(["outside_tool"]);
    expect(registry.toolInfos(settingsFor([]), new Set()).map((t) => t.name)).not.toContain("outside_tool");
    expect(registry.ceiling().info().denied).toEqual(["outside.outside_tool"]);
    // A layer without tools by design keeps its sections.
    expect(registry.extension("factory_harness")?.sections?.length).toBeGreaterThan(0);
  });

  it("testing.skipCeilingFilter registers tools outside the ceiling but never lists them", async () => {
    const paths = await project([{ fixture: "outside" }], { allow: ["*"], deny: ["outside.*"] });
    const registry = await load(paths, { skipCeilingFilter: true });
    const outside = registry.layers().find((l) => l.manifest.name === "outside")!;
    expect((outside.extension.tools ?? []).map((t) => t.name)).toEqual(["outside_tool"]);
    expect(registry.ceiling().allowsName("outside_tool")).toBe(false);
    expect(registry.toolInfos(settingsFor([]), new Set()).map((t) => t.name)).not.toContain("outside_tool");
  });

  it("--tools narrows the registered tools", async () => {
    const registry = await load(await project([{ fixture: "outside" }]), { cliTools: ["outside.*"] });
    expect(registry.toolInfos(settingsFor([]), new Set()).map((t) => t.name)).toEqual(["outside_tool"]);
  });

  it("selection edits the host default; a required layer is never removed", async () => {
    const registry = await load(await project([{ fixture: "outside" }]));
    const all = registry.manifests().map((m) => m.name);
    expect(registry.selection(settingsFor(all))).toEqual({ add: [], remove: [] });
    const sel = registry.selection(settingsFor(all.filter((n) => n !== "outside" && n !== "factory_harness")));
    expect(sel.add).toEqual([]);
    expect(sel.remove.map((e) => e.name)).toEqual(["outside"]);
    expect(registry.toolObjects(["outside_tool", "nope"]).map((t) => t.name)).toEqual(["outside_tool"]);
  });
});
