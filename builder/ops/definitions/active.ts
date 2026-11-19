/**
 * The active builder: the workflow the build server runs for every accepted job.
 *
 *   1. `server.builder` in the machine config, when the operator set it in a layer (a pin: its source is not built-in)
 *   2. agentics/builders/active.yml (`builder: <id>`), written by builder_activate and versioned like any definition
 *   3. the built-in default, `server.builder` of the built-in layer (supabase-api)
 *
 * E2: when the active builder does not load or fails validateBuilder at accept, the server uses the last valid version
 * from agentics/history/builder/<id>/ and warns (`definition.invalid`); with none the job is accepted and fails with
 * `builder definition invalid: ...` (the workflow run's own error). A history version runs from a copy at
 * agentics/builders/.fallback-<id>-<version12>/, beside the builders, so its relative imports resolve as they did
 * (gitignored). Its version is the Builder-Version its run records.
 */
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadBuilder } from "../../engine/load.ts";
import type { Builder } from "../../engine/types.ts";
import { contentHash } from "../../runtime/resolve.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import type { MachineConfig } from "../config.ts";
import { listHistory } from "./store.ts";

export const ACTIVE_FILE = "active.yml";

export interface ActiveBuilder {
  /** A builder id, or a path to a builder module (a pin may name one). */
  id: string;
  source: "config" | "active.yml" | "default";
  /** The config layer that pinned it. */
  layer?: string;
  /** Why active.yml was not used, when it exists and is not readable. */
  warning?: string;
}

/** active.yml's builder, null when there is none. Throws when it is there but broken. */
export function readActive(agentics = AGENTICS_DIR): string | null {
  const file = join(agentics, "builders", ACTIVE_FILE);
  if (!existsSync(file)) return null;
  const y = parseYaml(readFileSync(file, "utf8")) as { builder?: unknown } | null;
  if (!y || typeof y.builder !== "string" || !y.builder.trim()) throw new Error(`${file}: it holds builder: <builder id>`);
  return y.builder.trim();
}

/** Which builder is active, and why. */
export function activeBuilder(cfg: Pick<MachineConfig, "server" | "sources">, agentics = AGENTICS_DIR): ActiveBuilder {
  const layer = cfg.sources?.["server.builder"];
  if (layer && layer !== "built-in") return { id: cfg.server.builder, source: "config", layer };
  try {
    const id = readActive(agentics);
    if (id) return { id, source: "active.yml" };
  } catch (err) {
    return { id: cfg.server.builder, source: "default", warning: `active.yml ignored: ${(err as Error).message}` };
  }
  return { id: cfg.server.builder, source: "default" };
}

const isPath = (s: string) => isAbsolute(s) || s.startsWith("./") || s.startsWith("../") || /\.(m?ts|m?js)$/.test(s);

export interface LoadedActive extends ActiveBuilder {
  /** What the job's run spec names as its workflow: the id, or a module path (a pin by path, or a history copy). */
  workflow: string;
  /** The builder the job runs; null when no valid version exists (the run then fails with the definition's error). */
  builder: Builder | null;
  /** Why the active definition does not load. */
  error?: string;
  /** The history version used instead (E2). */
  fallback?: { version: string; savedAt: string; path: string };
}

/**
 * The active builder, loaded for a job (E2). An id names `<agentics>/builders/<id>/builder.ts`; the workflow stays the
 * id for the real tree, so runs and the feed name the builder as before.
 */
export async function loadActive(cfg: Pick<MachineConfig, "server" | "sources">, agentics = AGENTICS_DIR): Promise<LoadedActive> {
  const a = activeBuilder(cfg, agentics);
  const byPath = isPath(a.id);
  const module = byPath ? resolve(a.id) : join(agentics, "builders", a.id, "builder.ts");
  const workflow = byPath || resolve(agentics) !== resolve(AGENTICS_DIR) ? module : a.id;
  try {
    return { ...a, workflow, builder: await loadBuilder(module) };
  } catch (err) {
    const error = (err as Error).message;
    if (byPath) return { ...a, workflow, builder: null, error };
    for (const entry of listHistory(agentics, "builder", a.id)) {
      const dir = join(agentics, "builders", `.fallback-${a.id}-${entry.version.slice(0, 12)}`);
      try {
        if (!existsSync(dir) || contentHash(dir) !== entry.version) {
          const tmp = `${dir}.${process.pid}.tmp`;
          rmSync(tmp, { recursive: true, force: true });
          cpSync(entry.path, tmp, { recursive: true });
          rmSync(dir, { recursive: true, force: true });
          renameSync(tmp, dir);
        }
        const builder = await loadBuilder(join(dir, "builder.ts"));
        return { ...a, workflow: join(dir, "builder.ts"), builder, error, fallback: { version: entry.version, savedAt: entry.savedAt, path: dir } };
      } catch {
        /* that version does not load either: an older one */
      }
    }
    return { ...a, workflow, builder: null, error };
  }
}
