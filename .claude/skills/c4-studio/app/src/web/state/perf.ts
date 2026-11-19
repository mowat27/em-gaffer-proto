import { useSyncExternalStore } from 'react';

export interface C4StudioDebug {
  lastRenderMs: number;
  revision: number;
}

declare global {
  interface Window {
    __c4studio: C4StudioDebug;
  }
}

window.__c4studio = { lastRenderMs: 0, revision: 0 };

let pending: { revision: number; t0: number } | null = null;
let snap: C4StudioDebug = { ...window.__c4studio };
const listeners = new Set<() => void>();

/** Call when a branch state for `revision` arrives (SSE event or edit response). */
export function markArrival(revision: number): void {
  pending = { revision, t0: performance.now() };
}

/** Call from a layout effect after the canvas has committed nodes for `revision`. */
export function markRendered(revision: number): void {
  if (!pending || pending.revision !== revision) return;
  const ms = Math.round(performance.now() - pending.t0);
  pending = null;
  window.__c4studio.lastRenderMs = ms;
  window.__c4studio.revision = revision;
  snap = { lastRenderMs: ms, revision };
  listeners.forEach((l) => l());
}

export function useRenderStats(): C4StudioDebug {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snap,
    () => snap,
  );
}
