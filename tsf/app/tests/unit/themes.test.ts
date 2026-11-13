import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDb } from "../../src/core/db.ts";
import { silentLogger } from "../../src/core/log.ts";
import { ThemeStore } from "../../src/core/themes.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { cleanupTmp } from "../helpers/tmp.ts";
import { join } from "node:path";

let store: ThemeStore;
let db: ReturnType<typeof openAppDb>;

beforeEach(async () => {
  db = openAppDb(join(await tmpDir("tsf-themes"), "tsf.sqlite"));
  store = new ThemeStore({ log: silentLogger, repo: db.themes });
  await store.init();
});
afterEach(async () => {
  db.close();
  await cleanupTmp();
});

describe("ThemeStore: PW themes", () => {
  it("lists the PW themes from the package with their styles", () => {
    const list = store.list();
    const names = list.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["precision-weave", "precision-weave-neon", "precision-weave-glass"]));
    expect(list.find((t) => t.name === "precision-weave-neon")).toMatchObject({ kind: "pw", base: null, style: "glass" });
    expect(list.find((t) => t.name === "precision-weave")).toMatchObject({ style: "flat" });
  });

  it("renders Neon as its built CSS plus the glass preset, and a flat theme without a preset", async () => {
    const neon = await store.cssOf("precision-weave-neon");
    expect(neon).toContain("--pw-ai-glow");
    expect(neon).toContain("pw-");
    const flat = await store.cssOf("precision-weave");
    expect(flat.length).toBeLessThan(neon.length);
    expect(flat).not.toContain("backdrop-filter");
  });

  it("checks Neon with no problems", () => {
    const check = store.check("precision-weave-neon");
    expect(check.problems).toEqual([]);
    expect(check.name).toBe("precision-weave-neon");
  });

  it("refuses to edit, fix or delete a PW theme", () => {
    expect(() => store.setValues("precision-weave", { tokens: { canvas: "#101010" } })).toThrow(/read-only/);
    expect(() => store.fix("precision-weave")).toThrow(/read-only/);
    expect(() => store.delete("precision-weave")).toThrow(/read-only/);
  });

  it("unknown theme: not_found", async () => {
    expect(() => store.check("nope")).toThrow(/no such theme/);
    await expect(store.cssOf("nope")).rejects.toThrow(/no such theme/);
  });
});

describe("ThemeStore: custom themes", () => {
  it("creates a theme on a PW base, stores it, lists it and renders its CSS with the base's style", async () => {
    const { theme, created } = store.create({
      name: "ocean",
      title: "Ocean",
      base: "precision-weave-neon",
      seeds: { brand: { light: "#1A5C8C", dark: "#6CB6E8" } },
      tokens: { canvas: { dark: "#0A1018" } },
    });
    expect(created).toBe(true);
    expect(theme.base).toBe("precision-weave-neon");
    const info = store.list().find((t) => t.name === "ocean")!;
    expect(info).toMatchObject({ kind: "custom", base: "precision-weave-neon", style: "glass", title: "Ocean" });
    expect(info.definition?.seeds).toEqual({ brand: { light: "#1A5C8C", dark: "#6CB6E8" } });
    // Resolved colours: the override wins, the rest is inherited from the base.
    const neon = store.list().find((t) => t.name === "precision-weave-neon")!;
    expect(neon.resolved?.seeds.ai?.light).toMatch(/^#[0-9A-F]{6}$/i);
    expect(Object.keys(neon.resolved?.seeds ?? {}).sort()).toEqual(["ai", "ai-to", "brand", "accent"].sort());
    expect(neon.resolved?.tokens.canvas).toEqual({ light: "#EEF4F5", dark: "#050708" });
    expect(info.resolved?.tokens.canvas).toEqual({ light: "#EEF4F5", dark: "#0A1018" });
    expect(info.resolved?.seeds.brand?.light).toMatch(/^#1A5[CE]8[CE]$/);
    expect(info.resolved?.seeds.brand?.light).not.toBe(neon.resolved?.seeds.brand?.light);
    expect(info.resolved?.seeds.ai).toEqual(neon.resolved?.seeds.ai);
    const css = await store.cssOf("ocean");
    expect(css).toContain("#0A1018");
    expect(css).toContain("backdrop-filter");
    // Stored in sqlite: a new store sees it.
    const again = new ThemeStore({ log: silentLogger, repo: db.themes });
    await again.init();
    expect(again.has("ocean")).toBe(true);
  });

  it("a repeated create with the same content is a no-op; other content is a conflict", () => {
    const input = { name: "same", base: "precision-weave", tokens: { canvas: "#202020" } } as const;
    expect(store.create(input).created).toBe(true);
    expect(store.create(input).created).toBe(false);
    expect(() => store.create({ ...input, tokens: { canvas: "#303030" } })).toThrow(/exists/);
  });

  it("validates names, bases, seeds, tokens and values", () => {
    expect(() => store.create({ name: "Bad Name", base: "precision-weave" })).toThrow(/name/);
    expect(() => store.create({ name: "precision-weave", base: "precision-weave" })).toThrow(/Precision Weave theme name/);
    expect(() => store.create({ name: "x1", base: "nope" })).toThrow(/base must be/);
    expect(() => store.create({ name: "x2", base: "precision-weave", seeds: { sparkle: "#fff" } })).toThrow(/unknown name/);
    expect(() => store.create({ name: "x3", base: "precision-weave", tokens: { canvas: "red; } body { display: none" } })).toThrow(/characters/);
    expect(() => store.create({ name: "x4", base: "precision-weave", tokens: { canvas: "</style><script>" } })).toThrow(/characters/);
    expect(() => store.create({ name: "x5", base: "precision-weave", tokens: { canvas: "not a colour" } })).toThrow(/canvas/);
    expect(() => store.create({ name: "x6", base: "precision-weave", tokens: { "no-such-token": "#fff" } })).toThrow(/does not exist/);
    expect(() => store.create({ name: "x7", base: "precision-weave", title: "a */ b" })).toThrow(/title/);
    expect(store.names()).not.toContain("x7");
  });

  it("setValues merges per mode and null deletes", () => {
    store.create({ name: "mix", base: "precision-weave", tokens: { canvas: { light: "#F0F0F0", dark: "#101010" } } });
    const a = store.setValues("mix", { tokens: { canvas: { dark: "#181818" }, surface: "#FFFFFF" } });
    expect(a.tokens.canvas).toEqual({ light: "#F0F0F0", dark: "#181818" });
    expect(a.tokens.surface).toBe("#FFFFFF");
    const b = store.setValues("mix", { tokens: { surface: null } });
    expect(b.tokens.surface).toBeUndefined();
    expect(store.setValues("mix", {})).toBe(b);
  });

  it("check reports contrast warnings and fixes; fix writes them as token overrides and clears the warnings", () => {
    store.create({ name: "pale", base: "precision-weave", tokens: { "text-3": { light: "#CCCCCC" } } });
    const before = store.check("pale");
    expect(before.warnings.some((w) => w.includes("text-3"))).toBe(true);
    expect(before.fixes.length).toBeGreaterThan(0);
    const { theme, applied } = store.fix("pale");
    expect(applied.length).toBe(before.fixes.length);
    expect(JSON.stringify(theme.tokens["text-3"])).not.toContain("CCCCCC");
    expect(store.check("pale").warnings.filter((w) => w.includes("text-3"))).toEqual([]);
  });

  it("delete removes the theme from the list and the db", () => {
    store.create({ name: "gone", base: "precision-weave" });
    store.delete("gone");
    expect(store.has("gone")).toBe(false);
    expect(db.themes.get("gone")).toBeUndefined();
    expect(() => store.delete("gone")).toThrow(/no such theme/);
  });

  it("activate caches the CSS and the name", async () => {
    expect(store.activeCss()).toBe("");
    const css = await store.activate("precision-weave-glass");
    expect(store.activeCss()).toBe(css);
    expect(store.activeName()).toBe("precision-weave-glass");
  });
});
