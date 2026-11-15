import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { SseHub, type SseHubOptions } from "../../src/server/sse.ts";
import type { ChatDelta, Snapshot, SseFrame } from "../../src/shared/types.ts";
import { parseSseText, readSseResponse } from "../helpers/sse.ts";

const BOOT = 1_700_000_000_000;
const BASE = BOOT * 1000;

const live = (n: number): ChatDelta => ({
  type: "chat.live",
  live: { busy: n % 2 === 1, phase: "idle", tools: [], compactions: [], inbox: [], turns: n },
});

const fakeSnapshot = (): Snapshot => ({ apiVersion: 1, bootId: BOOT, serverTime: 1 }) as unknown as Snapshot;

const hubs: SseHub[] = [];
function makeHub(opts: Partial<SseHubOptions> = {}): SseHub {
  const hub = new SseHub({ bootId: BOOT, snapshot: fakeSnapshot, log: silentLogger, ...opts });
  hubs.push(hub);
  return hub;
}

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.closeAll();
});

/** Connect and read until `until`, then abort the connection. */
async function read(
  hub: SseHub,
  lastEventId: number | undefined,
  until: (f: SseFrame, all: SseFrame[]) => boolean,
  timeoutMs = 2000,
): Promise<SseFrame[]> {
  const abort = new AbortController();
  const res = hub.connect(abort.signal, lastEventId);
  try {
    return await readSseResponse(res, { until, timeoutMs }, abort);
  } finally {
    abort.abort();
  }
}

const types = (frames: SseFrame[]): string[] => frames.map((f) => f.type);

describe("SseHub connect", () => {
  it("sends retry, hello, then one snapshot stamped with the head id", async () => {
    const hub = makeHub();
    const abort = new AbortController();
    const res = hub.connect(abort.signal, undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("event: snapshot\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    abort.abort();
    expect(text.startsWith("retry: 2000\n\n")).toBe(true);
    const { blocks } = parseSseText(text.slice("retry: 2000\n\n".length));
    expect(blocks.map((b) => b.event)).toEqual(["hello", "snapshot"]);
    // hello and ping carry no id; snapshot carries the head.
    expect(blocks[0]!.id).toBeUndefined();
    expect(blocks[1]!.id).toBe(BASE);
    const hello = blocks[0]!.frame as Extract<SseFrame, { type: "hello" }>;
    expect(hello).toMatchObject({ type: "hello", apiVersion: 1, bootId: BOOT, resumed: false });
    expect(typeof hello.serverTime).toBe("number");
  });

  it("takes the snapshot at the current head", async () => {
    const hub = makeHub();
    hub.publish(live(1));
    hub.publish(live(2));
    const frames = await read(hub, undefined, (f) => f.type === "snapshot");
    expect(frames.at(-1)).toMatchObject({ type: "snapshot", id: BASE + 2 });
  });

  it("answers 503 while closing and ends open streams on closeAll", async () => {
    const hub = makeHub();
    const abort = new AbortController();
    const res = hub.connect(abort.signal, undefined);
    expect(hub.openCount).toBe(1);
    const done = readSseResponse(res, { timeoutMs: 2000 });
    hub.closeAll();
    const frames = await done;
    expect(types(frames)).toEqual(["hello", "snapshot"]);
    expect(hub.openCount).toBe(0);
    const refused = hub.connect(new AbortController().signal, undefined);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it("removes a stream when the client aborts", async () => {
    const hub = makeHub();
    const abort = new AbortController();
    hub.connect(abort.signal, undefined);
    expect(hub.openCount).toBe(1);
    abort.abort();
    expect(hub.openCount).toBe(0);
  });
});

describe("SseHub ids and deltas", () => {
  it("starts at bootId * 1000 and increments by one per delta", () => {
    const hub = makeHub();
    expect(hub.headId).toBe(BASE);
    expect(hub.publish(live(1))).toBe(BASE + 1);
    expect(hub.publish(live(2))).toBe(BASE + 2);
    expect(hub.headId).toBe(BASE + 2);
  });

  it("writes live deltas to an open stream with their ids", async () => {
    const hub = makeHub();
    const abort = new AbortController();
    const res = hub.connect(abort.signal, undefined);
    const collected = readSseResponse(res, { until: (f) => f.type === "delta" && f.id === BASE + 2, timeoutMs: 2000 }, abort);
    hub.publish(live(1));
    hub.publish(live(2));
    const frames = await collected;
    expect(types(frames)).toEqual(["hello", "snapshot", "delta", "delta"]);
    const ids = frames.filter((f) => f.type === "delta").map((f) => (f as { id: number }).id);
    expect(ids).toEqual([BASE + 1, BASE + 2]);
  });
});

describe("SseHub resume", () => {
  it("replays exactly the missing deltas and no snapshot", async () => {
    const hub = makeHub();
    for (let i = 1; i <= 5; i++) hub.publish(live(i));
    const frames = await read(hub, BASE + 2, (f) => f.type === "delta" && f.id === BASE + 5);
    expect(types(frames)).toEqual(["hello", "delta", "delta", "delta"]);
    expect(frames[0]).toMatchObject({ resumed: true });
    expect(frames.slice(1).map((f) => (f as { id: number }).id)).toEqual([BASE + 3, BASE + 4, BASE + 5]);
  });

  it("resumes with nothing to replay when the id is the head, then streams live", async () => {
    const hub = makeHub();
    hub.publish(live(1));
    const abort = new AbortController();
    const res = hub.connect(abort.signal, BASE + 1);
    const collected = readSseResponse(res, { until: (f) => f.type === "delta", timeoutMs: 2000 }, abort);
    hub.publish(live(2));
    const frames = await collected;
    expect(types(frames)).toEqual(["hello", "delta"]);
    expect(frames[0]).toMatchObject({ resumed: true });
    expect(frames[1]).toMatchObject({ id: BASE + 2 });
  });

  it("sends a snapshot when the id fell out of the ring", async () => {
    const hub = makeHub({ ringSize: 3 });
    for (let i = 1; i <= 6; i++) hub.publish(live(i));
    // The ring holds BASE+4..BASE+6; resuming after BASE+1 would need BASE+2.
    const frames = await read(hub, BASE + 1, (f) => f.type === "snapshot");
    expect(types(frames)).toEqual(["hello", "snapshot"]);
    expect(frames[0]).toMatchObject({ resumed: false });
    expect(frames[1]).toMatchObject({ id: BASE + 6 });
    // The oldest id the ring still covers resumes.
    const ok = await read(hub, BASE + 3, (f) => f.type === "delta" && f.id === BASE + 6);
    expect(types(ok)).toEqual(["hello", "delta", "delta", "delta"]);
  });

  it("sends a snapshot for an id from another boot or from the future", async () => {
    const hub = makeHub();
    hub.publish(live(1));
    const older = await read(hub, (BOOT - 5000) * 1000 + 3, (f) => f.type === "snapshot");
    expect(older[0]).toMatchObject({ resumed: false });
    const future = await read(hub, BASE + 99, (f) => f.type === "snapshot");
    expect(future[0]).toMatchObject({ resumed: false });
    const none = await read(hub, undefined, (f) => f.type === "snapshot");
    expect(none[0]).toMatchObject({ resumed: false });
  });
});

describe("SseHub ping and backpressure", () => {
  it("sends `event: ping` with a serverTime and no id", async () => {
    const hub = makeHub({ pingMs: 20 });
    const abort = new AbortController();
    const res = hub.connect(abort.signal, undefined);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: ping\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    abort.abort();
    const { blocks } = parseSseText(text.slice("retry: 2000\n\n".length));
    const ping = blocks.find((b) => b.event === "ping")!;
    expect(ping.id).toBeUndefined();
    expect(ping.frame).toMatchObject({ type: "ping" });
    expect(typeof (ping.frame as { serverTime: number }).serverTime).toBe("number");
    expect(text).toContain('event: ping\ndata: {"type":"ping","serverTime":');
  });

  it("closes a stream whose queue is full and keeps serving the others", async () => {
    const hub = makeHub({ highWaterMark: 4000 });
    const slow = new AbortController();
    const slowRes = hub.connect(slow.signal, undefined); // never read
    const fast = new AbortController();
    const fastRes = hub.connect(fast.signal, undefined);
    expect(hub.openCount).toBe(2);
    const fastFrames = readSseResponse(fastRes, { until: (f) => f.type === "delta" && f.id === BASE + 20, timeoutMs: 3000 }, fast);

    const big = "x".repeat(900);
    for (let i = 1; i <= 20; i++) {
      hub.publish({ type: "chat.live", live: { busy: true, phase: "streaming", tools: [], compactions: [], inbox: [], streaming: { text: big, toolCalls: [] } } });
      // Let the fast reader drain between publishes.
      await new Promise((r) => setTimeout(r, 5));
      // By now the unread stream is over its limit and gone; the reading one stays.
      if (i === 15) expect(hub.openCount).toBe(1);
    }
    const frames = await fastFrames;
    expect(frames.filter((f) => f.type === "delta")).toHaveLength(20);
    // The dropped stream ends after what it had queued.
    const dropped = await readSseResponse(slowRes, { timeoutMs: 2000 });
    expect(dropped.length).toBeGreaterThanOrEqual(2);
    expect(dropped.length).toBeLessThan(22);
  });
});
