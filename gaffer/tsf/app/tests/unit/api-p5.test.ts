/**
 * P5 (Core 4): context and compaction, model and thinking, the four prompt layers, the tool matrix, layers, ceiling and
 * runs, through the HTTP app, the Service and (for acceptance 4 and 5) the agent's own tools on the faux model.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextInfo, ModelSelection, PromptInfo, PromptList, ToolDescription } from "../../src/shared/types.ts";
import type { ChatItem, Delta, Settings, ToolInfo } from "../../src/shared/types.ts";
import type { AppEvent } from "../../src/shared/events.ts";
import type { Factory } from "../../src/server/main.ts";
import { DISABLE_CODING_PROMPT, DISABLE_CODING_REPLY, LIST_TOOLS_PROMPT, LIST_TOOLS_REPLY, rules } from "../fixtures/faux-demo.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const ctx = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let factory: Factory & { root: string };
let events: AppEvent[];

beforeEach(async () => {
  factory = await createTestFactory({ rules });
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
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const ofType = (type: string) => events.filter((e) => e.type === type);
const settings = (): Settings => factory.service.getSettings();
const ui = { by: "ui" } as const;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Send text and wait until the run is over; returns the tool items of the turn and the last assistant text. */
async function turn(text: string): Promise<{ tools: ToolItem[]; reply: string }> {
  const before = factory.service.chatView().items.length;
  await factory.service.sendMessage({ text, requestId: `r-${Math.random().toString(36).slice(2)}` }, ui);
  const end = Date.now() + 15_000;
  for (;;) {
    const view = factory.service.chatView();
    const fresh = view.items.slice(before);
    const last = fresh.at(-1);
    if (!view.live.busy && view.live.inbox.length === 0 && last?.kind === "assistant" && last.text !== "" && view.live.phase === "idle") {
      const tools = fresh.filter((i): i is ToolItem => i.kind === "tool");
      if (tools.every((t) => t.status !== "running" && t.status !== "pending")) return { tools, reply: last.text };
    }
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(fresh)}`);
    await sleep(25);
  }
}

const probe = (tool: string, args: unknown = {}) => turn(`probe ${tool} ${JSON.stringify(args)}`);

/** The sections of the newest request: merge the `pi.system` entries in order (null removes a section). */
async function requestSections(): Promise<Record<string, string>> {
  const page = await factory.agent.main.entries({ order: "ascending" }, 200, undefined, ctx);
  const merged: Record<string, string> = {};
  for (const e of page.items) {
    if (e.kind !== "pi.system") continue;
    const sections = (e.model?.[0] as { sections?: Record<string, string | null> } | undefined)?.sections ?? {};
    for (const [k, v] of Object.entries(sections)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
  }
  return merged;
}

describe("context and compaction", () => {
  it("GET /api/context returns the readings and the effective thresholds", async () => {
    const info = await json<ContextInfo>(await get("context"));
    expect(info).toMatchObject({
      model: { provider: "faux", modelId: "faux-1" },
      contextWindow: 1_000_000,
      contextTokens: 0,
      fraction: 0,
      compacting: false,
      points: { enabled: true, background: 200_000, forced: 500_000, keepRecentTokens: 20_000 },
      compaction: { window: 1_000_000, background: 200_000, forced: 500_000, clamped: false },
    });
  });

  it("set_compaction clamps both thresholds to the window at read time and keeps the stored numbers (D3)", async () => {
    const res = await post("compaction/set", { background: 990_000, forced: 5_000_000 });
    expect(res.status).toBe(200);
    const info = await json<ContextInfo>(res);
    expect(info.points).toMatchObject({ background: 990_000, forced: 5_000_000 });
    expect(info.compaction).toMatchObject({ window: 1_000_000, forced: 1_000_000 - 16_384, clamped: true });
    expect(info.compaction.background).toBe(1_000_000 - 16_384 - 8_192);
    expect(settings().compaction).toMatchObject({ background: 990_000, forced: 5_000_000, enabled: true });
    const changed = ofType("settings.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ keys: ["compaction"], by: "ui" });
    // The chat meta (the context bar) follows without a conversation commit.
    expect(factory.service.chatView().meta.compaction.forced).toBe(1_000_000 - 16_384);
    expect(ofType("settings.changed")).toHaveLength(1);
  });

  it("merges partial points and refuses bad ones", async () => {
    await post("compaction/set", { enabled: false });
    expect(settings().compaction).toEqual({ enabled: false, background: 200_000, forced: 500_000, keepRecentTokens: 20_000 });
    expect(await errorCode(await post("compaction/set", {}))).toBe("invalid");
    expect(await errorCode(await post("compaction/set", { forced: 12.5 }))).toBe("invalid");
    expect(await errorCode(await post("compaction/set", { forced: 5 }))).toBe("invalid");
    expect(await errorCode(await post("compaction/set", { background: "lots" }))).toBe("invalid");
    expect(await errorCode(await post("compaction/set", { colour: 1 }))).toBe("invalid");
  });

  it("compact admits a manual compaction task", async () => {
    await turn("ping");
    const res = await post("compact", { instructions: "keep the decisions" });
    expect(res.status).toBe(200);
    expect(await json<{ taskId: number; instructions: string }>(res)).toMatchObject({ instructions: "keep the decisions" });
    expect(await errorCode(await post("compact", { instructions: 5 }))).toBe("invalid");
  });
});

describe("model and thinking", () => {
  it("set_thinking_level max reaches the settings, the event, the agent and the chat meta (acceptance 5)", async () => {
    const res = await post("thinking/set", { level: "max" });
    expect(res.status).toBe(200);
    expect(await json<ModelSelection>(res)).toMatchObject({ thinkingLevel: "max", effectiveThinkingLevel: "max" });
    expect(settings().thinkingLevel).toBe("max");
    expect((await json<Settings>(await get("settings"))).thinkingLevel).toBe("max");
    expect(ofType("settings.changed").at(-1)).toMatchObject({ keys: ["thinkingLevel"], settings: { thinkingLevel: "max" } });
    expect((await factory.agent.main.agent(ctx)).thinkingLevel).toBe("max");
    await vi.waitFor(() => expect(factory.service.chatView().meta.thinkingLevel).toBe("max"));
    expect(await errorCode(await post("thinking/set", { level: "ludicrous" }))).toBe("invalid");
  });

  it("set_model validates against the catalog; refresh answers and announces the list", async () => {
    expect(await errorCode(await post("model/set", { provider: "faux", modelId: "nope" }))).toBe("not_found");
    expect(await errorCode(await post("model/set", {}))).toBe("invalid");
    const ok = await post("model/set", { provider: "faux", modelId: "faux-1" });
    expect(await json<ModelSelection>(ok)).toMatchObject({ model: { provider: "faux", modelId: "faux-1" }, modelName: "Faux" });
    expect(settings().model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(ofType("settings.changed").at(-1)).toMatchObject({ keys: ["model"] });

    const refreshed = await post("models/refresh", {});
    expect(await json<{ refreshed: string[]; count: number }>(refreshed)).toEqual({ refreshed: [], count: 1 });
    expect(ofType("models.changed").length).toBeGreaterThan(0);
  });
});

describe("prompts", () => {
  it("lists the four layers", async () => {
    await post("prompts/custom/create", { name: "Tone", text: "Be terse." });
    await post("prompts/runtime/append", { text: "Mention the date." });
    const list = await json<PromptList>(await get("prompts"));
    expect(list.system).toMatchObject({ id: "system", override: false, editable: true });
    expect(list.system.text).toContain("{{factoryName}}");
    expect(list.custom.map((p) => [p.id.startsWith("custom:"), p.title, p.enabled])).toEqual([[true, "Tone", true]]);
    expect(list.extensions.map((p) => p.key)).toEqual([
      "factory_harness-identity",
      "factory_harness-cron",
      "factory_harness-custom",
      "coding_tools-scope",
      "page_harness-rules",
      "factory_controls-rules",
    ]);
    expect(list.extensions.every((p) => !p.editable && p.enabled && p.text === null)).toBe(true);
    expect(list.runtime.map((p) => p.text)).toEqual(["Mention the date."]);
  });

  it("get_prompt reads each layer; a section is rendered", async () => {
    const section = await json<PromptInfo>(await get("prompts/get?id=section%3Apage_harness-rules"));
    expect(section.text).toContain("Markdown files in nested folders");
    const identity = await json<PromptInfo>(await get("prompts/get?id=factory_harness-identity"));
    expect(identity.text).toContain(`Factory: ${settings().factoryName}`);
    expect((await json<PromptInfo>(await get("prompts/get?id=system"))).layer).toBe("system");
    expect((await get("prompts/get?id=custom%3Anope")).status).toBe(404);
    expect((await get("prompts/get")).status).toBe(400);
  });

  it("the system prompt override is stored, announced and reset with null", async () => {
    const set = await post("prompts/system", { text: "You are {{factoryName}}. Be brief." });
    expect(await json<PromptInfo>(set)).toMatchObject({ override: true, text: "You are {{factoryName}}. Be brief." });
    expect(settings().systemPrompt).toBe("You are {{factoryName}}. Be brief.");
    expect(ofType("settings.changed").at(-1)).toMatchObject({ keys: ["systemPrompt"] });
    expect(ofType("prompts.changed")).toHaveLength(1);
    await turn("ping");
    expect((await requestSections())["factory_harness-system"]).toBe(`You are ${settings().factoryName}. Be brief.`);
    const reset = await post("prompts/system", { text: null });
    expect(await json<PromptInfo>(reset)).toMatchObject({ override: false });
    expect(settings().systemPrompt).toBeNull();
    expect(await errorCode(await post("prompts/system", { text: "  " }))).toBe("invalid");
    expect(await errorCode(await post("prompts/system", {}))).toBe("invalid");
  });

  it("custom prompts: create, update, toggle, delete; names are unique; the section follows", async () => {
    const created = await json<PromptInfo>(await post("prompts/custom/create", { name: "Tone", text: "Be terse." }));
    expect(created).toMatchObject({ layer: "custom", title: "Tone", enabled: true, by: "ui" });
    expect(await errorCode(await post("prompts/custom/create", { name: "Tone", text: "again" }))).toBe("conflict");
    expect(await errorCode(await post("prompts/custom/create", { name: "bad\nname", text: "x" }))).toBe("invalid");
    await turn("ping");
    expect((await requestSections())["factory_harness-custom"]).toContain("## Tone\nBe terse.");

    const updated = await json<PromptInfo>(await post("prompts/custom/update", { id: created.id, text: "Be very terse." }));
    expect(updated.text).toBe("Be very terse.");
    expect(await errorCode(await post("prompts/custom/update", { id: created.id }))).toBe("invalid");
    expect(await errorCode(await post("prompts/custom/update", { id: "custom:zzz", text: "x" }))).toBe("not_found");

    const off = await json<PromptInfo>(await post("prompts/toggle", { id: created.id, enabled: false }));
    expect(off.enabled).toBe(false);
    await turn("ping");
    expect((await requestSections())["factory_harness-custom"]).toBeUndefined();

    expect(await json(await post("prompts/custom/delete", { id: created.id }))).toEqual({ id: created.id });
    expect((await json<PromptList>(await get("prompts"))).custom).toEqual([]);
    expect(await errorCode(await post("prompts/custom/delete", { id: created.id }))).toBe("not_found");
    expect(ofType("prompts.changed").length).toBeGreaterThanOrEqual(4);
  });

  it("an agent call id keys the row: a replayed create returns the same prompt (D13)", async () => {
    const origin = { by: "agent", callId: "call-1" } as const;
    const a = await factory.service.createCustomPrompt({ name: "Tone", text: "Be terse." }, origin);
    const b = await factory.service.createCustomPrompt({ name: "Tone", text: "Be terse." }, origin);
    expect(b.id).toBe(a.id);
    expect(a.by).toBe("agent");
    expect((await factory.service.listPrompts()).custom).toHaveLength(1);
    const r1 = await factory.service.appendRuntimePrompt({ text: "Hi." }, origin);
    const r2 = await factory.service.appendRuntimePrompt({ text: "Hi." }, origin);
    expect(r2.id).toBe(r1.id);
    expect((await factory.service.listPrompts()).runtime).toHaveLength(1);
  });

  it("extension sections switch off and on (D6) and the next request follows; the system section is fixed", async () => {
    await turn("ping");
    expect(Object.keys(await requestSections())).toContain("factory_harness-identity");
    const off = await json<PromptInfo>(await post("prompts/toggle", { id: "section:factory_harness-identity", enabled: false }));
    expect(off).toMatchObject({ layer: "extension", enabled: false });
    expect(ofType("prompts.changed")).toHaveLength(1);
    const list = await json<PromptList>(await get("prompts"));
    expect(list.extensions.find((p) => p.key === "factory_harness-identity")?.enabled).toBe(false);
    // A switched-off section can still be read.
    expect((await json<PromptInfo>(await get("prompts/get?id=section%3Afactory_harness-identity"))).text).toContain("Factory:");
    await turn("ping");
    const sections = await requestSections();
    expect(sections["factory_harness-identity"]).toBeUndefined();
    expect(sections["factory_harness-system"]).toBeDefined();

    await post("prompts/toggle", { id: "section:factory_harness-identity", enabled: true });
    await turn("ping");
    expect((await requestSections())["factory_harness-identity"]).toContain("Factory:");

    expect(await errorCode(await post("prompts/toggle", { id: "section:factory_harness-system", enabled: false }))).toBe("invalid");
    expect(await errorCode(await post("prompts/toggle", { id: "section:nope-nothing", enabled: false }))).toBe("not_found");
    expect(await errorCode(await post("prompts/toggle", { id: "system", enabled: false }))).toBe("invalid");
    expect(await errorCode(await post("prompts/toggle", { id: "section:coding_tools-scope" }))).toBe("invalid");
  });

  it("runtime prompts join the next request as `instructions`, and leave with remove or clear", async () => {
    const one = await json<PromptInfo>(await post("prompts/runtime/append", { text: "Always answer in French." }));
    const two = await json<PromptInfo>(await post("prompts/runtime/append", { text: "Sign off with ok." }));
    expect(one.id).toMatch(/^runtime:/);
    expect((await factory.agent.main.agent(ctx)).instructions).toBe("Always answer in French.\n\nSign off with ok.");
    await turn("ping");
    expect((await requestSections()).instructions).toContain("Always answer in French.");

    expect(await json(await post("prompts/runtime/remove", { id: one.id }))).toEqual({ id: one.id });
    expect((await factory.agent.main.agent(ctx)).instructions).toBe("Sign off with ok.");
    expect(await errorCode(await post("prompts/runtime/remove", { id: one.id }))).toBe("not_found");
    expect(await json(await post("prompts/runtime/clear", {}))).toEqual({ removed: 1 });
    expect((await factory.agent.main.agent(ctx)).instructions).toBeUndefined();
    expect((await json<PromptList>(await get("prompts"))).runtime).toEqual([]);
    expect(two.layer).toBe("runtime");
    await turn("ping");
    expect((await requestSections()).instructions).toBeUndefined();
  });
});

describe("tools", () => {
  it("GET /api/tools lists tools inside the ceiling by layer with enabled and offered flags", async () => {
    const tools = await json<ToolInfo[]>(await get("tools"));
    const read = tools.find((t) => t.name === "read")!;
    expect(read).toMatchObject({ layer: "coding_tools", enabled: true, offered: true, inCeiling: true });
    expect(tools.find((t) => t.name === "set_tool_enabled")?.layer).toBe("factory_controls");
  });

  it("describe_tool returns the description, the JSON Schema and a TypeScript signature", async () => {
    const both = await json<ToolDescription>(await get("tools/describe?name=read_page"));
    expect(both).toMatchObject({ name: "read_page", layer: "page_harness", syntax: "both", replay: "safe" });
    expect(both.schema).toMatchObject({ type: "object", properties: { path: { type: "string" } } });
    expect(both.signature).toContain("declare function read_page(args: {");
    expect(both.signature).toContain("path: string;");
    const json1 = await json<ToolDescription>(await get("tools/describe?name=read_page&syntax=json"));
    expect(json1.signature).toBeUndefined();
    expect(JSON.parse(json1.text)).toEqual(json1.schema);
    const ts = await json<ToolDescription>(await get("tools/describe?name=read_page&syntax=typescript"));
    expect(ts.schema).toBeUndefined();
    expect(ts.text).toBe(ts.signature);
    expect((await get("tools/describe?name=nope")).status).toBe(404);
    expect((await get("tools/describe")).status).toBe(400);
    expect((await get("tools/describe?name=read&syntax=yaml")).status).toBe(400);
  });

  it("set_tool_enabled applies through configure, shows in settings, tools and events, and reverses", async () => {
    const res = await post("tools/set-enabled", { name: "bash", enabled: false });
    expect(res.status).toBe(200);
    expect(await json<ToolInfo>(res)).toMatchObject({ name: "bash", enabled: false, offered: false });
    expect(settings().toolsDisabled).toEqual(["bash"]);
    expect(ofType("settings.changed").at(-1)).toMatchObject({ keys: ["toolsDisabled"], settings: { toolsDisabled: ["bash"] } });
    const tools = ofType("tools.changed").at(-1) as Extract<AppEvent, { type: "tools.changed" }>;
    expect(tools.tools.find((t) => t.name === "bash")).toMatchObject({ enabled: false, offered: false });
    expect((await factory.agent.main.agent(ctx)).tools.map((t) => t.name)).not.toContain("bash");
    await vi.waitFor(() => expect(factory.service.chatView().meta.offeredTools).not.toContain("bash"));

    // Disabled, not removed: the model gets tool_unavailable for a probe; list_tools still shows it.
    expect((await json<ToolInfo[]>(await get("tools"))).find((t) => t.name === "bash")?.enabled).toBe(false);

    await post("tools/set-enabled", { name: "bash", enabled: true });
    expect(settings().toolsDisabled).toEqual([]);
    expect((await factory.agent.main.agent(ctx)).tools.map((t) => t.name)).toContain("bash");
    // A no-op announces nothing.
    const n = ofType("settings.changed").length;
    await post("tools/set-enabled", { name: "bash", enabled: true });
    expect(ofType("settings.changed")).toHaveLength(n);

    expect(await errorCode(await post("tools/set-enabled", { name: "nope", enabled: false }))).toBe("not_found");
    expect(await errorCode(await post("tools/set-enabled", { name: "bash" }))).toBe("invalid");
  });

  it("acceptance 4: the agent lists its tools with list_tools", async () => {
    const { tools, reply } = await turn(LIST_TOOLS_PROMPT);
    expect(reply).toBe(LIST_TOOLS_REPLY);
    expect(tools.map((t) => [t.name, t.status])).toEqual([["list_tools", "done"]]);
    // The chat item keeps the tail of a long output; the recorded run holds the whole text.
    await vi.waitFor(() => expect(factory.service.listRuns({}).length).toBe(1));
    const run = factory.service.getRun(factory.service.listRuns({})[0]!.id);
    // The recorder caps a tool's output at 20,000 characters and the factory_controls group alone is longer than that, so
    // read the layer order and the coding_tools group from the (capped) text instead of parsing all of it.
    const text = run.tools[0]!.output;
    const layers = [...new Set([...text.matchAll(/\{"layer":"([a-z_]+)"/g)].map((m) => m[1]))];
    expect(layers).toEqual(["factory_harness", "coding_tools", "page_harness", "factory_controls"]);
    const coding = text.slice(text.indexOf('{"layer":"coding_tools"'), text.indexOf('{"layer":"page_harness"'));
    expect([...coding.matchAll(/"name":"([a-z]+)"/g)].map((m) => m[1])).toEqual(["read", "write", "edit", "bash"]);
    expect(text).not.toContain('"enabled":false');
  });

  it("acceptance 5: 'Disable all coding tools and set thinking to max' shows in the snapshot and in the events", async () => {
    const { tools, reply } = await turn(DISABLE_CODING_PROMPT);
    expect(reply).toBe(DISABLE_CODING_REPLY);
    expect(tools.map((t) => t.status)).toEqual(["done", "done", "done", "done", "done"]);
    const snap = factory.service.snapshot();
    expect(snap.settings.thinkingLevel).toBe("max");
    expect([...snap.settings.toolsDisabled].sort()).toEqual(["bash", "edit", "read", "write"]);
    for (const name of ["read", "write", "edit", "bash"]) {
      expect(snap.tools.find((t) => t.name === name)).toMatchObject({ enabled: false, offered: false });
    }
    const last = ofType("settings.changed").at(-1) as Extract<AppEvent, { type: "settings.changed" }>;
    expect(last.settings.thinkingLevel).toBe("max");
    expect(last.by).toBe("agent");
    expect(ofType("settings.changed").some((e) => (e as Extract<AppEvent, { type: "settings.changed" }>).settings.toolsDisabled.length === 4)).toBe(true);
    await vi.waitFor(() => {
      expect(factory.service.chatView().meta.thinkingLevel).toBe("max");
      expect(factory.service.chatView().meta.offeredTools).not.toContain("read");
    });
    expect((await factory.agent.main.agent(ctx)).tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(["write"]));
  });

  it("the agent can switch a tool back on inside the ceiling", async () => {
    await probe("set_tool_enabled", { name: "bash", enabled: false });
    expect(settings().toolsDisabled).toEqual(["bash"]);
    const { tools } = await probe("set_tool_enabled", { name: "bash", enabled: true });
    expect(tools[0]!.status).toBe("done");
    expect(settings().toolsDisabled).toEqual([]);
  });
});

describe("layers", () => {
  it("a required layer cannot be disabled; others toggle with events and tool changes", async () => {
    expect(await errorCode(await post("layers/set-enabled", { name: "factory_harness", enabled: false }))).toBe("forbidden");
    expect(await errorCode(await post("layers/set-enabled", { name: "nope", enabled: false }))).toBe("not_found");
    const res = await post("layers/set-enabled", { name: "coding_tools", enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "coding_tools", enabled: false });
    expect(settings().layersEnabled).not.toContain("coding_tools");
    expect(ofType("layers.changed")).toHaveLength(1);
    expect(ofType("settings.changed").at(-1)).toMatchObject({ keys: ["layersEnabled"] });
    const tools = ofType("tools.changed").at(-1) as Extract<AppEvent, { type: "tools.changed" }>;
    expect(tools.tools.find((t) => t.name === "read")).toMatchObject({ offered: false, enabled: true });
    expect((await factory.agent.main.agent(ctx)).tools.map((t) => t.name)).not.toContain("read");
    // The layer's sections leave the prompt list with it.
    expect((await factory.service.listPrompts()).extensions.map((p) => p.key)).not.toContain("coding_tools-scope");

    await post("layers/set-enabled", { name: "coding_tools", enabled: true });
    expect(settings().layersEnabled).toContain("coding_tools");
    expect((await factory.agent.main.agent(ctx)).tools.map((t) => t.name)).toContain("read");
  });
});

describe("ceiling and runs", () => {
  it("the ceiling read-out and the run list are served", async () => {
    expect(await json(await get("ceiling"))).toMatchObject({ source: "file", denied: [] });
    await turn("ping");
    await vi.waitFor(async () => expect((await json<unknown[]>(await get("runs"))).length).toBe(1));
    const runs = await json<{ id: number }[]>(await get("runs"));
    expect((await get(`runs/${runs[0]!.id}`)).status).toBe(200);
    expect((await get("runs/99999")).status).toBe(404);
  });

  it("outside the ceiling a tool cannot be listed, described or enabled (forbidden)", async () => {
    await factory.close();
    factory = await createTestFactory({ permissions: { allow: ["*"], deny: ["coding_tools.*"] } });
    expect(await errorCode(await post("tools/set-enabled", { name: "bash", enabled: true }))).toBe("forbidden");
    expect(await errorCode(await post("tools/set-enabled", { name: "bash", enabled: false }))).toBe("forbidden");
    expect((await get("tools/describe?name=bash")).status).toBe(403);
    expect((await json<ToolInfo[]>(await get("tools"))).map((t) => t.name)).not.toContain("bash");
  });
});

describe("the agent's Core 4 tools", () => {
  it("every Core 4 tool is registered by factory_controls with a replay declaration", () => {
    const names = [
      "get_context", "set_compaction", "compact", "list_models", "refresh_models", "set_model", "set_thinking_level",
      "list_prompts", "get_prompt", "set_system_prompt", "create_custom_prompt", "update_custom_prompt", "delete_custom_prompt",
      "toggle_prompt", "append_runtime_prompt", "remove_runtime_prompt", "clear_runtime_prompts", "list_tools", "describe_tool",
      "set_tool_enabled", "list_layers", "set_layer_enabled", "get_ceiling", "list_runs", "get_run",
    ];
    const infos = new Map(factory.service.listTools().map((t) => [t.name, t]));
    for (const n of names) expect(infos.get(n), n).toMatchObject({ layer: "factory_controls" });
    const unsafe = names.filter((n) => infos.get(n)!.replay === "unsafe").sort();
    expect(unsafe).toEqual(["compact", "delete_custom_prompt"]);
  });

  it("append_runtime_prompt, create_custom_prompt and toggle_prompt through the model", async () => {
    expect((await probe("append_runtime_prompt", { text: "Say hello first." })).tools[0]!.status).toBe("done");
    expect((await factory.service.listPrompts()).runtime.map((p) => [p.text, p.by])).toEqual([["Say hello first.", "agent"]]);
    expect((await probe("create_custom_prompt", { name: "Style", text: "Short." })).tools[0]!.status).toBe("done");
    const [custom] = (await factory.service.listPrompts()).custom;
    expect(custom).toMatchObject({ title: "Style", by: "agent" });
    expect((await probe("toggle_prompt", { id: custom!.id, enabled: false })).tools[0]!.status).toBe("done");
    expect((await factory.service.listPrompts()).custom[0]!.enabled).toBe(false);
  });

  it("a bad call is an error result the model can read, not a crash", async () => {
    const { tools } = await probe("set_tool_enabled", { name: "nope", enabled: false });
    expect(tools[0]!.status).toBe("failed");
    expect(tools[0]!.output).toContain("no such tool: nope");
  });

  it("list_models, describe_tool and get_context answer", async () => {
    const models = (await probe("list_models", {})).tools[0]!;
    expect(JSON.parse(models.output ?? "{}")).toMatchObject({ total: 1, shown: 1, models: [{ provider: "faux", id: "faux-1" }] });
    const described = (await probe("describe_tool", { name: "read_page" })).tools[0]!;
    expect(JSON.parse(described.output ?? "{}")).toMatchObject({ name: "read_page", syntax: "both" });
    const ctxOut = (await probe("get_context", {})).tools[0]!;
    expect(JSON.parse(ctxOut.output ?? "{}")).toMatchObject({ contextWindow: 1_000_000 });
  });
});
