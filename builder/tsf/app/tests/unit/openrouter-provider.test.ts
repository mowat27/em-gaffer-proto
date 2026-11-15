import { createModels, type Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCacheStore } from "../../src/agent/models.ts";
import { silentLogger } from "../../src/core/log.ts";
import { createOpenRouterLayer, OPENROUTER_MODELS_URL } from "../../src/layers/provider_openrouter/provider.ts";
import type { AppEvent } from "../../src/shared/events.ts";

function memoryCache(): ModelCacheStore & { rows: Map<string, { fetchedAt: number; body: string }> } {
  const rows = new Map<string, { fetchedAt: number; body: string }>();
  return { rows, get: (p) => rows.get(p), put: (p, body, fetchedAt) => void rows.set(p, { body, fetchedAt }) };
}

const LIVE = {
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      context_length: 777_000,
      top_provider: { context_length: 777_000, max_completion_tokens: 33_000 },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["reasoning", "tools"],
    },
    {
      id: "brandnew/model-x",
      name: "Brand New X",
      context_length: 64_000,
      top_provider: { max_completion_tokens: 8_000 },
      pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["reasoning"],
    },
    {
      id: "someone/image-only",
      name: "Image only",
      context_length: 1_000,
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("provider_openrouter live list (D2)", () => {
  it("with no cache the snapshot is used", () => {
    const layer = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger });
    const models = layer.models();
    expect(models.length).toBe(openrouterProvider().getModels().length);
    expect(models.every((m) => m.source === "snapshot")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the live list merges over the snapshot, caches the body and publishes models.changed", async () => {
    process.env.OPENROUTER_API_KEY = "agent-vault";
    fetchMock.mockResolvedValue(ok(LIVE));
    const cache = memoryCache();
    const events: AppEvent[] = [];
    const layer = createOpenRouterLayer({ cache, log: silentLogger, bus: { publish: (e) => void events.push(e), subscribe: () => () => {} } });
    await layer.refresh(new AbortController().signal);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_MODELS_URL);
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer agent-vault" });
    expect((init as RequestInit).redirect).toBe("error");

    const ids = layer.provider.getModels().map((m) => m.id);
    expect(ids).toEqual(["anthropic/claude-sonnet-5.5", "brandnew/model-x"]);

    const snap = openrouterProvider().getModels().find((m) => m.id === "anthropic/claude-sonnet-5.5")!;
    const sonnet = layer.provider.getModels()[0]!;
    expect(sonnet.api).toBe(snap.api);
    expect(sonnet.baseUrl).toBe(snap.baseUrl);
    expect(sonnet.thinkingLevelMap).toEqual(snap.thinkingLevelMap);
    expect(sonnet.contextWindow).toBe(777_000);
    expect(sonnet.maxTokens).toBe(33_000);
    expect(sonnet.cost.input).toBeCloseTo(3);
    expect(sonnet.cost.output).toBeCloseTo(15);

    expect(cache.rows.get("openrouter")?.body).toBe(JSON.stringify(LIVE));
    expect(events).toEqual([{ type: "models.changed", count: 2, fetchedAt: expect.any(Number) }]);
    expect(layer.models().every((m) => m.source === "live")).toBe(true);
  });

  it("a model unknown to the snapshot gets a template api and baseUrl", async () => {
    fetchMock.mockResolvedValue(ok(LIVE));
    const layer = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger });
    await layer.refresh(new AbortController().signal);
    const x = layer.provider.getModels().find((m) => m.id === "brandnew/model-x")!;
    const template = openrouterProvider().getModels().find((m) => m.api === "openai-completions")!;
    expect(x.api).toBe("openai-completions");
    expect(x.baseUrl).toBe(template.baseUrl);
    expect(x.provider).toBe("openrouter");
    expect(x.reasoning).toBe(true);
    expect(x.contextWindow).toBe(64_000);
    expect(x.maxTokens).toBe(8_000);
  });

  it("a failed fetch keeps the cached list", async () => {
    const cache = memoryCache();
    cache.put("openrouter", JSON.stringify(LIVE), 1);
    fetchMock.mockRejectedValue(new Error("offline"));
    const layer = createOpenRouterLayer({ cache, log: silentLogger });
    await layer.refresh(new AbortController().signal);
    expect(layer.provider.getModels().map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5", "brandnew/model-x"]);
    expect(layer.models()[0]!.source).toBe("live");
  });

  it("no cache and a failed fetch keep the snapshot", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const layer = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger });
    await expect(layer.refresh(new AbortController().signal)).resolves.toBeUndefined();
    expect(layer.provider.getModels().length).toBe(openrouterProvider().getModels().length);
  });

  it("no key still fetches, without an Authorization header", async () => {
    delete process.env.OPENROUTER_API_KEY;
    fetchMock.mockResolvedValue(ok(LIVE));
    const layer = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger });
    await layer.refresh(new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({});
  });

  it("optional members are delegated only when the base defines them", () => {
    const base = openrouterProvider();
    expect("filterModels" in base && base.filterModels === undefined).toBe(true);
    const layer = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger });
    expect("filterModels" in layer.provider).toBe(false);
    expect("filterAllModels" in layer.provider).toBe(false);
    expect(layer.provider.id).toBe("openrouter");

    const filterModels = vi.fn((models: readonly unknown[]) => models.slice(0, 1));
    const withFilter = { ...base, filterModels } as unknown as Provider<"anthropic-messages" | "openai-completions">;
    const wrapped = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger, base: withFilter });
    expect(typeof wrapped.provider.filterModels).toBe("function");
    wrapped.provider.filterModels!(wrapped.provider.getModels(), undefined);
    expect(filterModels).toHaveBeenCalledTimes(1);
  });

  it("Models.getAvailable() does not throw", async () => {
    process.env.OPENROUTER_API_KEY = "agent-vault";
    const models = createModels();
    const layer = createOpenRouterLayer({ cache: memoryCache(), log: silentLogger });
    models.setProvider(layer.provider);
    const available = await models.getAvailable("openrouter");
    expect(available.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
