/**
 * Hotkeys (DESIGN 11): the key table comes from the UI config (`hotkeys`: action -> one key or "mod+key"). Pure matching
 * lives here so it can be tested without a DOM; `useHotkeys` is the one listener App mounts. Keys are ignored while focus
 * is in an `input`, `textarea`, `select` or `[contenteditable]`, and while a dialog is open.
 */
import { useEffect } from "react";

/** True for the elements a person types into; their keystrokes are never hotkeys. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return true;
  return false;
}

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Does the event press `spec`? A single key ("s", "[", "/") needs no ctrl, meta or alt; letters match in either case.
 * "mod+key" needs ctrl or meta (mod is ⌘ on a Mac, ctrl elsewhere; either is accepted) and no alt.
 */
export function matchHotkey(e: KeyLike, spec: string): boolean {
  const s = spec.trim();
  if (s === "") return false;
  const mod = /^mod\+/i.test(s);
  const key = (mod ? s.slice(4) : s).toLowerCase();
  if (key === "") return false;
  if (e.altKey) return false;
  if (mod) return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === key;
  if (e.ctrlKey || e.metaKey) return false;
  return e.key.toLowerCase() === key;
}

/** The action whose key the event presses, or null. `table` is `uiConfig.hotkeys`. */
export function actionFor(e: KeyLike, table: Readonly<Record<string, string>>): string | null {
  for (const [action, spec] of Object.entries(table)) if (matchHotkey(e, spec)) return action;
  return null;
}

/** Listen on the window; `table()` and `run` are read at event time, so a changed key applies at once. */
export function useHotkeys(table: () => Readonly<Record<string, string>>, run: (action: string) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (isTextTarget(e.target) || isTextTarget(document.activeElement)) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      const action = actionFor(e, table());
      if (action === null) return;
      e.preventDefault();
      run(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [table, run]);
}
