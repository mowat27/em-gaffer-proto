import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatView } from "../../src/shared/types.ts";
import { createTestServer, type TestServer } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(async () => {
  await server.close();
  await cleanupTmp();
});

async function post(path: string, body: unknown, raw = false): Promise<Response> {
  return await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function chat(): Promise<ChatView> {
  return (await (await fetch(`${server.url}/api/chat`)).json()) as ChatView;
}

async function waitFor(predicate: (v: ChatView) => boolean, ms = 15_000): Promise<ChatView> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await chat();
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; chat has ${v.items.length} items, busy=${v.live.busy}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("POST /api/chat/send", () => {
  it("answers 202 with the submission, and the turn reaches GET /api/chat", async () => {
    const res = await post("/api/chat/send", { text: "ping", requestId: "req-1" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { submissionId: number; requestId: string; status: string };
    expect(typeof body.submissionId).toBe("number");
    expect(body.requestId).toBe("req-1");
    expect(["queued", "placed", "done", "unanswered"]).toContain(body.status);

    const view = await waitFor((v) => v.items.some((i) => i.kind === "assistant" && i.text === "pong") && !v.live.busy);
    expect(view.items[0]).toMatchObject({ kind: "user", text: "ping" });
  });

  it("returns the same submission for the same requestId and submits once", async () => {
    const a = (await (await post("/api/chat/send", { text: "ping", requestId: "dup" })).json()) as { submissionId: number };
    const bRes = await post("/api/chat/send", { text: "ping", requestId: "dup" });
    expect(bRes.status).toBe(202);
    const b = (await bRes.json()) as { submissionId: number };
    expect(b.submissionId).toBe(a.submissionId);
    const view = await waitFor((v) => v.items.some((i) => i.kind === "assistant") && !v.live.busy);
    await new Promise((r) => setTimeout(r, 200));
    const final = await chat();
    expect(final.items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(view.items.some((i) => i.kind === "assistant")).toBe(true);
  });

  it("accepts mode steer and followUp", async () => {
    expect((await post("/api/chat/send", { text: "ping", requestId: "m1", mode: "followUp" })).status).toBe(202);
    expect((await post("/api/chat/send", { text: "ping", requestId: "m2", mode: "steer" })).status).toBe(202);
  });

  it.each([
    ["empty text", { text: "", requestId: "r" }],
    ["whitespace text", { text: "   ", requestId: "r" }],
    ["missing text", { requestId: "r" }],
    ["non-string text", { text: 5, requestId: "r" }],
    ["text over 100 000 chars", { text: "x".repeat(100_001), requestId: "r" }],
    ["missing requestId", { text: "ping" }],
    ["empty requestId", { text: "ping", requestId: "" }],
    ["requestId over 128 chars", { text: "ping", requestId: "r".repeat(129) }],
    ["bad mode", { text: "ping", requestId: "r", mode: "reject" }],
  ])("answers 400 invalid for %s", async (_name, body) => {
    const res = await post("/api/chat/send", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid" } });
  });

  it("accepts a requestId of exactly 128 characters", async () => {
    expect((await post("/api/chat/send", { text: "ping", requestId: "r".repeat(128) })).status).toBe(202);
  });

  it("answers 400 for a body that is not JSON or not an object", async () => {
    expect((await post("/api/chat/send", "{nope", true)).status).toBe(400);
    expect((await post("/api/chat/send", "", true)).status).toBe(400);
    expect((await post("/api/chat/send", [1, 2])).status).toBe(400);
  });

  it("answers 413 too_large for a 2 MB body", async () => {
    const res = await post("/api/chat/send", { text: "x".repeat(2 * 1024 * 1024), requestId: "big" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "too_large" } });
  });
});

describe("other chat and status routes", () => {
  it("GET /api/status, /api/settings and /api/models", async () => {
    const status = await (await fetch(`${server.url}/api/status`)).json();
    expect(status).toMatchObject({ pid: process.pid, modelSource: "faux" });
    // An in-process factory does not listen itself, so its url is the configured one; only its shape is fixed.
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof status.bootId).toBe("number");
    const settings = await fetch(`${server.url}/api/settings`);
    expect(settings.status).toBe(200);
    expect(await settings.json()).toHaveProperty("thinkingLevel");
    const models = (await (await fetch(`${server.url}/api/models`)).json()) as { provider: string }[];
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.provider).toBe("faux");
  });

  it("POST /api/chat/stop answers { stopped } and works when idle", async () => {
    const res = await post("/api/chat/stop", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false });
  });

  it("GET /api/chat/earlier validates its query", async () => {
    expect((await fetch(`${server.url}/api/chat/earlier`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/chat/earlier?before=abc`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/chat/earlier?before=0`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/chat/earlier?before=5&limit=500`)).status).toBe(400);
    const ok = await fetch(`${server.url}/api/chat/earlier?before=5&limit=10`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ items: expect.any(Array), hasEarlier: expect.any(Boolean) });
  });
});

describe("routing", () => {
  it("answers 404 JSON for an unknown /api route, GET or POST", async () => {
    for (const init of [{ method: "GET" }, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }]) {
      const res = await fetch(`${server.url}/api/nope`, init);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("answers non-API GETs with the 503 page when no web app is served", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("web app");
  });

  it("answers the events route with an event stream", async () => {
    const abort = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    abort.abort();
  });
});
