import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDb, type AppDb } from "../../src/core/db.ts";
import { ServiceError } from "../../src/core/errors.ts";
import { mergePatch, UiConfigStore } from "../../src/core/ui-config.ts";
import { DEFAULT_UI_CONFIG, type UiConfig } from "../../src/shared/types.ts";
import { checkUiConfig, uiConfigValidator } from "../../src/shared/ui-config-schema.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const open: AppDb[] = [];
async function fresh(): Promise<{ db: AppDb; file: string }> {
  const file = join(await tmpDir("tsf-ui"), "tsf.sqlite");
  const db = openAppDb(file);
  open.push(db);
  return { db, file };
}

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await cleanupTmp();
});

function codeOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServiceError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a ServiceError");
}

const clone = (c: UiConfig): Record<string, unknown> => JSON.parse(JSON.stringify(c)) as Record<string, unknown>;

describe("mergePatch (RFC 7386)", () => {
  it("merges objects, replaces arrays and scalars, deletes on null, and leaves its inputs alone", () => {
    const target = { a: { b: 1, c: [1, 2] }, d: "x", e: 1 };
    const patch = { a: { c: [3], f: true }, d: null, g: { h: 2 } };
    expect(mergePatch(target, patch)).toEqual({ a: { b: 1, c: [3], f: true }, e: 1, g: { h: 2 } });
    expect(target).toEqual({ a: { b: 1, c: [1, 2] }, d: "x", e: 1 });
    expect(mergePatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(mergePatch([1], { a: 1 })).toEqual({ a: 1 });
  });

  it("refuses __proto__ keys", () => {
    expect(codeOf(() => mergePatch({}, JSON.parse('{"__proto__":{"x":1}}'))).code).toBe("invalid");
  });
});

describe("the schema", () => {
  it("accepts the defaults", () => {
    expect(uiConfigValidator.check(DEFAULT_UI_CONFIG)).toBe(true);
    expect(checkUiConfig(DEFAULT_UI_CONFIG)).toEqual([]);
  });

  it("rejects unknown keys at every level", () => {
    const top = { ...clone(DEFAULT_UI_CONFIG), colour: "red" };
    expect(checkUiConfig(top)[0]).toMatch(/^\/colour: /);
    const deep = clone(DEFAULT_UI_CONFIG);
    (deep.panes as Record<string, unknown>).middle = { visible: true, width: 300 };
    expect(checkUiConfig(deep)[0]).toMatch(/^\/panes\/middle: /);
  });

  it("rejects a bad slot, a width off the range and a bad placement id", () => {
    const doc = clone(DEFAULT_UI_CONFIG) as unknown as { navbars: { global: { items: { slot: string; id: string }[] } }; panes: { left: { width: number } } };
    doc.navbars.global.items[0]!.slot = "top";
    expect(checkUiConfig(doc).join("\n")).toMatch(/\/navbars\/global\/items\/0\/slot/);
    const wide = clone(DEFAULT_UI_CONFIG) as typeof doc;
    wide.panes.left.width = 2000;
    expect(checkUiConfig(wide)[0]).toMatch(/^\/panes\/left\/width: /);
    const badId = clone(DEFAULT_UI_CONFIG) as typeof doc;
    badId.navbars.global.items[0]!.id = "Has Spaces";
    expect(checkUiConfig(badId)[0]).toMatch(/^\/navbars\/global\/items\/0\/id: /);
  });

  it("rejects a duplicate placement id across navbars", () => {
    const doc = clone(DEFAULT_UI_CONFIG) as unknown as { navbars: { agent: { items: { id: string }[] } } };
    doc.navbars.agent.items[0]!.id = "factory_name-1";
    expect(checkUiConfig(doc)).toEqual([expect.stringMatching(/duplicate placement id factory_name-1/)]);
  });

  it("rejects a duplicate hotkey (case-insensitive) and a missing built-in action", () => {
    const doc = clone(DEFAULT_UI_CONFIG) as unknown as { hotkeys: Record<string, string> };
    doc.hotkeys["cron.open"] = "S";
    expect(checkUiConfig(doc)).toEqual([expect.stringMatching(/duplicate hotkey S/)]);
    const missing = clone(DEFAULT_UI_CONFIG) as typeof doc;
    delete missing.hotkeys["agent.focus"];
    expect(checkUiConfig(missing)[0]).toMatch(/agent\.focus: the built-in action needs a key/);
  });

  it("accepts shift+key and mod+shift+key beside the plain key, and refuses other modifiers", () => {
    const doc = clone(DEFAULT_UI_CONFIG) as unknown as { hotkeys: Record<string, string> };
    doc.hotkeys["x.up"] = "e";
    doc.hotkeys["x.down"] = "shift+e";
    doc.hotkeys["x.chord"] = "mod+shift+k";
    expect(checkUiConfig(doc)).toEqual([]);
    doc.hotkeys["x.alt"] = "alt+e";
    expect(checkUiConfig(doc)).toEqual([expect.stringMatching(/x\.alt: "alt\+e" is not one key/)]);
  });

  it("checks widget types against the navbars they may sit in, and theme names, when the context lists them", () => {
    const doc = clone(DEFAULT_UI_CONFIG) as unknown as { navbars: { agent: { items: unknown[] } }; theme: { name: string } };
    doc.navbars.agent.items.push({ id: "clock-1", widget: "demo.clock", slot: "right", options: {} });
    expect(checkUiConfig(doc)).toEqual([]);
    expect(checkUiConfig(doc, { widgets: [] })[0]).toMatch(/unknown widget demo\.clock/);
    expect(checkUiConfig(doc, { widgets: [{ id: "demo.clock", navbars: ["global"] }] })[0]).toMatch(/cannot be placed in the agent navbar/);
    expect(checkUiConfig(doc, { widgets: [{ id: "demo.clock", navbars: ["agent"] }] })).toEqual([]);
    doc.theme.name = "nope";
    expect(checkUiConfig(doc, { themes: ["precision-weave-neon"] })[0]).toMatch(/unknown theme nope/);
  });
});

describe("UiConfigStore", () => {
  it("starts at the defaults and merges a patch, bumping the version", async () => {
    const { db } = await fresh();
    const store = new UiConfigStore(db);
    expect(store.get()).toEqual(DEFAULT_UI_CONFIG);
    const next = store.update({ patch: { panes: { left: { width: 320 } } } });
    expect(next.version).toBe(2);
    expect(next.panes.left).toEqual({ visible: true, width: 320 });
    expect(next.panes.right).toEqual(DEFAULT_UI_CONFIG.panes.right);
    expect(store.update({ patch: { panes: { agentMaximised: true } } }).version).toBe(3);
    expect(store.get().panes).toMatchObject({ left: { width: 320 }, agentMaximised: true });
  });

  it("replaces arrays and deletes with null", async () => {
    const { db } = await fresh();
    const store = new UiConfigStore(db);
    const items = [{ id: "agent_status-2", widget: "agent_status", slot: "right", options: { fullWidth: true } }];
    expect(store.update({ patch: { navbars: { agent: { items } } } }).navbars.agent.items).toEqual(items);
    expect(store.get().navbars.global).toEqual(DEFAULT_UI_CONFIG.navbars.global);
    // Deleting a required key fails validation.
    expect(codeOf(() => store.update({ patch: { panes: { left: null } } })).code).toBe("invalid");
  });

  it("keeps the document and version across a reopen", async () => {
    const { db, file } = await fresh();
    new UiConfigStore(db).update({ patch: { panes: { right: { visible: false } } } });
    db.close();
    const again = openAppDb(file);
    open.push(again);
    const store = new UiConfigStore(again);
    expect(store.get().version).toBe(2);
    expect(store.get().panes.right.visible).toBe(false);
    expect(store.update({ patch: { panes: { right: { visible: true } } } }).version).toBe(3);
  });

  it("refuses a stale baseVersion with conflict and accepts the current one", async () => {
    const { db } = await fresh();
    const store = new UiConfigStore(db);
    store.update({ patch: { panes: { left: { width: 300 } } } });
    expect(codeOf(() => store.update({ patch: { panes: { left: { width: 304 } } }, baseVersion: 1 })).code).toBe("conflict");
    expect(store.update({ patch: { panes: { left: { width: 304 } } }, baseVersion: 2 }).version).toBe(3);
  });

  it("refuses a theme patch (use set_theme), a version patch and a non-object patch", async () => {
    const { db } = await fresh();
    const store = new UiConfigStore(db);
    const theme = codeOf(() => store.update({ patch: { theme: { mode: "dark" } } }));
    expect(theme.code).toBe("invalid");
    expect(theme.message).toMatch(/set_theme/);
    expect(codeOf(() => store.update({ patch: { version: 9 } })).code).toBe("invalid");
    expect(codeOf(() => store.update({ patch: [] as unknown as Record<string, never> })).code).toBe("invalid");
    expect(store.get().version).toBe(1);
  });

  it("names the first schema error in the invalid message", async () => {
    const { db } = await fresh();
    const store = new UiConfigStore(db);
    const bad = codeOf(() => store.update({ patch: { panes: { left: { width: 100 } }, extra: 1 } }));
    expect(bad.code).toBe("invalid");
    expect(bad.message).toMatch(/^\/(panes\/left\/width|extra): /);
    const dupKey = codeOf(() => store.update({ patch: { hotkeys: { "agent.focus": "m" } } }));
    expect(dupKey.message).toMatch(/duplicate hotkey m/);
    expect(store.get()).toEqual(DEFAULT_UI_CONFIG);
  });

  it("returns the document unchanged for a patch that changes nothing", async () => {
    const { db } = await fresh();
    const store = new UiConfigStore(db);
    expect(store.update({ patch: {} })).toBe(store.get());
    expect(store.update({ patch: { panes: { left: { width: 280 } } } }).version).toBe(1);
  });
});

describe("the ui-config routes", () => {
  it("GET returns the document; POST /update merges, publishes ui_config.changed once and maps errors", async () => {
    const factory = await createTestFactory();
    try {
      const events: unknown[] = [];
      const publish = factory.hub.publish.bind(factory.hub);
      factory.hub.publish = (d) => {
        if ("type" in d && d.type === "ui_config.changed") events.push(d);
        return publish(d);
      };
      const get = await factory.app.request("/api/ui-config");
      expect(get.status).toBe(200);
      // The defaults plus what the built-in model_controls layer adds at boot: its hotkeys and default placements.
      const doc = (await get.json()) as UiConfig;
      expect(doc).toEqual({
        ...DEFAULT_UI_CONFIG,
        version: expect.any(Number),
        hotkeys: {
          ...DEFAULT_UI_CONFIG.hotkeys,
          "model_controls.open_models": "p",
          "model_controls.favourite_1": "1",
          "model_controls.favourite_2": "2",
          "model_controls.favourite_3": "3",
          "model_controls.thinking_up": "e",
          "model_controls.thinking_down": "shift+e",
        },
        navbars: {
          global: {
            ...DEFAULT_UI_CONFIG.navbars.global,
            items: [
              ...DEFAULT_UI_CONFIG.navbars.global.items,
              { id: "model_controls.favourite-1", widget: "model_controls.favourite", slot: "right", options: {} },
              { id: "model_controls.thinking-1", widget: "model_controls.thinking", slot: "right", options: {} },
            ],
          },
          agent: {
            ...DEFAULT_UI_CONFIG.navbars.agent,
            items: [...DEFAULT_UI_CONFIG.navbars.agent.items, { id: "model_controls.compact-1", widget: "model_controls.compact", slot: "right", options: {} }],
          },
        },
      });

      const post = (body: unknown) =>
        factory.app.request("/api/ui-config/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const ok = await post({ patch: { panes: { left: { width: 400 } } } });
      expect(ok.status).toBe(200);
      const config = (await ok.json()) as UiConfig;
      expect(config).toMatchObject({ version: doc.version + 1, panes: { left: { width: 400 } } });
      expect(events).toEqual([{ type: "ui_config.changed", config, by: "ui" }]);
      expect(factory.service.snapshot().uiConfig).toEqual(config);

      expect((await post({ patch: { panes: { left: { width: 404 } } }, baseVersion: 1 })).status).toBe(409);
      const theme = await post({ patch: { theme: { name: "precision-weave-neon", mode: "dark" } } });
      expect(theme.status).toBe(400);
      expect(((await theme.json()) as { error: { message: string } }).error.message).toMatch(/set_theme/);
      expect((await post({ patch: "x" })).status).toBe(400);
      expect((await post({ patch: {}, baseVersion: "2" })).status).toBe(400);
      expect(events).toHaveLength(1);
    } finally {
      await factory.close();
    }
  });
});
