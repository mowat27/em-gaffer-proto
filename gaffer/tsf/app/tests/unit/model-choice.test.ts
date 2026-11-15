/**
 * shared/model-choice.ts: names, vendor groups, search, the favourites list and its edits, and the thinking level a
 * model gets, the last checked against pi-ai's own clampThinkingLevel.
 */
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  clampLevel,
  editFavourites,
  FavouriteError,
  favouriteList,
  groupByVendor,
  matchesQuery,
  nextLevel,
  shortName,
  vendorLabel,
} from "../../src/shared/model-choice.ts";
import { THINKING_LEVELS, type ModelInfo, type ModelRef, type ThinkingLevel } from "../../src/shared/types.ts";

const model = (id: string, name: string, provider = "openrouter", thinkingLevels: ThinkingLevel[] = [...THINKING_LEVELS]): ModelInfo => ({
  provider,
  id,
  name,
  contextWindow: 200_000,
  maxTokens: 32_000,
  reasoning: thinkingLevels.length > 1,
  thinkingLevels,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  source: "live",
});

const MODELS = [
  model("openai/gpt-6.1-terra", "OpenAI: GPT-6.1 Terra"),
  model("aion-labs/aion-10", "AionLabs: Aion 10"),
  model("aion-labs/aion-3.5", "AionLabs: Aion 3.5"),
  model("anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5"),
  model("faux-1", "Faux", "faux"),
];
const ref = (modelId: string, provider = "openrouter"): ModelRef => ({ provider, modelId });

describe("names and vendors", () => {
  it("drops the vendor prefix of a name, and keeps a name without one", () => {
    expect(shortName("OpenAI: GPT-6.1 Terra")).toBe("GPT-6.1 Terra");
    expect(shortName("Faux")).toBe("Faux");
    expect(shortName("Mistral: Codestral: 2508")).toBe("Codestral: 2508");
  });

  it("groups by the id before the slash, labels groups by the name prefix, sorts both naturally", () => {
    const groups = groupByVendor(MODELS);
    expect(groups.map((g) => g.label)).toEqual(["AionLabs", "Anthropic", "faux", "OpenAI"]);
    expect(groups[0]!.key).toBe("aion-labs");
    // 3.5 before 10: numbers compare as numbers.
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["aion-labs/aion-3.5", "aion-labs/aion-10"]);
    expect(vendorLabel(MODELS[4]!)).toBe("faux");
  });

  it("search needs every word somewhere in the name, id, provider or vendor", () => {
    const hits = (q: string) => MODELS.filter((m) => matchesQuery(m, q)).map((m) => m.id);
    expect(hits("")).toHaveLength(MODELS.length);
    expect(hits("aion 3.5")).toEqual(["aion-labs/aion-3.5"]);
    expect(hits("AIONLABS")).toEqual(["aion-labs/aion-10", "aion-labs/aion-3.5"]);
    expect(hits("faux")).toEqual(["faux-1"]);
    expect(hits("openrouter sonnet")).toEqual(["anthropic/claude-sonnet-5.5"]);
    expect(hits("sonnet terra")).toEqual([]);
  });
});

describe("the favourites list", () => {
  it("lists favourites in order, then the model in use when it is not one", () => {
    const rows = favouriteList([ref("anthropic/claude-sonnet-5.5"), ref("openai/gpt-6.1-terra")], MODELS, ref("faux-1", "faux"));
    expect(rows.map((r) => [r.modelId, r.label, r.position, r.current])).toEqual([
      ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", 1, false],
      ["openai/gpt-6.1-terra", "GPT-6.1 Terra", 2, false],
      ["faux-1", "Faux (current)", null, true],
    ]);
  });

  it("marks the current favourite without adding a row, and a favourite that is not offered", () => {
    const rows = favouriteList([ref("openai/gpt-6.1-terra"), ref("gone/model")], MODELS, ref("openai/gpt-6.1-terra"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ current: true, favourite: true, available: true });
    expect(rows[1]).toMatchObject({ name: "gone/model", label: "gone/model (not offered)", available: false, current: false });
  });
});

describe("editing the favourites", () => {
  const offered = (r: ModelRef) => MODELS.some((m) => m.provider === r.provider && m.id === r.modelId);
  const ids = (list: readonly ModelRef[]) => list.map((r) => r.modelId);
  const start = [ref("openai/gpt-6.1-terra"), ref("aion-labs/aion-10"), ref("aion-labs/aion-3.5")];

  it("adds a new favourite at the front by default, or at a position", () => {
    expect(ids(editFavourites(start, { ...ref("anthropic/claude-sonnet-5.5"), favourite: true }, offered))[0]).toBe("anthropic/claude-sonnet-5.5");
    expect(ids(editFavourites(start, { ...ref("anthropic/claude-sonnet-5.5"), favourite: true, position: 2 }, offered))).toEqual([
      "openai/gpt-6.1-terra",
      "anthropic/claude-sonnet-5.5",
      "aion-labs/aion-10",
      "aion-labs/aion-3.5",
    ]);
    // A position past the end appends.
    expect(ids(editFavourites(start, { ...ref("anthropic/claude-sonnet-5.5"), favourite: true, position: 99 }, offered)).at(-1)).toBe("anthropic/claude-sonnet-5.5");
  });

  it("keeps an existing favourite in place unless a position moves it", () => {
    expect(ids(editFavourites(start, { ...ref("aion-labs/aion-10"), favourite: true }, offered))).toEqual(ids(start));
    expect(ids(editFavourites(start, { ...ref("aion-labs/aion-3.5"), favourite: true, position: 1 }, offered))).toEqual([
      "aion-labs/aion-3.5",
      "openai/gpt-6.1-terra",
      "aion-labs/aion-10",
    ]);
    expect(ids(editFavourites(start, { ...ref("openai/gpt-6.1-terra"), favourite: true, position: 2 }, offered))).toEqual([
      "aion-labs/aion-10",
      "openai/gpt-6.1-terra",
      "aion-labs/aion-3.5",
    ]);
  });

  it("removes a favourite, also one that is no longer offered; removing a non-favourite changes nothing", () => {
    expect(ids(editFavourites(start, { ...ref("aion-labs/aion-10"), favourite: false }, offered))).toEqual(["openai/gpt-6.1-terra", "aion-labs/aion-3.5"]);
    expect(ids(editFavourites([ref("gone/model")], { ...ref("gone/model"), favourite: false }, offered))).toEqual([]);
    expect(editFavourites(start, { ...ref("nope"), favourite: false }, offered)).toEqual(start);
  });

  it("refuses a model that is not offered, and a bad position", () => {
    expect(() => editFavourites(start, { ...ref("nope"), favourite: true }, offered)).toThrow(FavouriteError);
    expect(() => editFavourites(start, { ...ref("anthropic/claude-sonnet-5.5"), favourite: true, position: 0 }, offered)).toThrow(/position/);
    // The same model under another provider is another favourite.
    expect(() => editFavourites(start, { ...ref("openai/gpt-6.1-terra", "faux"), favourite: true }, offered)).toThrow(/no such model/);
  });
});

describe("thinking levels", () => {
  it("clamps exactly as pi-ai does, for every level and every kind of model", () => {
    const shapes: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }[] = [
      { reasoning: false },
      { reasoning: true },
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
      { reasoning: true, thinkingLevelMap: { minimal: null, low: null, max: "max" } },
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null } },
    ];
    for (const shape of shapes) {
      const m = shape as unknown as Model<never>;
      const supported = THINKING_LEVELS.filter((l) => clampThinkingLevel(m, l) === l);
      for (const level of THINKING_LEVELS) expect(clampLevel(supported, level), `${JSON.stringify(shape)} ${level}`).toBe(clampThinkingLevel(m, level));
    }
  });

  it("steps through the supported levels and wraps at either end", () => {
    const all = [...THINKING_LEVELS];
    expect(nextLevel(all, "low", 1)).toBe("medium");
    expect(nextLevel(all, "max", 1)).toBe("off");
    expect(nextLevel(all, "off", -1)).toBe("max");
    const some: ThinkingLevel[] = ["off", "low", "high"];
    expect(nextLevel(some, "low", 1)).toBe("high");
    expect(nextLevel(some, "high", 1)).toBe("off");
    // A stored level the model lacks steps from the level it gets (medium -> high), never a press that changes nothing.
    expect(nextLevel(some, "medium", 1)).toBe("off");
    expect(nextLevel(some, "medium", -1)).toBe("low");
    expect(nextLevel(["off"], "off", 1)).toBe("off");
  });
});
