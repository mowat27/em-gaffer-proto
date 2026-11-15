/** Token counts and money, printed the same way by the context bar and the Core 4 panels. */

/** Compact token counts: 1 234 -> "1.2k", 200 000 -> "200k", 1 050 000 -> "1.05M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1_000_000) return `${Math.round(n / 10_000) / 100}M`;
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** Dollars, shared with the answer line under each reply. */
export { money } from "../../shared/chat-display.ts";
