import { describe, expect, it } from "vitest";
import { mergeSettings, settingsDefaults } from "../../src/core/settings.ts";
import { DEFAULT_COMPACTION_POINTS, type LayerManifest } from "../../src/shared/types.ts";

const layer = (name: string, extra: Partial<LayerManifest> = {}): LayerManifest => ({
  name,
  kind: "harness",
  title: name,
  description: name,
  enabledByDefault: true,
  env: [],
  vaultHosts: [],
  ui: { settingsPanels: [], widgets: [], hotkeys: [] },
  ...extra,
});

const manifests = [
  layer("factory_harness", { required: true }),
  layer("provider_openrouter", { kind: "provider" }),
  layer("extra", { enabledByDefault: false }),
];

describe("settings", () => {
  it("defaults come from the project and the manifests", () => {
    const d = settingsDefaults("/x/my-project", manifests);
    expect(d).toEqual({
      factoryName: "my-project",
      layersEnabled: ["factory_harness", "provider_openrouter"],
      toolsDisabled: [],
      model: null,
      thinkingLevel: "low",
      compaction: DEFAULT_COMPACTION_POINTS,
      systemPrompt: null,
      maxTurns: 60,
    });
  });

  it("stored keys win", () => {
    const d = settingsDefaults("/x/p", manifests);
    const s = mergeSettings(
      d,
      {
        factoryName: "Mine",
        model: { provider: "openrouter", modelId: "a/b" },
        thinkingLevel: "max",
        systemPrompt: "Be terse.",
        maxTurns: null,
        toolsDisabled: ["bash"],
        compaction: { ...DEFAULT_COMPACTION_POINTS, forced: 400_000 },
      },
      manifests,
    );
    expect(s.factoryName).toBe("Mine");
    expect(s.model).toEqual({ provider: "openrouter", modelId: "a/b" });
    expect(s.thinkingLevel).toBe("max");
    expect(s.systemPrompt).toBe("Be terse.");
    expect(s.maxTurns).toBeNull();
    expect(s.toolsDisabled).toEqual(["bash"]);
    expect(s.compaction.forced).toBe(400_000);
  });

  it("layerToggles override enabledByDefault, in load order", () => {
    const s = mergeSettings(
      settingsDefaults("/x/p", manifests),
      { layerToggles: { extra: true, provider_openrouter: false } },
      manifests,
    );
    expect(s.layersEnabled).toEqual(["factory_harness", "extra"]);
  });

  it("a required layer stays enabled", () => {
    const s = mergeSettings(settingsDefaults("/x/p", manifests), { layerToggles: { factory_harness: false } }, manifests);
    expect(s.layersEnabled).toContain("factory_harness");
  });

  it("a layer missing from the toggles gets its default", () => {
    const more = [...manifests, layer("newcomer"), layer("quiet", { enabledByDefault: false })];
    const s = mergeSettings(settingsDefaults("/x/p", more), { layerToggles: { extra: true } }, more);
    expect(s.layersEnabled).toEqual(["factory_harness", "provider_openrouter", "extra", "newcomer"]);
  });

  it("a stored value of the wrong shape falls back to the default", () => {
    const s = mergeSettings(
      settingsDefaults("/x/p", manifests),
      { thinkingLevel: "huge" as never, maxTurns: 0 as never, model: { provider: 1 } as never },
      manifests,
    );
    expect(s.thinkingLevel).toBe("low");
    expect(s.maxTurns).toBe(60);
    expect(s.model).toBeNull();
  });
});
