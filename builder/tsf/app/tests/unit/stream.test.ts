import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatItem, ChatView, SseFrame } from "../../src/shared/types.ts";
import { createTestServer, type TestServer } from "../helpers/factory.ts";
import { watchSse } from "../helpers/sse.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

/** The minimal reducer of the web client for chat: a snapshot replaces, deltas apply (DESIGN 11, state). */
function reduce(chat: ChatView | undefined, frame: SseFrame): ChatView | undefined {
  if (frame.type === "snapshot") return frame.snapshot.chat;
  if (frame.type !== "delta" || !chat) return chat;
  const d = frame.delta;
  switch (d.type) {
    case "chat.append": {
      const have = new Set(chat.items.map((i) => i.id));
      return { ...chat, items: [...chat.items, ...d.items.filter((i) => !have.has(i.id))] };
    }
    case "chat.update": {
      const byId = new Map<string, ChatItem>(d.items.map((i) => [i.id, i]));
      return { ...chat, items: chat.items.map((i) => byId.get(i.id) ?? i) };
    }
    case "chat.live":
      return { ...chat, live: d.live };
    case "chat.meta":
      return { ...chat, meta: d.meta };
    case "chat.reset":
      return d.chat;
    default:
      return chat;
  }
}

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(async () => {
  await server.close();
  await cleanupTmp();
});

async function getChat(): Promise<ChatView> {
  return (await (await fetch(`${server.url}/api/chat`)).json()) as ChatView;
}

async function send(text: string, requestId: string): Promise<void> {
  const res = await fetch(`${server.url}/api/chat/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, requestId }),
  });
  expect(res.status).toBe(202);
}

/** Poll until the reduced chat equals GET /api/chat (the stream is eventually consistent). */
async function settle(current: () => ChatView | undefined, ms = 15_000): Promise<{ reduced: unknown; served: unknown }> {
  const deadline = Date.now() + ms;
  let reduced: unknown;
  let served: unknown;
  for (;;) {
    served = await getChat();
    reduced = current();
    if (JSON.stringify(reduced) === JSON.stringify(served)) return { reduced, served };
    if (Date.now() > deadline) return { reduced, served };
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("GET /api/events", () => {
  it("starts with hello then a snapshot whose chat equals GET /api/chat", async () => {
    const watch = await watchSse(`${server.url}/api/events`);
    try {
      await watch.waitFor((f) => f.some((x) => x.type === "snapshot"));
      expect(watch.frames[0]).toMatchObject({ type: "hello", apiVersion: 1, resumed: false });
      const snap = watch.frames[1]!;
      expect(snap.type).toBe("snapshot");
      if (snap.type === "snapshot") {
        expect(snap.id).toBe(server.hub.headId);
        expect(snap.snapshot.chat).toEqual(await getChat());
        expect(snap.snapshot.bootId).toBe((watch.frames[0] as { bootId: number }).bootId);
        expect(snap.snapshot.themeCss.length).toBeGreaterThan(0);
      }
    } finally {
      watch.close();
    }
  });

  it("drops a stream when the client disconnects, without touching the others", async () => {
    const a = await watchSse(`${server.url}/api/events`);
    const b = await watchSse(`${server.url}/api/events`);
    await a.waitFor((f) => f.some((x) => x.type === "snapshot"));
    await b.waitFor((f) => f.some((x) => x.type === "snapshot"));
    expect(server.hub.openCount).toBe(2);
    a.close();
    const deadline = Date.now() + 5000;
    while (server.hub.openCount !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(server.hub.openCount).toBe(1);
    b.close();
  });

  it("reduces hello, snapshot and delta frames to the chat that GET /api/chat serves, after ping -> pong", async () => {
    let chat: ChatView | undefined;
    const watch = await watchSse(`${server.url}/api/events`, { onFrame: (f) => (chat = reduce(chat, f)) });
    try {
      await watch.waitFor((f) => f.some((x) => x.type === "snapshot"));
      await send("ping", "stream-1");
      await watch.waitFor(() => !!chat?.items.some((i) => i.kind === "assistant" && i.text === "pong") && chat.live.busy === false);

      const { reduced, served } = await settle(() => chat);
      expect(reduced).toEqual(served);
      expect((served as ChatView).items.map((i) => i.kind)).toEqual(["user", "assistant"]);

      const ids = watch.frames.flatMap((f) => (f.type === "delta" ? [f.id] : []));
      expect(ids.length).toBeGreaterThan(0);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      watch.close();
    }
  });

  it("resumes from the last delta id with the missed deltas and no snapshot", async () => {
    let chat: ChatView | undefined;
    const first = await watchSse(`${server.url}/api/events`, { onFrame: (f) => (chat = reduce(chat, f)) });
    await first.waitFor((f) => f.some((x) => x.type === "snapshot"));
    const snapshotId = (first.frames.find((f) => f.type === "snapshot") as { id: number }).id;
    first.close();

    // While no client is connected the chat moves on.
    await send("ping", "stream-2");
    const deadline = Date.now() + 15_000;
    while (server.hub.headId === snapshotId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(server.hub.headId).toBeGreaterThan(snapshotId);

    const second = await watchSse(`${server.url}/api/events`, {
      lastEventId: snapshotId,
      onFrame: (f) => (chat = reduce(chat, f)),
    });
    try {
      await second.waitFor((f) => f.length >= 2);
      expect(second.frames[0]).toMatchObject({ type: "hello", resumed: true });
      expect(second.frames.some((f) => f.type === "snapshot")).toBe(false);
      const first1 = second.frames[1]!;
      expect(first1.type === "delta" && first1.id).toBe(snapshotId + 1);
      const { reduced, served } = await settle(() => chat);
      expect(reduced).toEqual(served);
    } finally {
      second.close();
    }
  });
});
