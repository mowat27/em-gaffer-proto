/**
 * PromptStore (DESIGN 4.2, 9; spec 8.5): custom prompts (prompt layer 2) and runtime prompts (layer 4) in `tsf.sqlite`,
 * and the text the agent receives from them. Prompt layer 1 (the system prompt) is a setting and layer 3 (extension
 * sections) lives in the layers; this class owns only the two tables. Writes run inside the Service's `prompts` mutex.
 *
 * Agent-made rows get ids derived from the tool call id (`INSERT ... ON CONFLICT DO NOTHING`), so a replayed create
 * finds its own row instead of adding another (D13).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Actor, Origin } from "../shared/types.ts";
import { ServiceError } from "./errors.ts";
import { sha12 } from "./fsutil.ts";

/** The factory_harness default system prompt (prompt layer 1) as shipped, with its `{{placeholders}}`. */
export const DEFAULT_SYSTEM_PROMPT = readFileSync(
  new URL("../layers/factory_harness/system-prompt.md", import.meta.url),
  "utf8",
);

export const MAX_SYSTEM_PROMPT = 50_000;
export const MAX_CUSTOM_PROMPTS = 50;
export const MAX_CUSTOM_NAME = 64;
export const MAX_CUSTOM_TEXT = 20_000;
export const MAX_RUNTIME_PROMPTS = 50;
export const MAX_RUNTIME_TEXT = 10_000;

export interface CustomPrompt {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly enabled: boolean;
  /** Render order, ascending. */
  readonly position: number;
  readonly createdBy: Actor;
  readonly updatedAt: number;
}

export interface RuntimePrompt {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly createdBy: Actor;
}

interface CustomRow {
  id: string;
  name: string;
  text: string;
  enabled: number;
  position: number;
  created_by: Actor;
  updated_at: number;
}

interface RuntimeRow {
  id: string;
  text: string;
  created_at: number;
  created_by: Actor;
}

const customOf = (r: CustomRow): CustomPrompt => ({
  id: r.id,
  name: r.name,
  text: r.text,
  enabled: r.enabled !== 0,
  position: r.position,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
});

const runtimeOf = (r: RuntimeRow): RuntimePrompt => ({ id: r.id, text: r.text, createdAt: r.created_at, createdBy: r.created_by });

/** A row id: from the call id for the agent (stable across a replay), random otherwise. */
export function promptId(origin: Origin, prefix: string): string {
  return origin.callId !== undefined ? `${prefix}-${sha12(origin.callId).slice(0, 10)}` : `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** A prompt id with or without its `custom:` / `runtime:` prefix. */
export function bareId(id: unknown, prefix: "custom" | "runtime"): string {
  if (typeof id !== "string" || id === "") throw new ServiceError("invalid", "id is required");
  return id.startsWith(`${prefix}:`) ? id.slice(prefix.length + 1) : id;
}

export function checkCustomName(v: unknown): string {
  if (typeof v !== "string") throw new ServiceError("invalid", "name must be a string");
  const name = v.trim();
  if (name === "" || name.length > MAX_CUSTOM_NAME || /[\r\n<>]/.test(name)) {
    throw new ServiceError("invalid", `name must be 1..${MAX_CUSTOM_NAME} characters on one line, without < or >`);
  }
  return name;
}

export function checkText(v: unknown, max: number, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new ServiceError("invalid", `${what} must be a non-empty string`);
  if (v.length > max) throw new ServiceError("invalid", `${what} must be at most ${max} characters`);
  return v;
}

export class PromptStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // --- custom prompts (layer 2) ------------------------------------------------------------------------------

  customList(): CustomPrompt[] {
    const rows = this.#db.prepare("SELECT * FROM custom_prompts ORDER BY position, rowid").all() as unknown as CustomRow[];
    return rows.map(customOf);
  }

  customGet(id: string): CustomPrompt | undefined {
    const row = this.#db.prepare("SELECT * FROM custom_prompts WHERE id = ?").get(id) as CustomRow | undefined;
    return row ? customOf(row) : undefined;
  }

  /** Insert; a row with this id already there (a replayed agent call) is returned as it is. */
  customCreate(input: { id: string; name: string; text: string; enabled: boolean; by: Actor }): CustomPrompt {
    const existing = this.customGet(input.id);
    if (existing) return existing;
    if (this.customList().some((p) => p.name === input.name)) {
      throw new ServiceError("conflict", `a custom prompt named "${input.name}" already exists`);
    }
    if (this.customList().length >= MAX_CUSTOM_PROMPTS) {
      throw new ServiceError("conflict", `at most ${MAX_CUSTOM_PROMPTS} custom prompts; delete one first`);
    }
    const next = (this.#db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM custom_prompts").get() as { n: number }).n;
    this.#db
      .prepare(
        "INSERT INTO custom_prompts (id, name, text, enabled, position, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO NOTHING",
      )
      .run(input.id, input.name, input.text, input.enabled ? 1 : 0, next, input.by, Date.now());
    return this.customGet(input.id)!;
  }

  customUpdate(id: string, patch: { name?: string; text?: string; enabled?: boolean }): CustomPrompt {
    const before = this.customGet(id);
    if (!before) throw new ServiceError("not_found", `no such custom prompt: ${id}; list_prompts shows them`);
    const name = patch.name ?? before.name;
    if (name !== before.name && this.customList().some((p) => p.name === name)) {
      throw new ServiceError("conflict", `a custom prompt named "${name}" already exists`);
    }
    this.#db
      .prepare("UPDATE custom_prompts SET name = ?, text = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(name, patch.text ?? before.text, (patch.enabled ?? before.enabled) ? 1 : 0, Date.now(), id);
    return this.customGet(id)!;
  }

  customDelete(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM custom_prompts WHERE id = ?").run(id).changes) > 0;
  }

  /** The text of the enabled custom prompts for the `factory_harness-custom` section; "" when there are none. */
  customText(): string {
    return this.customList()
      .filter((p) => p.enabled)
      .map((p) => `## ${p.name}\n${p.text.trim()}`)
      .join("\n\n");
  }

  // --- runtime prompts (layer 4) -----------------------------------------------------------------------------

  runtimeList(): RuntimePrompt[] {
    const rows = this.#db.prepare("SELECT * FROM runtime_prompts ORDER BY created_at, rowid").all() as unknown as RuntimeRow[];
    return rows.map(runtimeOf);
  }

  runtimeGet(id: string): RuntimePrompt | undefined {
    const row = this.#db.prepare("SELECT * FROM runtime_prompts WHERE id = ?").get(id) as RuntimeRow | undefined;
    return row ? runtimeOf(row) : undefined;
  }

  /** Insert; a row with this id already there (a replayed agent call) is returned as it is. */
  runtimeAppend(input: { id: string; text: string; by: Actor }): RuntimePrompt {
    const existing = this.runtimeGet(input.id);
    if (existing) return existing;
    if (this.runtimeList().length >= MAX_RUNTIME_PROMPTS) {
      throw new ServiceError("conflict", `at most ${MAX_RUNTIME_PROMPTS} runtime prompts; remove or clear some first`);
    }
    this.#db
      .prepare("INSERT INTO runtime_prompts (id, text, created_at, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(input.id, input.text, Date.now(), input.by);
    return this.runtimeGet(input.id)!;
  }

  runtimeRemove(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM runtime_prompts WHERE id = ?").run(id).changes) > 0;
  }

  runtimeClear(): number {
    return Number(this.#db.prepare("DELETE FROM runtime_prompts").run().changes);
  }

  /** What `configure({ instructions })` receives: every runtime prompt, oldest first; null when there are none. */
  runtimeText(): string | null {
    const all = this.runtimeList();
    return all.length === 0 ? null : all.map((p) => p.text.trim()).join("\n\n");
  }
}

/** The read side a layer's section needs (LayerContext.prompts). */
export interface PromptReader {
  customText(): string;
}
