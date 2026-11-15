/**
 * The message box's history: what was sent this browser session, recalled with ↑ and ↓ like a shell. Pure, so the
 * walking rules are unit-tested without a DOM; the pane stores the list in sessionStorage as JSON.
 */

/** How many sent messages are kept. */
export const HISTORY_MAX = 25;

/** The stored list; anything unreadable is no history. */
export function parseHistory(json: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** `history` with `text` as the newest entry; a repeat moves to the end instead of adding a copy. */
export function pushHistory(history: readonly string[], text: string): readonly string[] {
  const entry = text.trim();
  if (entry === "") return history;
  return [...history.filter((h) => h !== entry), entry].slice(-HISTORY_MAX);
}

/** Where ↑ has walked to, and the draft that was in the box when the walk began. */
export interface HistoryWalk {
  readonly index: number;
  readonly typed: string;
}

export interface WalkInput {
  readonly history: readonly string[];
  readonly walk: HistoryWalk | null;
  readonly direction: -1 | 1;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export interface WalkStep {
  readonly walk: HistoryWalk | null;
  readonly value: string;
}

/**
 * One arrow press, or null when the press is not a history move (the caret is not on the first line for ↑ or the
 * last line for ↓, a selection is active, or there is nowhere to go). Walking down past the newest entry puts the draft
 * back and ends the walk.
 */
export function walkHistory(input: WalkInput): WalkStep | null {
  const { history, walk, direction, value, selectionStart, selectionEnd } = input;
  if (history.length === 0 || selectionStart !== selectionEnd) return null;
  if (direction === -1 && value.slice(0, selectionStart).includes("\n")) return null;
  if (direction === 1 && (walk === null || value.slice(selectionEnd).includes("\n"))) return null;
  const index = (walk === null ? history.length : walk.index) + direction;
  if (index < 0) return null;
  const typed = walk === null ? value : walk.typed;
  if (index >= history.length) return { walk: null, value: typed };
  return { walk: { index, typed }, value: history[index]! };
}

/** The quiet line under the box, or null when it has nothing to say. */
export function historyHint(history: readonly string[], walk: HistoryWalk | null, draft: string): string | null {
  if (walk !== null) return `Earlier message ${walk.index + 1} of ${history.length}. ↓ returns to your draft.`;
  if (draft === "" && history.length > 0) return "↑ recalls your last message";
  return null;
}
