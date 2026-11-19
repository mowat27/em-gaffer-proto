import type { ServerEvent } from '../shared/types.ts';

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub for ServerEvents plus the SSE response factory. */
export class EventHub {
  #listeners = new Set<Listener>();
  /** Increments on every broadcast; sent in `hello` so clients can detect a restart. */
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  broadcast(event: ServerEvent): void {
    this.#revision++;
    for (const fn of [...this.#listeners]) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must not stop the others
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** SSE response: `event: message`, `data: <json>`; comment ping every `pingMs` (default 15 s). */
  sse(signal?: AbortSignal, pingMs = 15_000): Response {
    const enc = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (text: string) => {
          try {
            controller.enqueue(enc.encode(text));
          } catch {
            cleanup();
          }
        };
        const send = (event: ServerEvent) => write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
        const unsub = this.subscribe(send);
        const ping = setInterval(() => write(': ping\n\n'), pingMs);
        ping.unref?.();
        cleanup = () => {
          unsub();
          clearInterval(ping);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        signal?.addEventListener('abort', cleanup, { once: true });
        write('retry: 2000\n\n');
        send({ type: 'hello', revision: this.#revision });
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }
}
