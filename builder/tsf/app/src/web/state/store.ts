/**
 * The client store (DESIGN 11, "State"): one module-level state built from the SSE snapshot plus deltas by the pure
 * reducer, read in components with `useFactory(selector)` (`useSyncExternalStore`). A refresh rebuilds everything from
 * the snapshot. The store also mirrors the theme into the page: the theme CSS into `<style id="tsf-theme">` and the UI
 * config's mode onto `<html data-theme>`.
 *
 * Selectors must return a slice of the state (or a primitive), not a new object per call, or React re-renders forever.
 */
import { useSyncExternalStore } from "react";
import type { Delta, SseFrame, UiConfig } from "../../shared/types.ts";
import { applyMode, applyThemeCss, currentThemeCss } from "../theme.ts";
import { initialState, reduce, withConnection, type Connection, type FactoryState } from "./reducer.ts";
import { connectEvents } from "./sse.ts";

export type { Connection, FactoryState } from "./reducer.ts";

/** How long "restarting" is shown before the page falls back to the plain connection state. */
const RESTARTING_MAX_MS = 45_000;

let state: FactoryState = initialState;
const listeners = new Set<() => void>();
const deltaListeners = new Set<(delta: Delta) => void>();

function set(next: FactoryState): void {
  if (next === state) return;
  const prev = state;
  state = next;
  if (next.themeCss !== prev.themeCss && next.themeCss !== "") applyThemeCss(next.themeCss);
  // The mode is known once a snapshot arrived; until then the anti-flash script's choice stands.
  if (next.snapshot !== null && (prev.snapshot === null || next.uiConfig.theme.mode !== prev.uiConfig.theme.mode)) {
    applyMode(next.uiConfig.theme.mode);
  }
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The current state, outside React (event handlers, tests). */
export function getFactoryState(): FactoryState {
  return state;
}

/** Read a slice of the state in a component; re-renders when that slice changes (compared with Object.is). */
export function useFactory<T>(selector: (s: FactoryState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initialState),
  );
}

/** Feed one SSE frame through the reducer (the stream calls this; tests may too). */
export function applyFrame(frame: SseFrame): void {
  set(reduce(state, frame));
  if (frame.type === "delta" && frame.delta.type === "factory.restarting") {
    // If the process never goes away, do not show "restarting" for ever: pings and deltas then make it live again.
    setTimeout(() => {
      if (state.connection === "restarting") set({ ...state, connection: "offline" });
    }, RESTARTING_MAX_MS);
  }
  if (frame.type === "delta") for (const fn of [...deltaListeners]) fn(frame.delta);
}

/**
 * Apply a UI config the client already holds (the response of `api.uiConfig.update`), so a pane change shows before
 * its `ui_config.changed` event arrives. Ignored unless it is newer than the one held.
 */
export function acceptUiConfig(config: UiConfig): void {
  if (config.version > state.uiConfig.version) set({ ...state, uiConfig: config });
}

/** Every delta as it is applied (for views that react to events such as `ui.open` or `layer.changed`). */
export function onDelta(fn: (delta: Delta) => void): () => void {
  deltaListeners.add(fn);
  return () => {
    deltaListeners.delete(fn);
  };
}

function setConnection(connection: Connection): void {
  set(withConnection(state, connection));
}

let stopStream: (() => void) | null = null;

/**
 * Open the event stream and start feeding the store. Call once before the first render; returns the stop function.
 * A second call while running returns the same stop function.
 */
export function startStore(): () => void {
  if (stopStream) return stopStream;
  // Keep the server-inlined theme element last in <head> (it must follow components.css).
  const inlined = currentThemeCss();
  if (inlined !== "") applyThemeCss(inlined);
  const stop = connectEvents({
    onFrame: applyFrame,
    onConnection: setConnection,
    lastId: () => state.lastId,
  });
  stopStream = () => {
    stop();
    stopStream = null;
  };
  return stopStream;
}
