/**
 * CronStore (DESIGN 4.2, 9; spec 8.6): the `crons` and `cron_runs` tables of `tsf.sqlite` (migration 6), plus the one
 * place a cron expression is parsed (croner). Writes run inside the Service's `cron` mutex. The scheduler
 * (server/cron.ts) reads and writes through this class only.
 *
 * Run bookkeeping is keyed by `(cron_id, slot)`: a slot is recorded once (`INSERT OR IGNORE`), and the pi-durable
 * submission it stands for is keyed by the request id `cron:<cronId>:<slot>`, so even a crash between the submission and
 * the bookkeeping cannot run a slot twice. Agent-made entries get ids derived from the tool call id, so a replayed
 * `create_cron` finds its own row (D13).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";
import type { CronEntry, Origin } from "../shared/types.ts";
import { ServiceError } from "./errors.ts";
import { sha12 } from "./fsutil.ts";

export const MAX_CRON_NAME = 64;
export const MAX_CRON_EXPR = 120;
export const MAX_CRON_PROMPT = 20_000;
export const MAX_CRONS = 100;

export type CronRunStatus = NonNullable<CronEntry["lastStatus"]>;

export interface CronRow {
  readonly id: string;
  readonly name: string;
  readonly expr: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastSlot: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CronRunRow {
  readonly cronId: string;
  readonly slot: number;
  readonly manual: boolean;
  readonly catchUp: boolean;
  readonly requestId: string;
  readonly submissionId: number | null;
  readonly status: CronRunStatus;
  readonly createdAt: number;
}

interface CronSqlRow {
  id: string;
  name: string;
  expr: string;
  prompt: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_slot: number | null;
  created_at: number;
  updated_at: number;
}

interface RunSqlRow {
  cron_id: string;
  slot: number;
  manual: number;
  catch_up: number;
  request_id: string;
  submission_id: number | null;
  status: CronRunStatus;
  created_at: number;
}

const COLUMNS = "id, name, expr, prompt, enabled, next_run_at, last_run_at, last_slot, created_at, updated_at";
const RUN_COLUMNS = "cron_id, slot, manual, catch_up, request_id, submission_id, status, created_at";

const cronRow = (r: CronSqlRow): CronRow => ({
  id: r.id,
  name: r.name,
  expr: r.expr,
  prompt: r.prompt,
  enabled: r.enabled !== 0,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastSlot: r.last_slot,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const runRow = (r: RunSqlRow): CronRunRow => ({
  cronId: r.cron_id,
  slot: r.slot,
  manual: r.manual !== 0,
  catchUp: r.catch_up !== 0,
  requestId: r.request_id,
  submissionId: r.submission_id,
  status: r.status,
  createdAt: r.created_at,
});

// ---------------------------------------------------------------------------------------------------------------
// Expressions

/** Validates an expression (5 or 6 fields, croner syntax, server time zone) and returns it trimmed. */
export function checkExpr(raw: unknown): string {
  if (typeof raw !== "string") throw new ServiceError("invalid", "expr must be a string");
  const expr = raw.trim().replace(/\s+/g, " ");
  if (expr === "" || expr.length > MAX_CRON_EXPR) throw new ServiceError("invalid", `expr must be 1..${MAX_CRON_EXPR} characters`);
  const fields = expr.split(" ").length;
  if (expr.startsWith("@")) throw new ServiceError("invalid", "expr must have 5 or 6 fields, for example '*/5 * * * *'; nicknames such as @daily are not accepted");
  if (fields !== 5 && fields !== 6) throw new ServiceError("invalid", `expr must have 5 or 6 fields (minute hour day month weekday, optionally seconds first); got ${fields}`);
  try {
    if (new Cron(expr).nextRun() === null) throw new ServiceError("invalid", `expr "${expr}" never fires`);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError("invalid", `expr is not a valid cron expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return expr;
}

/** The first slot strictly after `afterMs` (ms epoch), or null when the expression never fires again. */
export function nextSlot(expr: string, afterMs: number): number | null {
  const next = new Cron(expr).nextRun(new Date(afterMs));
  return next === null ? null : next.getTime();
}

export function checkName(raw: unknown): string {
  if (typeof raw !== "string") throw new ServiceError("invalid", "name must be a string");
  const name = raw.trim();
  if (name === "" || name.length > MAX_CRON_NAME) throw new ServiceError("invalid", `name must be 1..${MAX_CRON_NAME} characters`);
  return name;
}

export function checkPrompt(raw: unknown): string {
  if (typeof raw !== "string") throw new ServiceError("invalid", "prompt must be a string");
  if (raw.trim() === "" || raw.length > MAX_CRON_PROMPT) throw new ServiceError("invalid", `prompt must be 1..${MAX_CRON_PROMPT} characters`);
  return raw;
}

/** A cron id: derived from the tool call id for the agent (replay finds its row), random otherwise. */
export function cronId(origin: Origin): string {
  return origin.callId !== undefined ? `c-${sha12(origin.callId).slice(0, 10)}` : `c-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Store

export interface NewCron {
  readonly id: string;
  readonly name: string;
  readonly expr: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
}

export interface CronPatch {
  readonly name?: string;
  readonly expr?: string;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly nextRunAt?: number | null;
}

export class CronStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): CronRow[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM crons ORDER BY created_at, name`).all() as unknown as CronSqlRow[]).map(cronRow);
  }

  get(id: string): CronRow | undefined {
    const r = this.#db.prepare(`SELECT ${COLUMNS} FROM crons WHERE id = ?`).get(id) as CronSqlRow | undefined;
    return r ? cronRow(r) : undefined;
  }

  getByName(name: string): CronRow | undefined {
    const r = this.#db.prepare(`SELECT ${COLUMNS} FROM crons WHERE name = ?`).get(name) as CronSqlRow | undefined;
    return r ? cronRow(r) : undefined;
  }

  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM crons").get() as { n: number }).n);
  }

  /**
   * Inserts the row. An existing id (a replayed agent create) returns that row with `created: false`; another row's
   * name is a `conflict`.
   */
  insert(c: NewCron): { row: CronRow; created: boolean } {
    const existing = this.get(c.id);
    if (existing) return { row: existing, created: false };
    const clash = this.getByName(c.name);
    if (clash) throw new ServiceError("conflict", `a cron named "${c.name}" already exists (${clash.id}); list_crons shows them`);
    const now = Date.now();
    this.#db
      .prepare(
        "INSERT INTO crons (id, name, expr, prompt, enabled, next_run_at, last_run_at, last_slot, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(c.id, c.name, c.expr, c.prompt, c.enabled ? 1 : 0, c.nextRunAt, now, now);
    return { row: this.get(c.id)!, created: true };
  }

  /** Applies the patch; undefined when the id does not exist. A name taken by another row is a `conflict`. */
  update(id: string, patch: CronPatch): CronRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    if (patch.name !== undefined && patch.name !== current.name) {
      const clash = this.getByName(patch.name);
      if (clash && clash.id !== id) throw new ServiceError("conflict", `a cron named "${patch.name}" already exists (${clash.id})`);
    }
    this.#db
      .prepare("UPDATE crons SET name = ?, expr = ?, prompt = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.name ?? current.name,
        patch.expr ?? current.expr,
        patch.prompt ?? current.prompt,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        patch.nextRunAt === undefined ? current.nextRunAt : patch.nextRunAt,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  setNext(id: string, nextRunAt: number | null): void {
    this.#db.prepare("UPDATE crons SET next_run_at = ? WHERE id = ?").run(nextRunAt, id);
  }

  /** Records that `slot` ran at `at`. */
  markFired(id: string, slot: number, at: number): void {
    this.#db.prepare("UPDATE crons SET last_run_at = ?, last_slot = ? WHERE id = ?").run(at, slot, id);
  }

  /** Removes the entry and its run rows. */
  delete(id: string): boolean {
    this.#db.prepare("DELETE FROM cron_runs WHERE cron_id = ?").run(id);
    return Number(this.#db.prepare("DELETE FROM crons WHERE id = ?").run(id).changes) > 0;
  }

  // --- runs ----------------------------------------------------------------------------------------------------

  hasRun(cronId: string, slot: number): boolean {
    return this.#db.prepare("SELECT 1 FROM cron_runs WHERE cron_id = ? AND slot = ?").get(cronId, slot) !== undefined;
  }

  /** Records the slot; false when `(cronId, slot)` already has a row. */
  recordRun(run: CronRunRow): boolean {
    const res = this.#db
      .prepare(`INSERT OR IGNORE INTO cron_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.cronId, run.slot, run.manual ? 1 : 0, run.catchUp ? 1 : 0, run.requestId, run.submissionId, run.status, run.createdAt);
    return Number(res.changes) > 0;
  }

  /** The run submitted under this request id, if any (a replayed `run_cron_now` finds its own run). */
  runByRequestId(requestId: string): CronRunRow | undefined {
    const r = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE request_id = ?`).get(requestId) as RunSqlRow | undefined;
    return r ? runRow(r) : undefined;
  }

  setRunStatus(cronId: string, slot: number, status: CronRunStatus): void {
    this.#db.prepare("UPDATE cron_runs SET status = ? WHERE cron_id = ? AND slot = ?").run(status, cronId, slot);
  }

  /** The newest run of an entry (by creation, then slot). */
  lastRun(cronId: string): CronRunRow | undefined {
    const r = this.#db
      .prepare(`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE cron_id = ? ORDER BY created_at DESC, slot DESC LIMIT 1`)
      .get(cronId) as RunSqlRow | undefined;
    return r ? runRow(r) : undefined;
  }

  /** Runs of an entry, newest first. */
  runs(cronId: string, limit = 50): CronRunRow[] {
    return (
      this.#db
        .prepare(`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE cron_id = ? ORDER BY created_at DESC, slot DESC LIMIT ?`)
        .all(cronId, limit) as unknown as RunSqlRow[]
    ).map(runRow);
  }

  /** Runs whose outcome is not known yet (queued or running), oldest first. */
  openRuns(): CronRunRow[] {
    return (
      this.#db
        .prepare(`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE status IN ('queued', 'running') ORDER BY created_at, slot`)
        .all() as unknown as RunSqlRow[]
    ).map(runRow);
  }

  /** The view the UI and the tools share. */
  entry(row: CronRow): CronEntry {
    return {
      id: row.id,
      name: row.name,
      expr: row.expr,
      prompt: row.prompt,
      enabled: row.enabled,
      nextRunAt: row.enabled ? row.nextRunAt : null,
      lastRunAt: row.lastRunAt,
      lastSlot: row.lastSlot,
      lastStatus: this.lastRun(row.id)?.status ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  entries(): CronEntry[] {
    return this.list().map((r) => this.entry(r));
  }
}
