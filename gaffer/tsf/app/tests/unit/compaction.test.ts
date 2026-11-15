import { describe, expect, it } from "vitest";
import { effectiveCompaction, toPolicy } from "../../src/agent/compaction.ts";
import { DEFAULT_COMPACTION_POINTS } from "../../src/shared/types.ts";

describe("compaction mapping (D3)", () => {
  it("1M window: reserve 500 000, background 300 000", () => {
    const policy = toPolicy(1_000_000, DEFAULT_COMPACTION_POINTS);
    expect(policy).toEqual({ enabled: true, reserveTokens: 500_000, backgroundTokens: 300_000, keepRecentTokens: 20_000 });
    const e = effectiveCompaction(1_000_000, DEFAULT_COMPACTION_POINTS);
    expect(e).toMatchObject({ window: 1_000_000, forced: 500_000, background: 200_000, clamped: false });
  });

  it("a 200k window clamps both points", () => {
    const e = effectiveCompaction(200_000, DEFAULT_COMPACTION_POINTS);
    expect(e.forced).toBe(200_000 - 16_384);
    expect(e.reserveTokens).toBe(16_384);
    expect(e.background).toBe(e.forced - 8_192);
    expect(e.backgroundTokens).toBe(8_192);
    expect(e.clamped).toBe(true);
    expect(toPolicy(200_000, DEFAULT_COMPACTION_POINTS).reserveTokens).toBe(16_384);
  });

  it("a background point at or past the forced one disables background compaction", () => {
    const points = { ...DEFAULT_COMPACTION_POINTS, background: 500_000, forced: 500_000 };
    const e = effectiveCompaction(1_000_000, points);
    expect(e.background).toBeNull();
    expect(e.backgroundTokens).toBe(0);
    expect(toPolicy(1_000_000, { ...points, background: 600_000 }).backgroundTokens).toBe(0);
  });

  it("enabled and keepRecentTokens pass through", () => {
    const points = { ...DEFAULT_COMPACTION_POINTS, enabled: false, keepRecentTokens: 7_000 };
    expect(toPolicy(1_000_000, points)).toMatchObject({ enabled: false, keepRecentTokens: 7_000 });
  });
});
