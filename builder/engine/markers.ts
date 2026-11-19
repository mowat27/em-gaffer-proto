/**
 * `BUILD:` markers: the places a scaffold leaves for the agent to fill. The template step lists every marker it left
 * in its report, and the commit-scope check `build-markers` refuses a change that still holds one. No imports, so the
 * checks (loaded inside pi too) can use it.
 */

/** A marker: `BUILD:` as a word, wherever it sits (a `//`, `--` or `#` comment, a JSDoc line...). */
export const BUILD_MARKER = /\bBUILD:/;

export interface Marker {
  /** 1-based. */
  line: number;
  /** The line, trimmed. */
  text: string;
}

/** Every line of `text` that holds a marker, in order. */
export function markersIn(text: string): Marker[] {
  const out: Marker[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (BUILD_MARKER.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim() });
  return out;
}
