/**
 * Compaction points to pi-durable policy (D3, DESIGN 7 "Compaction mapping"). The user's numbers are absolute token
 * counts (background 200k, forced 500k); pi-durable's are relative to the model's window:
 * generation blocks above `window - reserveTokens`, and background compaction starts `backgroundTokens` below that.
 * Stored points stay absolute; the clamp happens here, at read time, for the current model's window.
 * Pure TypeScript (port of the reference compaction.ts).
 */
import type { CompactionPolicy } from "@earendil-works/pi-durable";
import type { CompactionPoints, EffectiveCompaction } from "../shared/types.ts";

/** Room always kept for the answer above the forced point (pi-durable's own default reserve). */
export const MIN_RESERVE = 16_384;
/** Minimum distance between the background and the forced point. */
export const MIN_GAP = 8_192;
/** A background point below this is meaningless: background compaction is then off. */
export const MIN_BACKGROUND = 4_096;

export function effectiveCompaction(window: number, points: CompactionPoints): EffectiveCompaction {
  const w = Math.max(0, Math.floor(window));
  const forced = Math.max(0, Math.min(Math.round(points.forced), w - MIN_RESERVE));
  // A background point at or past the forced one means "no background compaction".
  let background: number | null = null;
  let backgroundTokens = 0;
  if (points.background < points.forced) {
    const b = Math.min(Math.round(points.background), forced - MIN_GAP);
    if (b >= MIN_BACKGROUND) {
      background = b;
      backgroundTokens = forced - b;
    }
  }
  const clamped =
    forced !== points.forced || (points.background < points.forced && background !== points.background);
  return {
    window: w,
    enabled: points.enabled,
    background,
    forced,
    reserveTokens: w - forced,
    backgroundTokens,
    clamped,
  };
}

/** The pi-durable policy for a window: `reserveTokens = window - forced'`, `backgroundTokens = forced' - background'`. */
export function toPolicy(window: number, points: CompactionPoints): CompactionPolicy {
  const e = effectiveCompaction(window, points);
  return {
    enabled: points.enabled,
    reserveTokens: e.reserveTokens,
    keepRecentTokens: points.keepRecentTokens,
    backgroundTokens: e.backgroundTokens,
  };
}
