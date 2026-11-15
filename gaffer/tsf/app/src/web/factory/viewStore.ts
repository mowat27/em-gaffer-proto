/**
 * Which screen the centre pane shows: a Markdown page (the TSF default) or one of the factory's own screens
 * (overview, gaffer). Client-side state, remembered per browser. A page selection made by anyone (the tree,
 * the agent, a route) brings the page screen forward.
 */
import { useSyncExternalStore } from "react";
import { onDelta } from "../state/store.ts";

export type View = "page" | "overview" | "gaffer";
const KEY = "tsf.factory.view";
const VIEWS: View[] = ["page", "overview", "gaffer"];

/** `?view=gaffer` in the URL wins (a deep link, the screenshot tool); else the remembered screen; else the overview. */
function load(): View {
  try {
    const q = new URLSearchParams(window.location.search).get("view");
    if (VIEWS.includes(q as View)) return q as View;
  } catch {
    /* no window */
  }
  try {
    const v = localStorage.getItem(KEY);
    return VIEWS.includes(v as View) ? (v as View) : "overview";
  } catch {
    return "overview";
  }
}

let view: View = load();
const listeners = new Set<() => void>();

export function setView(next: View): void {
  if (next === view) return;
  view = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* fine without storage */
  }
  for (const fn of [...listeners]) fn();
}

export function getView(): View {
  return view;
}

export function useView(): View {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => view,
    () => view,
  );
}

let wired = false;
/** A page selected by the agent (or any API caller) shows the page screen. Call once at startup. */
export function wireViewToSelection(): void {
  if (wired) return;
  wired = true;
  onDelta((d) => {
    if (d.type === "selection.changed" && d.selection.path !== null && d.selection.by !== "ui") setView("page");
  });
}
