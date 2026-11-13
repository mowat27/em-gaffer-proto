/**
 * P7 jev through the HTTP app, the Service and the agent's own `jev_judge` tool on the faux model. The network is never
 * used: `fetch` is stubbed globally (jev calls global fetch) and the key is the vault placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatItem } from "../../src/shared/types.ts";
import type { Factory } from "../../src/server/main.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

let factory: Factory & { root: string };
let calls: { url: string; init: RequestInit }[];
let reply: () => Response;
const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

beforeEach(async () => {
  calls = [];
  reply = () => answer({ model: "jev-test", answers: { q: { type: "noul", noul: 0.75 } } });
  vi.stubEnv("TYPESAFE_API_KEY", "agent-vault");
  vi.stubEnv("TSF_JEV_PROVIDER", "");
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  });
  factory = await createTestFactory();
});

afterEach(async () => {
  await factory.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await cleanupTmp();
});

const post = (body: unknown) =>
  factory.app.request("/api/jev/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const NOUL = { kind: "noul", question: "Is this polite?", state: "Thank you very much." };

describe("POST /api/jev/judge", () => {
  it("returns the verdict and sends the key only in Authorization", async () => {
    const res = await post(NOUL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "noul", probability: 0.75, model: "jev-test" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer agent-vault");
    expect(String(calls[0]!.init.body)).not.toContain("agent-vault");
  });

  it("maps errors: invalid 400, no key 503, upstream 502", async () => {
    expect((await post({ kind: "noul" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    reply = () => answer({ detail: "nope" }, 401);
    const up = await post(NOUL);
    expect(up.status).toBe(502);
    expect(((await up.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "upstream" });
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const n = calls.length;
    const none = await post(NOUL);
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual({ error: { code: "unavailable", message: "TYPESAFE_API_KEY is not set" } });
    expect(calls).toHaveLength(n);
  });

  it("TSF_JEV_PROVIDER=faux answers without fetch or key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("TSF_JEV_PROVIDER", "faux");
    const res = await post({ kind: "score", question: "q", state: "s", levels: ["a", "b", "c"] });
    expect(await res.json()).toMatchObject({ kind: "score", model: "jev-faux" });
    expect(calls).toHaveLength(0);
  });
});

describe("the jev_judge tool", () => {
  type ToolItem = Extract<ChatItem, { kind: "tool" }>;
  const until = async <T,>(fn: () => T | undefined, ms = 15_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("is registered safe by factory_harness and the verdict reaches the chat", async () => {
    expect(factory.service.listTools().find((t) => t.name === "jev_judge")).toMatchObject({ layer: "factory_harness", replay: "safe" });
    await factory.service.sendMessage({ text: `probe jev_judge ${JSON.stringify(NOUL)}`, requestId: "jev-1" }, { by: "ui" });
    const item = await until(() => {
      const v = factory.service.chatView();
      return !v.live.busy && v.items.some((i) => i.kind === "assistant" && i.text.includes("probe done"))
        ? v.items.filter((i): i is ToolItem => i.kind === "tool").at(-1)
        : undefined;
    });
    expect(item.status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(item)).toContain("0.75");
  });
});
