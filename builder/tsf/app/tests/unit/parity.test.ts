/**
 * The parity test (principle 2, spec 8.7, DESIGN 10). Every capability names a Service method, routes, an agent tool
 * and a UI control; this file checks the list against the running app, generic over `BUILT_THROUGH_PHASE` and over the
 * capabilities loaded layers add:
 *
 *   1. the Service method exists (a layer capability: the layer's handler exists too);
 *   2. every route is mounted and answers (GET without a body, POST with `{}`; not 404 or 405, no 5xx);
 *   3. the tool is registered and the registry maps it to the capability's layer;
 *   4. (phase >= 3) the UI has the control: `data-cap="<id>"` in src/web, or a LayerControl in the layer manifest;
 *   5. (phase >= 2) every registered tool is a capability's tool or in AGENT_ONLY_TOOLS (printed on every run);
 *   6. (phase >= 2) every mounted /api route is a capability's route, a layer handler route or in INFRA_ROUTES;
 *   7. (phase >= 5) every data-cap literal in src/web is a capability id; only LayerControl.tsx writes data-cap={...}.
 *
 * Routes come from the Hono app, tools from the registry, controls from a scan of src/web: nothing is listed here, so
 * adding a capability or a layer needs no edit. Every missing piece is reported in one failure message. To preview a
 * later phase before the integrator bumps BUILT_THROUGH_PHASE, run with TSF_PARITY_PHASE=<n>.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PI_KIT, type LayerContext, type LayerHandlers, type LayerModule } from "../../src/agent/layer-context.ts";
import { silentLogger } from "../../src/core/log.ts";
import {
  AGENT_ONLY_TOOLS,
  BUILT_THROUGH_PHASE,
  CAPABILITIES,
  INFRA_ROUTES,
  type Capability,
  type RouteRef,
} from "../../src/shared/capabilities.ts";
import type { LayerCapability, LayerControl, LayerManifest } from "../../src/shared/types.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

// ---------------------------------------------------------------------------------------------------------------
// The checker: pure over an environment, so the tests below can feed it broken ones.

interface WebFile {
  readonly path: string;
  readonly text: string;
}

interface LayerCap {
  readonly layer: string;
  readonly cap: LayerCapability;
}

interface ParityEnv {
  readonly phase: number;
  readonly capabilities: readonly Capability[];
  readonly layerCaps: readonly LayerCap[];
  /** The Service object (its methods). */
  readonly service: Readonly<Record<string, unknown>>;
  readonly app: { request(input: string, init?: RequestInit): Response | Promise<Response>; routes: readonly { method: string; path: string }[] };
  /** Registered tool name -> the layer the registry maps it to. */
  readonly tools: ReadonlyMap<string, string>;
  /** The layer's createHandlers() result; undefined when the layer has none; an Error when it cannot be built. */
  readonly handlers: (layer: string) => Promise<LayerHandlers | undefined | Error>;
  readonly webFiles: readonly WebFile[];
  /** `capability` ids of the LayerControls in a layer's manifest. */
  readonly layerControls: (layer: string) => readonly string[];
  readonly agentOnly: Readonly<Record<string, string>>;
  readonly infraRoutes: readonly RouteRef[];
}

/** Query strings for GET routes that read one (the rest answer 400, which is fine). */
const GET_QUERY: Readonly<Record<string, string>> = {
  "/api/pages/read": "?path=Start%20Here.md",
  "/api/chat/earlier": "?before=1",
};
const LAYER_QUERY = "?input=%7B%7D";
const GENERIC_LAYER_ROUTE = /^\/api\/layers\/:[^/]+\/(query|action)\/:[^/]+$/;

function layerRoute(c: LayerCap): RouteRef {
  return c.cap.kind === "query"
    ? { method: "GET", path: `/api/layers/${c.layer}/query/${c.cap.handler}` }
    : { method: "POST", path: `/api/layers/${c.layer}/action/${c.cap.handler}` };
}

/** A layer capability as a Capability (DESIGN 10 "Layer capabilities"). */
export function expandLayerCap(c: LayerCap): Capability {
  return {
    id: c.cap.id,
    summary: c.cap.summary,
    phase: 0,
    service: c.cap.kind === "query" ? "layerQuery" : "layerAction",
    routes: [layerRoute(c)],
    tool: { name: c.cap.tool, layer: c.layer },
    control: c.cap.control,
    mutates: c.cap.mutates,
  } as unknown as Capability;
}

const key = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

/** `a/:id` matches `a/0`, and either side may carry the parameters. */
function samePath(a: string, b: string): boolean {
  const x = a.split("/");
  const y = b.split("/");
  return x.length === y.length && x.every((s, i) => s === y[i] || s.startsWith(":") || y[i]!.startsWith(":"));
}

const concrete = (path: string): string => path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "0");

function dataCapLiterals(files: readonly WebFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) for (const m of f.text.matchAll(/data-cap="([^"]+)"/g)) out.add(m[1]!);
  return out;
}

async function answers(env: ParityEnv, route: RouteRef): Promise<string | undefined> {
  const mounted = env.app.routes.some((r) => r.method === route.method && samePath(r.path, route.path));
  if (!mounted) return `${key(route)} is not mounted`;
  const path = concrete(route.path);
  const query = route.method === "GET" ? (GET_QUERY[route.path] ?? (route.path.startsWith("/api/layers/") ? LAYER_QUERY : "")) : "";
  const init: RequestInit =
    route.method === "GET" ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  let res: Response;
  try {
    res = await env.app.request(`${path}${query}`, init);
  } catch (err) {
    return `${key(route)} threw: ${String(err)}`;
  }
  const text = await res.text();
  if (res.status === 405) return `${key(route)} answered 405`;
  if (res.status >= 500) return `${key(route)} answered ${res.status}: ${text.slice(0, 120)}`;
  if (res.status === 404) {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return `${key(route)} answered a plain 404 (no such route)`;
    }
    // The app's catch-all also answers JSON not_found; only a resource that is missing counts.
    if (body.error?.code !== "not_found" || /no such route/i.test(body.error.message ?? "")) {
      return `${key(route)} answered 404 "${body.error?.message ?? text.slice(0, 80)}": no such route`;
    }
  }
  return undefined;
}

/** Runs every check that applies at `env.phase`; returns one message per missing piece. */
export async function checkParity(env: ParityEnv): Promise<string[]> {
  const problems: string[] = [];
  const caps: Capability[] = [...env.capabilities.filter((c) => c.phase <= env.phase), ...env.layerCaps.map(expandLayerCap)];
  const layerCapIds = new Set(env.layerCaps.map((c) => c.cap.id));
  // The reverse checks (5, 6) know every listed capability, also those of a later phase: a tool or route built ahead of
  // BUILT_THROUGH_PHASE (the integrator bumps it after the phase's checks) belongs to its capability, not to nobody.
  const allCaps: Capability[] = [...env.capabilities, ...env.layerCaps.map(expandLayerCap)];
  const seen = new Set<string>();

  for (const cap of caps) {
    const who = `capability ${cap.id}`;
    if (seen.has(cap.id)) problems.push(`[list] ${who} is listed twice`);
    seen.add(cap.id);
    if (!cap.summary) problems.push(`[list] ${who} has no summary`);
    if (cap.routes.length === 0) problems.push(`[list] ${who} names no route`);
    if (!cap.tool?.name || !cap.tool.layer) problems.push(`[list] ${who} names no tool`);
    if (!cap.control) problems.push(`[list] ${who} names no UI control`);
    else if (cap.control !== cap.id) problems.push(`[list] ${who}: control "${cap.control}" must equal the id`);

    // 1. Service method (and a layer's handler).
    if (typeof env.service[cap.service] !== "function") problems.push(`[1] ${who}: Service has no method ${cap.service}`);
  }

  for (const lc of env.layerCaps) {
    const who = `capability ${lc.cap.id}`;
    if (!lc.cap.id.startsWith(`${lc.layer}.`)) problems.push(`[list] ${who}: the id must start with ${lc.layer}.`);
    const handlers = await env.handlers(lc.layer);
    if (handlers instanceof Error) {
      problems.push(`[1] ${who}: ${lc.layer} createHandlers() failed: ${handlers.message}`);
    } else {
      const table = lc.cap.kind === "query" ? handlers?.queries : handlers?.actions;
      if (typeof table?.[lc.cap.handler] === "undefined") {
        problems.push(`[1] ${who}: layer ${lc.layer} has no ${lc.cap.kind} handler "${lc.cap.handler}"`);
      }
    }
  }

  // 2. Routes answer.
  const routeSeen = new Set<string>();
  for (const cap of caps) {
    for (const route of cap.routes) {
      if (routeSeen.has(key(route))) continue;
      routeSeen.add(key(route));
      const problem = await answers(env, route);
      if (problem) problems.push(`[2] capability ${cap.id}: route ${problem}`);
    }
  }
  for (const route of env.infraRoutes) {
    if (route.path === "/api/events" || routeSeen.has(key(route))) continue;
    // Infrastructure routes are exercised when they are mounted; the P3 ones are not mounted before P3.
    if (route.method !== "GET" || !env.app.routes.some((r) => r.method === route.method && samePath(r.path, route.path))) continue;
    routeSeen.add(key(route));
    const problem = await answers(env, route);
    if (problem) problems.push(`[2] infrastructure route ${problem}`);
  }

  // 3. Tool registered, mapped to the capability's layer.
  for (const cap of caps) {
    if (!cap.tool?.name) continue;
    const layer = env.tools.get(cap.tool.name);
    if (layer === undefined) problems.push(`[3] capability ${cap.id}: tool ${cap.tool.name} is not registered`);
    else if (layer !== cap.tool.layer) {
      problems.push(`[3] capability ${cap.id}: tool ${cap.tool.name} is registered by layer ${layer}, not ${cap.tool.layer}`);
    }
  }

  // 4. UI controls (from phase 3).
  const literals = dataCapLiterals(env.webFiles);
  if (env.phase >= 3) {
    for (const cap of caps) {
      if (layerCapIds.has(cap.id)) continue;
      if (!literals.has(cap.control)) problems.push(`[4] capability ${cap.id}: no data-cap="${cap.control}" in src/web`);
    }
    for (const lc of env.layerCaps) {
      if (!env.layerControls(lc.layer).includes(lc.cap.control)) {
        problems.push(`[4] capability ${lc.cap.id}: no LayerControl with capability "${lc.cap.control}" in layer ${lc.layer}'s manifest`);
      }
    }
  }

  // 5. Reverse, tools (from phase 2).
  if (env.phase >= 2) {
    const capTools = new Set(allCaps.map((c) => c.tool?.name));
    for (const [name, layer] of env.tools) {
      if (capTools.has(name)) {
        if (name in env.agentOnly) problems.push(`[5] tool ${name} is a capability's tool and also in AGENT_ONLY_TOOLS`);
        continue;
      }
      if (!(name in env.agentOnly)) problems.push(`[5] tool ${name} (layer ${layer}) is no capability's tool and not in AGENT_ONLY_TOOLS`);
    }
    for (const [name, reason] of Object.entries(env.agentOnly)) {
      if (reason.trim() === "") problems.push(`[5] AGENT_ONLY_TOOLS.${name} has no reason`);
    }
  }

  // 6. Reverse, routes (from phase 2).
  if (env.phase >= 2) {
    const owned = [...allCaps.flatMap((c) => c.routes), ...env.infraRoutes];
    for (const r of env.app.routes) {
      if ((r.method !== "GET" && r.method !== "POST") || !r.path.startsWith("/api/") || r.path.includes("*")) continue;
      if (r.path === "/api/events" && env.infraRoutes.some((i) => i.path === r.path)) continue;
      if (GENERIC_LAYER_ROUTE.test(r.path)) continue;
      if (!owned.some((o) => o.method === r.method && o.path === r.path)) {
        problems.push(`[6] route ${key(r)} belongs to no capability and is not in INFRA_ROUTES`);
      }
    }
  }

  // 7. Reverse, controls (from phase 5, once the list is complete).
  if (env.phase >= 5) {
    // allCaps, as checks 5 and 6: a control may ship before BUILT_THROUGH_PHASE reaches its capability's phase (P7).
    const ids = new Set(allCaps.map((c) => c.id));
    for (const id of literals) {
      if (!ids.has(id)) problems.push(`[7] data-cap="${id}" in src/web is no capability id`);
    }
    for (const f of env.webFiles) {
      if (/data-cap=\{/.test(f.text) && !/(^|[\\/])LayerControl\.tsx$/.test(f.path)) {
        problems.push(`[7] ${f.path} writes data-cap={...}; only LayerControl.tsx may`);
      }
    }
  }

  return problems;
}

function report(problems: readonly string[]): string {
  return `parity: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The real app

const PHASE = Number(process.env.TSF_PARITY_PHASE) > 0 ? Number(process.env.TSF_PARITY_PHASE) : BUILT_THROUGH_PHASE;

type TestFactory = Awaited<ReturnType<typeof createTestFactory>>;
let factory: TestFactory;

beforeAll(async () => {
  factory = await createTestFactory();
});

afterAll(async () => {
  await factory.close();
  await cleanupTmp();
});

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function controlsOf(manifest: LayerManifest): string[] {
  const controls: LayerControl[] = [
    ...manifest.ui.settingsPanels.flatMap((p) => p.controls),
    ...manifest.ui.widgets.map((w) => w.control),
  ];
  return controls.flatMap((c) => ("capability" in c && typeof c.capability === "string" ? [c.capability] : []));
}

async function realEnv(): Promise<ParityEnv> {
  const { agent, paths, service, app } = factory;
  const registry = agent.registry;
  const layers = registry.layers();
  const tools = new Map(registry.toolInfos(agent.settings(), new Set()).map((t) => [t.name, t.layer] as const));
  const files = await walk(paths.webSrc);
  const webFiles = await Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
  const layerCaps = layers.flatMap((l) => (l.manifest.capabilities ?? []).map((cap) => ({ layer: l.manifest.name, cap })));
  const ctx = {
    service: () => service,
    paths,
    log: silentLogger,
    bus: { publish() {}, subscribe: () => () => {} },
    settings: () => agent.settings(),
    ceiling: () => registry.ceiling(),
    modelCache: { get: () => undefined, put() {} },
    prompts: () => ({ customText: () => "" }),
    jev: async () => {
      throw new Error("jev is not available in the parity test");
    },
    pi: PI_KIT,
  } as unknown as LayerContext;
  return {
    phase: PHASE,
    capabilities: CAPABILITIES,
    layerCaps,
    service: service as unknown as Record<string, unknown>,
    app,
    tools,
    handlers: async (layer) => {
      const loaded = layers.find((l) => l.manifest.name === layer);
      if (!loaded) return new Error("layer not loaded");
      const dir = join(loaded.source === "builtin" ? paths.builtinLayersDir : paths.layersDir, layer);
      try {
        const mod = (await import(pathToFileURL(join(dir, "extension.ts")).href)) as Partial<LayerModule>;
        return mod.createHandlers?.(ctx);
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    },
    webFiles,
    layerControls: (layer) => {
      const m = layers.find((l) => l.manifest.name === layer)?.manifest;
      return m ? controlsOf(m) : [];
    },
    agentOnly: AGENT_ONLY_TOOLS,
    infraRoutes: INFRA_ROUTES,
  };
}

function printAgentOnly(tools: ReadonlyMap<string, string>): void {
  const lines = Object.entries(AGENT_ONLY_TOOLS).map(
    ([name, reason]) => `  ${name.padEnd(8)} ${tools.has(name) ? "registered" : "not registered"}  ${reason}`,
  );
  console.info(
    `AGENT_ONLY_TOOLS (registered tools with no capability, no UI control; spec 2.2 / 8.7 departure, DESIGN 10 and 14):\n${lines.join("\n")}`,
  );
}

describe("parity: the real app", () => {
  it(`every capability through phase ${PHASE} has its service method, routes, tool and control`, async () => {
    const env = await realEnv();
    printAgentOnly(env.tools);
    console.info(
      `parity: phase ${PHASE} (BUILT_THROUGH_PHASE ${BUILT_THROUGH_PHASE}); ${CAPABILITIES.filter((c) => c.phase <= PHASE).length} capabilities, ` +
        `${env.layerCaps.length} layer capabilities, ${env.tools.size} tools, ` +
        `${env.app.routes.filter((r) => r.path.startsWith("/api/") && !r.path.includes("*")).length} /api routes, ${env.webFiles.length} web files`,
    );
    const problems = await checkParity(env);
    expect(problems, report(problems)).toEqual([]);
  });

  it("GET /api/events sends hello, then the test aborts it", async () => {
    const abort = new AbortController();
    const res = await factory.app.request("/api/events", { signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (!text.includes("event: hello") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    abort.abort();
    await reader.cancel().catch(() => undefined);
    expect(text).toContain("event: hello");
  });

  it("every tool of every loaded layer is mapped to its layer by the registry", () => {
    const { registry } = factory.agent;
    for (const l of registry.layers()) {
      for (const t of l.extension.tools ?? []) expect(registry.toolLayer(t.name), t.name).toBe(l.manifest.name);
    }
  });

  it("AGENT_ONLY_TOOLS names only tools of coding_tools and gives each a reason", () => {
    for (const [name, reason] of Object.entries(AGENT_ONLY_TOOLS)) {
      expect(reason.length, name).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The checker itself: broken environments are reported, every piece at once.

function fakeApp(extra?: (app: Hono) => void): Hono {
  const app = new Hono();
  extra?.(app);
  app.get("/api/ok", (c) => c.json({}));
  app.post("/api/make", (c) => c.json({ error: { code: "invalid", message: "bad body" } }, 400));
  app.get("/api/thing/:id", (c) => c.json({ error: { code: "not_found", message: "no such thing: 0" } }, 404));
  app.get("/api/stray", (c) => c.json({}));
  app.get("/api/events", (c) => c.text("event: hello"));
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "no such route: x" } }, 404));
  return app;
}

/** fakeApp plus two routes that answer wrongly. */
function badApp(): Hono {
  const app = new Hono();
  app.get("/api/plain", (c) => c.text("404 Not Found", 404));
  app.get("/api/boom", (c) => c.json({ error: { code: "internal", message: "x" } }, 500));
  app.route("/", fakeApp());
  return app;
}

/** The routes of fakeApp other than /api/ok, as infrastructure, so only /api/ok needs a capability. */
const FAKE_INFRA: RouteRef[] = [
  { method: "GET", path: "/api/events" },
  { method: "POST", path: "/api/make" },
  { method: "GET", path: "/api/thing/:id" },
  { method: "GET", path: "/api/stray" },
];

const cap = (id: string, over: Partial<Capability> = {}): Capability =>
  ({
    id,
    summary: `s ${id}`,
    phase: 2,
    service: "listPages",
    routes: [{ method: "GET", path: "/api/ok" }],
    tool: { name: "list_pages", layer: "page_harness" },
    control: id,
    mutates: false,
    ...over,
  }) as Capability;

function fakeEnv(over: Partial<ParityEnv> = {}): ParityEnv {
  return {
    phase: 2,
    capabilities: [cap("a.one")],
    layerCaps: [],
    service: { listPages: () => ({}), layerQuery: () => ({}), layerAction: () => ({}) },
    app: fakeApp(),
    tools: new Map([["list_pages", "page_harness"]]),
    handlers: async () => undefined,
    webFiles: [],
    layerControls: () => [],
    agentOnly: {},
    infraRoutes: FAKE_INFRA,
    ...over,
  };
}

describe("parity: the checker", () => {
  it("passes a consistent environment", async () => {
    const problems = await checkParity(fakeEnv());
    expect(problems).toEqual([]);
  });

  it("a capability without its pieces is reported in one go, every piece named", async () => {
    const env = fakeEnv({
      capabilities: [
        cap("a.one"),
        cap("b.broken", {
          service: "nope" as never,
          routes: [{ method: "POST", path: "/api/missing" }],
          tool: { name: "ghost", layer: "page_harness" },
        }),
        cap("c.wrong", { tool: { name: "list_pages", layer: "other_layer" } }),
      ],
    });
    const problems = await checkParity(env);
    expect(problems.some((p) => p.startsWith("[1]") && p.includes("b.broken") && p.includes("nope"))).toBe(true);
    expect(problems.some((p) => p.startsWith("[2]") && p.includes("POST /api/missing is not mounted"))).toBe(true);
    expect(problems.some((p) => p.startsWith("[3]") && p.includes("ghost is not registered"))).toBe(true);
    expect(problems.some((p) => p.startsWith("[3]") && p.includes("registered by layer page_harness, not other_layer"))).toBe(true);
    expect(() => expect(problems, report(problems)).toEqual([])).toThrow(/b\.broken[\s\S]*ghost[\s\S]*other_layer/);
  });

  it("route answers: 400 and a missing resource pass; a plain 404, 5xx and 405 fail; an unmounted route is named", async () => {
    const check = async (method: "GET" | "POST", path: string) =>
      (
        await checkParity(
          fakeEnv({ app: badApp(), capabilities: [cap("x.y", { routes: [{ method, path }] })], infraRoutes: [] }),
        )
      ).filter((p) => p.startsWith("[2]"));
    expect(await check("POST", "/api/make")).toEqual([]);
    expect(await check("GET", "/api/thing/:id")).toEqual([]);
    expect((await check("GET", "/api/plain"))[0]).toContain("plain 404");
    expect((await check("GET", "/api/boom"))[0]).toContain("answered 500");
    // The app's catch-all also answers a JSON 404; a route that is not mounted is "not mounted" all the same.
    expect((await check("GET", "/api/absent"))[0]).toContain("GET /api/absent is not mounted");
    // POST on a GET-only route is not mounted for POST.
    expect((await check("POST", "/api/ok"))[0]).toContain("POST /api/ok is not mounted");
  });

  it("reverse checks run from phase 2: an unclaimed tool and unclaimed routes are reported", async () => {
    const env = fakeEnv({
      tools: new Map([
        ["list_pages", "page_harness"],
        ["stray_tool", "page_harness"],
        ["bash", "coding_tools"],
      ]),
      agentOnly: { bash: "runs a shell command" },
      infraRoutes: [{ method: "GET", path: "/api/events" }],
    });
    const problems = await checkParity(env);
    expect(problems.filter((p) => p.startsWith("[5]"))).toEqual([
      "[5] tool stray_tool (layer page_harness) is no capability's tool and not in AGENT_ONLY_TOOLS",
    ]);
    expect(problems.filter((p) => p.startsWith("[6]"))).toEqual([
      "[6] route POST /api/make belongs to no capability and is not in INFRA_ROUTES",
      "[6] route GET /api/thing/:id belongs to no capability and is not in INFRA_ROUTES",
      "[6] route GET /api/stray belongs to no capability and is not in INFRA_ROUTES",
    ]);
  });

  it("a tool both in a capability and in AGENT_ONLY_TOOLS is reported", async () => {
    const problems = await checkParity(fakeEnv({ agentOnly: { list_pages: "x".repeat(20) } }));
    expect(problems).toContain("[5] tool list_pages is a capability's tool and also in AGENT_ONLY_TOOLS");
  });

  it("phase 1 runs neither reverse check nor the control check", async () => {
    const env = fakeEnv({ phase: 1, capabilities: [cap("a.one", { phase: 1 })], tools: new Map([["list_pages", "page_harness"], ["extra", "x"]]) });
    expect(await checkParity(env)).toEqual([]);
  });

  it("controls are checked from phase 3: data-cap literal for a built-in, LayerControl for a layer", async () => {
    const lc: LayerCap = {
      layer: "my_layer",
      cap: { id: "my_layer.go", summary: "go", kind: "action", handler: "go", tool: "go_tool", control: "my_layer.go", mutates: true },
    };
    const base = {
      capabilities: [cap("a.one")],
      layerCaps: [lc],
      tools: new Map([["list_pages", "page_harness"], ["go_tool", "my_layer"]]),
      handlers: async () => ({ actions: { go: { replay: "safe" as const, run: async () => null } } }),
    };
    const mounted = fakeApp((a) => a.post("/api/layers/my_layer/action/go", (c) => c.json({}, 400)));
    const at = (phase: number, over: Partial<ParityEnv> = {}) => checkParity(fakeEnv({ ...base, app: mounted, phase, ...over }));

    expect((await at(2)).filter((p) => p.startsWith("[4]"))).toEqual([]);
    const missing = (await at(3)).filter((p) => p.startsWith("[4]"));
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain('no data-cap="a.one"');
    expect(missing[1]).toContain('no LayerControl with capability "my_layer.go"');

    const ok = await at(3, {
      webFiles: [{ path: "src/web/X.tsx", text: '<button data-cap="a.one" />' }],
      layerControls: () => ["my_layer.go"],
    });
    expect(ok.filter((p) => p.startsWith("[4]"))).toEqual([]);
  });

  it("a layer capability needs its handler, a createHandlers that works, and its id prefix", async () => {
    const lc = (over: Partial<LayerCapability> = {}): LayerCap => ({
      layer: "my_layer",
      cap: { id: "my_layer.q", summary: "q", kind: "query", handler: "q", tool: "q_tool", control: "my_layer.q", mutates: false, ...over },
    });
    const app = fakeApp((a) => a.get("/api/layers/my_layer/query/q", (c) => c.json({})));
    const run = (layerCap: LayerCap, handlers: ParityEnv["handlers"]) =>
      checkParity(fakeEnv({ app, layerCaps: [layerCap], tools: new Map([["list_pages", "page_harness"], ["q_tool", "my_layer"]]), handlers }));
    expect(await run(lc(), async () => ({ queries: { q: () => null } }))).toEqual([]);
    expect((await run(lc(), async () => undefined))[0]).toContain('has no query handler "q"');
    expect((await run(lc(), async () => ({ actions: {} })))[0]).toContain('has no query handler "q"');
    expect((await run(lc(), async () => new Error("boom")))[0]).toContain("createHandlers() failed: boom");
    expect((await run(lc({ id: "other.q", control: "other.q" }), async () => ({ queries: { q: () => null } })))[0]).toContain("must start with my_layer.");
  });

  it("check 7 from phase 5: an unknown data-cap id and a dynamic data-cap outside LayerControl.tsx", async () => {
    const env = fakeEnv({
      phase: 5,
      webFiles: [
        { path: "src/web/A.tsx", text: '<i data-cap="a.one" /><i data-cap="ghost.id" />' },
        { path: "src/web/B.tsx", text: "<i data-cap={id} />" },
        { path: "src/web/layers/LayerControl.tsx", text: "<i data-cap={control.capability} />" },
      ],
    });
    const seven = (await checkParity(env)).filter((p) => p.startsWith("[7]"));
    expect(seven).toEqual([
      '[7] data-cap="ghost.id" in src/web is no capability id',
      "[7] src/web/B.tsx writes data-cap={...}; only LayerControl.tsx may",
    ]);
  });

  it("a capability that lacks a tool, a control or a route is reported before anything else", async () => {
    const env = fakeEnv({
      capabilities: [cap("a.one", { routes: [], control: "", tool: { name: "", layer: "" } })],
    });
    const problems = await checkParity(env);
    expect(problems).toEqual(
      expect.arrayContaining([
        "[list] capability a.one names no route",
        "[list] capability a.one names no tool",
        "[list] capability a.one names no UI control",
      ]),
    );
  });
});
