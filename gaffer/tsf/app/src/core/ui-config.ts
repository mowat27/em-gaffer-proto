/**
 * The UI config document (DESIGN 4.4): one row in `tsf.sqlite` `ui_config` (migration 3), cached in memory so the
 * snapshot reads it synchronously. Writes take a JSON Merge Patch (RFC 7386: objects merge, arrays replace, null
 * deletes), validate the merged document with the compiled schema plus the semantic checks, bump the version and
 * store it. The Service serialises writes on the `ui_config` mutex and publishes `ui_config.changed`.
 */
import type { UpdateUiConfigInput } from "./service-api.ts";
import { DEFAULT_UI_CONFIG, type Json, type UiConfig } from "../shared/types.ts";
import { checkUiConfig, type UiConfigCheckContext } from "../shared/ui-config-schema.ts";
import type { AppDb } from "./db.ts";
import { ServiceError } from "./errors.ts";

type JsonObject = { [key: string]: Json };

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** RFC 7386 JSON Merge Patch. Never modifies its inputs. */
export function mergePatch(target: Json | undefined, patch: Json): Json {
  if (!isObject(patch)) return patch;
  const out: JsonObject = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ServiceError("invalid", `patch key ${key} is not allowed`);
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

function withoutVersion(config: UiConfig): JsonObject {
  const { version: _version, ...rest } = config;
  return rest as unknown as JsonObject;
}

export interface UiConfigStoreOptions {
  /** Widget contributions and theme names for the semantic checks on writes (DESIGN 4.4). */
  context?: () => UiConfigCheckContext;
}

export class UiConfigStore {
  private readonly db: AppDb;
  private readonly context: () => UiConfigCheckContext;
  private current: UiConfig;

  constructor(db: AppDb, opts: UiConfigStoreOptions = {}) {
    this.db = db;
    this.context = opts.context ?? (() => ({}));
    this.current = this.load();
  }

  /** The current document (DEFAULT_UI_CONFIG until the first write). */
  get(): UiConfig {
    return this.current;
  }

  /**
   * Merge `patch` into the current document, validate, bump the version and store. A patch that changes nothing
   * returns the current document unchanged (same version), so the caller publishes nothing.
   * Throws `ServiceError("conflict")` for a stale `baseVersion` and `ServiceError("invalid", <first problem>)`.
   */
  update(input: UpdateUiConfigInput): UiConfig {
    const patch: unknown = input.patch;
    if (!isObject(patch)) throw new ServiceError("invalid", "patch must be a JSON object");
    if ("version" in patch) throw new ServiceError("invalid", "/version: the version is set by the factory; send baseVersion instead");
    if ("theme" in patch) throw new ServiceError("invalid", "/theme: the theme changes only through set_theme (use set_theme)");
    if (input.baseVersion !== undefined) {
      if (!Number.isInteger(input.baseVersion)) throw new ServiceError("invalid", "baseVersion must be an integer");
      if (input.baseVersion !== this.current.version) {
        throw new ServiceError(
          "conflict",
          `the UI config is at version ${this.current.version}, not ${input.baseVersion}; read it again and retry`,
        );
      }
    }
    const before = withoutVersion(this.current);
    const merged = mergePatch(before, patch) as JsonObject;
    return this.commit(before, merged);
  }

  /**
   * The one writer of `theme` (DESIGN 4.4: Service.setTheme calls it, so the CSS follows). Same rules as `update`: a
   * no-op returns the current document, an unknown theme name is `invalid`.
   */
  setTheme(theme: { readonly name: string; readonly mode?: UiConfig["theme"]["mode"] }): UiConfig {
    const before = withoutVersion(this.current);
    const merged: JsonObject = { ...before, theme: { ...this.current.theme, ...theme } };
    return this.commit(before, merged);
  }

  private commit(before: JsonObject, merged: JsonObject): UiConfig {
    if (JSON.stringify(merged) === JSON.stringify(before)) return this.current;
    const next = { ...merged, version: this.current.version + 1 };
    const problems = checkUiConfig(next, this.context());
    if (problems.length > 0) throw new ServiceError("invalid", problems[0]!);
    const config = next as unknown as UiConfig;
    this.db.db
      .prepare(
        "INSERT INTO ui_config (id, version, doc, updated_at) VALUES (1, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET version = excluded.version, doc = excluded.doc, updated_at = excluded.updated_at",
      )
      .run(config.version, JSON.stringify(config), Date.now());
    this.current = config;
    return config;
  }

  /**
   * The stored document laid over the defaults (so a key added in a later phase gets its default), with the stored
   * version. A row that no longer validates falls back to the defaults at the stored version, so versions keep rising.
   */
  private load(): UiConfig {
    const row = this.db.db.prepare("SELECT version, doc FROM ui_config WHERE id = 1").get() as
      | { version: number; doc: string }
      | undefined;
    if (!row) return DEFAULT_UI_CONFIG;
    let stored: Json;
    try {
      stored = JSON.parse(row.doc) as Json;
    } catch {
      return { ...DEFAULT_UI_CONFIG, version: row.version };
    }
    if (!isObject(stored)) return { ...DEFAULT_UI_CONFIG, version: row.version };
    const { version: _v, ...rest } = stored;
    let merged: Json;
    try {
      merged = mergePatch(withoutVersion(DEFAULT_UI_CONFIG), rest);
    } catch {
      return { ...DEFAULT_UI_CONFIG, version: row.version };
    }
    const doc = { ...(merged as JsonObject), version: row.version };
    return checkUiConfig(doc).length === 0 ? (doc as unknown as UiConfig) : { ...DEFAULT_UI_CONFIG, version: row.version };
  }
}
