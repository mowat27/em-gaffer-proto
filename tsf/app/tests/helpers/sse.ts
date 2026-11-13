import type { SseFrame } from "../../src/shared/types.ts";

/** One parsed SSE block: the event name, the `id:` line, and the JSON frame from `data:`. */
export interface ParsedBlock {
  event: string | undefined;
  id: number | undefined;
  frame: SseFrame | undefined;
}

/** Parse complete SSE blocks (separated by a blank line) from `text`; returns the blocks and the unparsed rest. */
export function parseSseText(text: string): { blocks: ParsedBlock[]; rest: string } {
  const blocks: ParsedBlock[] = [];
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    let event: string | undefined;
    let id: number | undefined;
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("id:")) id = Number(line.slice(3).trim());
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    blocks.push({ event, id, frame: JSON.parse(data.join("\n")) as SseFrame });
  }
  return { blocks, rest };
}

export interface ReadSseOptions {
  lastEventId?: number;
  /** Stop (and resolve) at the first frame this returns true for. */
  until?: (frame: SseFrame, all: SseFrame[]) => boolean;
  /** Resolve with what arrived so far after this long. Default 5000. */
  timeoutMs?: number;
}

/** Read frames from an SSE `Response` body until `until`, the end of the stream, or the timeout. */
export async function readSseResponse(res: Response, opts: ReadSseOptions = {}, abort?: AbortController): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  if (!res.body) return frames;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
    abort?.abort();
  }, opts.timeoutMs ?? 5000);
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseText(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) {
        if (!block.frame) continue;
        frames.push(block.frame);
        if (opts.until?.(block.frame, frames)) {
          abort?.abort();
          await reader.cancel().catch(() => undefined);
          return frames;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  void timedOut;
  return frames;
}

/** `fetch(url)` an SSE endpoint (with `?lastEventId=` when given) and collect its frames (see ReadSseOptions). */
export async function readSse(url: string, opts: ReadSseOptions = {}): Promise<SseFrame[]> {
  const target = new URL(url);
  if (opts.lastEventId !== undefined) target.searchParams.set("lastEventId", String(opts.lastEventId));
  const abort = new AbortController();
  const res = await fetch(target, { signal: abort.signal, headers: { accept: "text/event-stream" } });
  try {
    return await readSseResponse(res, opts, abort);
  } finally {
    abort.abort();
  }
}

export interface SseWatch {
  /** Every frame received so far, in order. */
  readonly frames: SseFrame[];
  /** Resolves when `predicate` is true for the frames so far, or rejects after `timeoutMs`. */
  waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Keep one SSE connection open in the background and expose its frames; `onFrame` sees each one as it arrives. */
export async function watchSse(url: string, opts: { lastEventId?: number; onFrame?: (f: SseFrame) => void } = {}): Promise<SseWatch> {
  const target = new URL(url);
  if (opts.lastEventId !== undefined) target.searchParams.set("lastEventId", String(opts.lastEventId));
  const abort = new AbortController();
  const res = await fetch(target, { signal: abort.signal, headers: { accept: "text/event-stream" } });
  const frames: SseFrame[] = [];
  const waiters = new Set<() => void>();
  const pump = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSseText(buffer);
        buffer = parsed.rest;
        for (const block of parsed.blocks) {
          if (!block.frame) continue;
          frames.push(block.frame);
          opts.onFrame?.(block.frame);
        }
        for (const w of [...waiters]) w();
      }
    } catch {
      // Aborted by close().
    }
  })();
  void pump;
  return {
    frames,
    waitFor(predicate, timeoutMs = 8000) {
      return new Promise<void>((resolve, reject) => {
        const check = (): void => {
          if (predicate(frames)) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for SSE frames (got ${frames.length}: ${frames.map((f) => f.type).join(",")})`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close() {
      abort.abort();
    },
  };
}
