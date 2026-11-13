import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDb, type AppDb } from "../../src/core/db.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const open: AppDb[] = [];
async function fresh(): Promise<{ db: AppDb; file: string }> {
  const file = join(await tmpDir("tsf-db"), "data", "tsf.sqlite");
  const db = openAppDb(file);
  open.push(db);
  return { db, file };
}

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await cleanupTmp();
});

function pragma(db: AppDb, name: string): unknown {
  const row = db.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

describe("openAppDb", () => {
  it("creates the parent folder, turns WAL on and sets the pragmas", async () => {
    const { db } = await fresh();
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(5000);
  });

  it("applies the built-in migrations once: tables exist and schema_version is the latest (6)", async () => {
    const { db, file } = await fresh();
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["meta", "settings", "model_cache", "runs", "run_tools", "ui_config", "themes", "custom_prompts", "runtime_prompts", "crons", "cron_runs"]));
    db.close();
    const again = openAppDb(file);
    open.push(again);
    const row = again.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row.value).toBe("6");
  });

  it("migrate is idempotent: a version already applied is skipped, a new one runs once", async () => {
    const { db } = await fresh();
    db.migrate(1, "THIS IS NOT SQL");
    db.migrate(2, "THIS IS NOT SQL");
    db.migrate(98, "CREATE TABLE t98 (id INTEGER PRIMARY KEY)");
    db.migrate(98, "CREATE TABLE t98 (id INTEGER PRIMARY KEY)");
    const row = db.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row.value).toBe("98");
  });

  it("rolls a failing migration back and leaves the version alone", async () => {
    const { db } = await fresh();
    expect(() => db.migrate(99, "CREATE TABLE half (id INTEGER); NOT SQL")).toThrow();
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").all() as unknown[]).length;
    expect(tables).toBe(0);
    const row = db.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row.value).toBe("6");
  });
});

describe("settings repository", () => {
  it("stored() is empty on a new database (no defaults are written)", async () => {
    const { db } = await fresh();
    expect(db.settings.stored()).toEqual({});
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n).toBe(0);
  });

  it("round-trips values and keeps only written keys", async () => {
    const { db, file } = await fresh();
    db.settings.set("thinkingLevel", "high");
    db.settings.set("model", { provider: "openrouter", modelId: "x/y" });
    db.settings.set("maxTurns", null);
    db.settings.set("layerToggles", { coding_tools: false });
    expect(db.settings.stored()).toEqual({
      thinkingLevel: "high",
      model: { provider: "openrouter", modelId: "x/y" },
      maxTurns: null,
      layerToggles: { coding_tools: false },
    });
    db.close();
    const again = openAppDb(file);
    open.push(again);
    expect(again.settings.stored().thinkingLevel).toBe("high");
  });

  it("set(key, undefined) removes the key", async () => {
    const { db } = await fresh();
    db.settings.set("thinkingLevel", "high");
    db.settings.set("thinkingLevel", undefined);
    expect(db.settings.stored()).toEqual({});
  });

  it("keeps non-config keys out of stored() but readable through getRaw", async () => {
    const { db } = await fresh();
    db.settings.setRaw("selection", JSON.stringify({ path: "A.md", by: "ui", at: 1 }));
    expect(db.settings.stored()).toEqual({});
    expect(JSON.parse(db.settings.getRaw("selection")!)).toEqual({ path: "A.md", by: "ui", at: 1 });
    expect(db.settings.getRaw("nothing")).toBeUndefined();
  });

  it("onChange fires after set and setRaw, stops after unsubscribe, and survives a throwing listener", async () => {
    const { db } = await fresh();
    let calls = 0;
    db.settings.onChange(() => {
      throw new Error("boom");
    });
    const off = db.settings.onChange(() => calls++);
    db.settings.set("thinkingLevel", "low");
    db.settings.setRaw("selection", "null");
    expect(calls).toBe(2);
    off();
    db.settings.set("thinkingLevel", "high");
    expect(calls).toBe(2);
  });
});

describe("model cache", () => {
  it("stores and replaces one body per provider", async () => {
    const { db } = await fresh();
    expect(db.modelCache.get("openrouter")).toBeUndefined();
    db.modelCache.put("openrouter", '{"data":[]}', 100);
    expect(db.modelCache.get("openrouter")).toEqual({ fetchedAt: 100, body: '{"data":[]}' });
    db.modelCache.put("openrouter", '{"data":[1]}', 200);
    expect(db.modelCache.get("openrouter")).toEqual({ fetchedAt: 200, body: '{"data":[1]}' });
  });
});
