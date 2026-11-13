/**
 * Acceptance 10 (spec 12.10, DESIGN 8 "Ceiling", T27): a tool outside the permissions ceiling is never registered, so it
 * is absent from listTools() and the request's tools, and an injected direct call to it is blocked naming the ceiling.
 * The `probe <tool> [<json>]` faux rule (Lot E) makes the model call any tool, offered or not.
 */
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Factory } from "../../src/server/main.ts";
import { layerRoutes } from "../../src/server/routes/layers.ts";
import type { CeilingInfo, ChatItem, LayerInfo, ToolInfo } from "../../src/shared/types.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const ctx = BACKGROUND_CONTEXT;
const FIXTURES = fileURLToPath(new URL("../fixtures/layers/", import.meta.url));
const RUNS_KEY = "__tsfOutsideToolRuns";

const factories: Factory[] = [];
afterEach(async () => {
  for (const f of factories.splice(0)) await f.close();
});
afterAll(cleanupTmp);

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Send `probe ...` and wait until the run has answered "probe done"; returns the settled tool item. */
async function probe(factory: Factory, text: string, tool: string): Promise<ToolItem> {
  await factory.service.sendMessage({ text, requestId: `probe-${tool}-${Date.now()}` }, { by: "ui" });
  const end = Date.now() + 15_000;
  for (;;) {
    const view = factory.service.chatView();
    const item = view.items.findLast((i): i is ToolItem => i.kind === "tool" && i.name === tool);
    const done = view.items.some((i) => i.kind === "assistant" && i.text.includes("probe done"));
    if (item && done && !view.live.busy && item.status !== "running" && item.status !== "pending") return item;
    if (Date.now() > end) throw new Error(`timed out waiting for the probe of ${tool}: ${JSON.stringify(view.items)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function offered(factory: Factory): Promise<{ tools: string[]; sections: string[] }> {
  const agent = await factory.agent.main.agent(ctx);
  return { tools: agent.tools.map((t) => t.name), sections: agent.sections.map((s) => s.key) };
}

describe("ceiling guard", () => {
  it("deny coding_tools.*: bash is not listed or offered, and an injected call is blocked by afterTool", async () => {
    const factory = await createTestFactory({ permissions: { allow: ["*"], deny: ["coding_tools.*"] } });
    factories.push(factory);

    const names = factory.service.listTools().map((t) => t.name);
    for (const t of ["read", "write", "edit", "bash"]) expect(names).not.toContain(t);
    const agent = await offered(factory);
    expect(agent.tools).not.toContain("bash");
    // The coding_tools section would describe tools the model lacks, so the layer keeps none.
    expect(agent.sections).not.toContain("coding_tools-scope");
    expect(agent.sections).toContain("factory_harness-system");

    const info = factory.agent.registry.infos(factory.agent.settings()).find((l) => l.name === "coding_tools")!;
    expect(info.tools).toEqual([]);
    expect(info.sections).toEqual([]);
    expect([...info.toolsOutsideCeiling].sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(factory.agent.registry.ceiling().info().denied).toContain("coding_tools.bash");

    const item = await probe(factory, 'probe bash {"command":"echo hi"}', "bash");
    expect(item.status).toBe("blocked");
    expect(item.diagnostic).toBe("blocked");
    expect(item.output ?? "").toMatch(/Tool call blocked: outside the permissions ceiling: coding_tools\.bash/);
  });

  it("skipCeilingFilter: a registered tool outside the ceiling is blocked by beforeTool and never runs", async () => {
    const { root } = await makeProject();
    await cp(join(FIXTURES, "outside"), join(root, "tsf", "layers", "outside"), { recursive: true });
    const factory = await createTestFactory({
      project: root,
      skipCeilingFilter: true,
      permissions: { allow: ["*"], deny: ["outside.*"] },
    });
    factories.push(factory);
    (globalThis as Record<string, unknown>)[RUNS_KEY] = 0;

    // Registered past the filter (the seam), so the model is offered it and only beforeTool can stop it.
    expect((await offered(factory)).tools).toContain("outside_tool");
    expect(factory.service.listTools().map((t) => t.name)).not.toContain("outside_tool");

    const item = await probe(factory, "probe outside_tool", "outside_tool");
    expect(item.status).toBe("blocked");
    expect(item.output ?? "").toMatch(/outside the permissions ceiling: outside\.outside_tool/);
    expect((globalThis as Record<string, unknown>)[RUNS_KEY]).toBe(0);
  });

  it("an unknown tool stays unavailable; an allowed one runs", async () => {
    const { root } = await makeProject();
    await cp(join(FIXTURES, "outside"), join(root, "tsf", "layers", "outside"), { recursive: true });
    const factory = await createTestFactory({ project: root, permissions: { allow: ["*"], deny: ["coding_tools.bash"] } });
    factories.push(factory);
    (globalThis as Record<string, unknown>)[RUNS_KEY] = 0;

    const unknown = await probe(factory, "probe no_such_tool", "no_such_tool");
    expect(unknown.status).toBe("unavailable");
    expect(unknown.diagnostic).toBe("tool_unavailable");

    const allowed = await probe(factory, "probe outside_tool", "outside_tool");
    expect(allowed.status).toBe("done");
    expect((globalThis as Record<string, unknown>)[RUNS_KEY]).toBe(1);

    // Only bash is denied: the other coding tools and the scope section stay.
    const agent = await offered(factory);
    expect(agent.tools).toEqual(expect.arrayContaining(["read", "write", "edit", "outside_tool"]));
    expect(agent.tools).not.toContain("bash");
    expect(agent.sections).toContain("coding_tools-scope");
  });

  it("GET /layers, /tools and /ceiling serve the registry views", async () => {
    const factory = await createTestFactory({ permissions: { allow: ["*"], deny: ["coding_tools.*"] } });
    factories.push(factory);
    const routes = layerRoutes(factory.service);

    const tools = (await (await routes.request("/tools")).json()) as ToolInfo[];
    expect(tools.map((t) => t.name)).not.toContain("bash");

    const layers = (await (await routes.request("/layers")).json()) as LayerInfo[];
    expect(layers.map((l) => l.name).slice(0, 2)).toEqual(["factory_harness", "provider_openrouter"]);

    const res = await routes.request("/ceiling");
    expect(res.status).toBe(200);
    const ceiling = (await res.json()) as CeilingInfo;
    expect(ceiling.file).toMatch(/permissions\.json$/);
  });
});
