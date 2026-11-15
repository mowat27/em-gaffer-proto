/**
 * The one SSE stream (DESIGN 6, 11): `new EventSource("/api/events")` with listeners for `hello`, `snapshot`, `delta` and
 * `ping`. The browser resends `Last-Event-ID` on its own reconnects; when it gives up (the stream answered 503 or not as
 * an event stream) or the stream goes quiet past the ping interval, this opens a new one with `?lastEventId=`, so
 * the server replays the missed deltas or sends a fresh snapshot.
 */
import type { SseFrame } from "../../shared/types.ts";

export interface EventStreamHandlers {
  onFrame(frame: SseFrame): void;
  /** "connecting" while opening, "offline" after an error until the next frame arrives. */
  onConnection(state: "connecting" | "offline"): void;
  /** The id to resume from when a new stream is opened by hand. */
  lastId(): number | null;
}

/** The server pings every 15 s; a stream silent for this long is treated as dead. */
const SILENCE_MS = 45_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const FRAME_TYPES = ["hello", "snapshot", "delta", "ping"] as const;

export function connectEvents(handlers: EventStreamHandlers, url = "/api/events"): () => void {
  let source: EventSource | null = null;
  let stopped = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = Date.now();

  const onMessage = (e: MessageEvent<string>): void => {
    lastFrameAt = Date.now();
    retryMs = RETRY_MIN_MS;
    let frame: SseFrame;
    try {
      frame = JSON.parse(e.data) as SseFrame;
    } catch {
      return;
    }
    handlers.onFrame(frame);
  };

  const close = (): void => {
    if (!source) return;
    for (const type of FRAME_TYPES) source.removeEventListener(type, onMessage as EventListener);
    source.onerror = null;
    source.close();
    source = null;
  };

  const reopenLater = (): void => {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, retryMs);
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
  };

  const open = (): void => {
    if (stopped) return;
    close();
    const id = handlers.lastId();
    const target = id === null ? url : `${url}${url.includes("?") ? "&" : "?"}lastEventId=${id}`;
    handlers.onConnection("connecting");
    lastFrameAt = Date.now();
    const es = new EventSource(target);
    source = es;
    for (const type of FRAME_TYPES) es.addEventListener(type, onMessage as EventListener);
    es.onerror = () => {
      handlers.onConnection("offline");
      // CONNECTING: the browser retries by itself with Last-Event-ID. CLOSED: it gave up, so open a new one.
      if (es.readyState === EventSource.CLOSED) {
        close();
        reopenLater();
      }
    };
  };

  watchdog = setInterval(() => {
    if (stopped || !source) return;
    if (Date.now() - lastFrameAt > SILENCE_MS) {
      handlers.onConnection("offline");
      close();
      reopenLater();
    }
  }, 5_000);

  open();

  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (watchdog !== null) clearInterval(watchdog);
    close();
  };
}
