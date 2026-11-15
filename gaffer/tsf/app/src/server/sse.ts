/**
 * SseHub (DESIGN 6, D9): one stream, `GET /api/events`. Frames: `hello`, `snapshot`, `delta`, `ping`.
 *
 * Ids: one process-wide counter that starts at `bootId * 1000` and is incremented per delta, so a later process always
 * issues larger ids and a stale Last-Event-ID can never match this process's ring. `snapshot` carries `id: <head>`,
 * `delta` its own id; `hello` and `ping` carry none. The hub keeps a ring of the newest deltas; a reconnect whose
 * Last-Event-ID the ring still covers gets exactly the missed deltas, anything else gets a fresh snapshot.
 */
import { API_VERSION, type Delta, type Snapshot, type SseFrame } from "../shared/types.ts";
import type { Logger } from "../core/log.ts";

export interface SseHubOptions {
  bootId: number;
  /** Synchronous, so it matches `headId` read in the same tick. */
  snapshot: () => Snapshot;
  log: Logger;
  /** Default 15 000. */
  pingMs?: number;
  /** Deltas kept for resume. Default 500. */
  ringSize?: number;
  /** Bytes a stream may queue before it is closed. Default 2 000 000. */
  highWaterMark?: number;
}

interface Client {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly ping: ReturnType<typeof setInterval>;
  readonly detach: () => void;
  closed: boolean;
}

interface RingEntry {
  readonly id: number;
  readonly text: string;
}

const encoder = new TextEncoder();

function wire(frame: SseFrame): string {
  const id = frame.type === "snapshot" || frame.type === "delta" ? `id: ${frame.id}\n` : "";
  return `${id}event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

export class SseHub {
  private readonly bootId: number;
  private readonly snapshotFn: () => Snapshot;
  private readonly log: Logger;
  private readonly pingMs: number;
  private readonly ringSize: number;
  private readonly highWaterMark: number;
  private readonly clients = new Set<Client>();
  private ring: RingEntry[] = [];
  private head: number;
  private closing = false;

  constructor(opts: SseHubOptions) {
    this.bootId = opts.bootId;
    this.snapshotFn = opts.snapshot;
    this.log = opts.log;
    this.pingMs = opts.pingMs ?? 15_000;
    this.ringSize = opts.ringSize ?? 500;
    this.highWaterMark = opts.highWaterMark ?? 2_000_000;
    this.head = opts.bootId * 1000;
  }

  /** The id of the newest delta (the base `bootId * 1000` before any). */
  get headId(): number {
    return this.head;
  }

  get openCount(): number {
    return this.clients.size;
  }

  /** Assign the next id, keep the delta in the ring and write it to every open stream. Never throws. */
  publish(delta: Delta): number {
    const id = this.head + 1;
    let text: string;
    try {
      text = wire({ type: "delta", id, delta });
    } catch (err) {
      this.log.error("sse.serialise_failed", { type: delta.type, error: err });
      return this.head;
    }
    this.head = id;
    this.ring.push({ id, text });
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    const bytes = encoder.encode(text);
    for (const client of [...this.clients]) this.write(client, bytes, true);
    return id;
  }

  /**
   * Open a stream. `lastEventId` is the browser's Last-Event-ID (or `?lastEventId=`). The snapshot, when one is sent, is
   * taken in the same tick as `headId`, so snapshot plus later deltas is exact.
   */
  connect(signal: AbortSignal, lastEventId: number | undefined): Response {
    if (this.closing) {
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "the factory is shutting down" } }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const headers = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    if (signal.aborted) return new Response(null, { status: 200, headers });

    let client: Client | undefined;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const ping = setInterval(() => {
            if (client) {
              this.write(client, encoder.encode(wire({ type: "ping", serverTime: Date.now() })), false);
            }
          }, this.pingMs);
          ping.unref?.();
          const onAbort = (): void => {
            if (client) this.drop(client);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          client = { controller, ping, detach: () => signal.removeEventListener("abort", onAbort), closed: false };
          this.clients.add(client);

          const replay = this.replayFrom(lastEventId);
          try {
            controller.enqueue(encoder.encode("retry: 2000\n\n"));
            controller.enqueue(
              encoder.encode(
                wire({
                  type: "hello",
                  apiVersion: API_VERSION,
                  bootId: this.bootId,
                  serverTime: Date.now(),
                  resumed: replay !== undefined,
                }),
              ),
            );
            if (replay) {
              for (const entry of replay) controller.enqueue(encoder.encode(entry.text));
            } else {
              const id = this.head;
              controller.enqueue(
                encoder.encode(wire({ type: "snapshot", id, snapshot: this.snapshotFn() })),
              );
            }
          } catch (err) {
            this.log.error("sse.connect_failed", { error: err });
            this.drop(client);
          }
        },
        cancel: () => {
          if (client) this.drop(client);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: this.highWaterMark }),
    );
    this.log.debug("sse.open", { open: this.clients.size, lastEventId });
    return new Response(stream, { status: 200, headers });
  }

  /** End every open stream and refuse new ones (shutdown). */
  closeAll(): void {
    this.closing = true;
    for (const client of [...this.clients]) this.drop(client);
  }

  /** The deltas to replay for `lastEventId`, or undefined when a snapshot is needed. */
  private replayFrom(lastEventId: number | undefined): RingEntry[] | undefined {
    if (lastEventId === undefined || !Number.isSafeInteger(lastEventId)) return undefined;
    if (lastEventId === this.head) return [];
    if (lastEventId > this.head) return undefined;
    const first = this.ring[0];
    if (!first || first.id > lastEventId + 1) return undefined;
    return this.ring.filter((entry) => entry.id > lastEventId);
  }

  /** Write to one stream; a stream whose queue is full (`desiredSize <= 0`) is closed and reconnects. */
  private write(client: Client, bytes: Uint8Array, checkPressure: boolean): void {
    if (client.closed) return;
    try {
      client.controller.enqueue(bytes);
      const room = client.controller.desiredSize;
      if (checkPressure && room !== null && room <= 0) {
        this.log.warn("sse.backpressure", { open: this.clients.size });
        this.drop(client);
      }
    } catch {
      this.drop(client);
    }
  }

  private drop(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    clearInterval(client.ping);
    client.detach();
    this.clients.delete(client);
    try {
      client.controller.close();
    } catch {
      // Already closed or cancelled.
    }
    this.log.debug("sse.close", { open: this.clients.size });
  }
}
