import { describe, expect, it } from "vitest";
import { money, tokens } from "../../src/web/lib/usage.ts";

describe("usage formatting", () => {
  it("prints token counts compactly", () => {
    expect(tokens(950)).toBe("950");
    expect(tokens(1_234)).toBe("1.2k");
    expect(tokens(37_200)).toBe("37.2k");
    expect(tokens(200_000)).toBe("200k");
    expect(tokens(1_000_000)).toBe("1M");
    expect(tokens(1_050_000)).toBe("1.05M");
  });

  it("prints small costs with four decimals and larger ones with two", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.0123)).toBe("$0.0123");
    expect(money(2.5)).toBe("$2.50");
  });
});
