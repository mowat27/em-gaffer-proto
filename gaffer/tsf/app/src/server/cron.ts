/**
 * CronScheduler (DESIGN 9, spec 8.6). One timer per enabled entry, armed for the stored `next_run_at`; croner computes
 * the slots (`nextSlot`). Starts inside `ServiceRuntime.start()` and stops first in `close()`.
 *
 * - Run key: `(cron_id, slot)`. A fire submits the prompt with request id `cron:<cronId>:<slot>`, which pi-durable
 *   dedupes, and records the slot in `cron_runs` (primary key `(cron_id, slot)`); a slot that already has a row is never
 *   submitted again, so a restart cannot run a slot twice (the DNA reference's slot-id idea, DESIGN 14).
 * - Queueing: the submit is `whenBusy: "followUp"` (the caller's `submit`), so a fire during a run waits behind it.
 * - Boot: an enabled entry whose stored `next_run_at` is already in the past missed at least one slot: it runs once
 *   (keyed to that missed slot, `catchUp: true`), then continues on schedule from now. No backlog replay.
 * - A timer that wakes late (a sleeping laptop) fires the scheduled slot once and schedules the next slot after now.
 *
 * All state changes run inside `deps.lock` (the Service's `cron` mutex), so a fire and an edit never interleave.
 * `clock` is injectable: tests drive a fake one and never wait.
 */
import { randomUUID } from "node:crypto";
import { ServiceError } from "../core/errors.ts";
import { nextSlot, type CronRow, type CronRunStatus, type CronStore } from "../core/cron-store.ts";
import type { Logger } from "../core/log.ts";
import type { CronRunResult } from "../core/service-api.ts";
import type { CronEntryData } from "../shared/types.ts";

export interface CronClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: CronClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** One timer wait never exceeds this (setTimeout's limit is 2^31 ms); a longer wait re-arms on waking. */
const MAX_WAIT_MS = 60 * 60 * 1000;

export interface FireJob {
  readonly cronId: string;
  readonly name: string;
  readonly prompt: string;
  readonly requestId: string;
  readonly data: CronEntryData;
}

export interface FireResult {
  readonly submissionId: number;
  readonly status: CronRunStatus;
}

export interface CronFired {
  readonly cronId: string;
  readonly name: string;
  readonly slot: number;
  readonly submissionId: number;
  readonly catchUp: boolean;
}

export interface CronSchedulerDeps {
  readonly store: CronStore;
  readonly log: Logger;
  /** Admission of the cron prompt into the main conversation (`whenBusy: "followUp"`, entry `tsf.cron`). */
  submit(job: FireJob): Promise<FireResult>;
  /** Resolves when the submission is settled: `answered` or `failed`. Optional (a stub agent has none). */
  settle?(submissionId: number): Promise<CronRunStatus>;
  /** The Service's `cron` mutex. */
  lock<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Entries changed (next run, last run, status): the Service publishes `cron.changed`. */
  onChange(): void;
  onFired(event: CronFired): void;
  clock?: CronClock;
}

export class CronScheduler {
  readonly #deps: CronSchedulerDeps;
  readonly #clock: CronClock;
  readonly #timers = new Map<string, unknown>();
  #closed = false;
  #started = false;

  constructor(deps: CronSchedulerDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? realClock;
  }

  /** Catches up the entries that missed a slot (once each), arms every enabled entry and reattaches open runs. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    await this.#deps.lock(async () => {
      const now = this.#clock.now();
      for (const row of this.#deps.store.list()) {
        if (!row.enabled) continue;
        if (row.nextRunAt !== null && row.nextRunAt <= now) {
          await this.#fireScheduled(row, row.nextRunAt, now, true);
        } else if (row.nextRunAt === null) {
          this.#deps.store.setNext(row.id, nextSlot(row.expr, now));
        }
      }
      for (const run of this.#deps.store.openRuns()) {
        if (run.submissionId !== null) this.#track(run.cronId, run.slot, run.submissionId);
      }
      this.armAll();
    });
    this.#deps.onChange();
  }

  /** Stops every timer. A fire already admitted finishes; nothing new starts. */
  close(): void {
    this.#closed = true;
    for (const h of this.#timers.values()) this.#clock.clearTimeout(h);
    this.#timers.clear();
  }

  /** The slot an entry would first fire after `afterMs`, from its expression (null: never). */
  nextAfter(expr: string, afterMs: number = this.#clock.now()): number | null {
    return nextSlot(expr, afterMs);
  }

  /** Arms (or disarms) one entry from its stored row. Call after the row changed; the caller holds the lock. */
  arm(id: string): void {
    const old = this.#timers.get(id);
    if (old !== undefined) {
      this.#clock.clearTimeout(old);
      this.#timers.delete(id);
    }
    if (this.#closed || !this.#started) return;
    const row = this.#deps.store.get(id);
    if (!row || !row.enabled || row.nextRunAt === null) return;
    const wait = Math.min(Math.max(0, row.nextRunAt - this.#clock.now()), MAX_WAIT_MS);
    this.#timers.set(
      id,
      this.#clock.setTimeout(() => {
        this.#timers.delete(id);
        void this.#deps.lock(() => this.#wake(id)).catch((err: unknown) => this.#deps.log.error("cron.tick_failed", { cronId: id, error: err }));
      }, wait),
    );
  }

  armAll(): void {
    for (const row of this.#deps.store.list()) this.arm(row.id);
  }

  disarm(id: string): void {
    const h = this.#timers.get(id);
    if (h !== undefined) this.#clock.clearTimeout(h);
    this.#timers.delete(id);
  }

  /**
   * Runs an entry now, enabled or not, without touching its schedule. `callId` (an agent call) makes the request id
   * `cron-now:<cronId>:<callId>`, so a replayed call finds its own run. Call inside the lock.
   */
  async runNow(row: CronRow, callId: string | undefined): Promise<CronRunResult> {
    const key = callId ?? randomUUID();
    const requestId = `cron-now:${row.id}:${key}`;
    const known = this.#deps.store.runByRequestId(requestId);
    if (known) {
      return { cronId: row.id, name: row.name, slot: known.slot, manual: true, catchUp: false, submissionId: known.submissionId ?? 0, status: known.status };
    }
    let slot = this.#clock.now();
    while (this.#deps.store.hasRun(row.id, slot)) slot += 1;
    const result = await this.#submit(row, slot, requestId, { manual: true, catchUp: false });
    this.#deps.onChange();
    return { cronId: row.id, name: row.name, slot, manual: true, catchUp: false, ...result };
  }

  // --- internals -----------------------------------------------------------------------------------------------

  /** A timer woke: fire the scheduled slot when it is due, then schedule the next one after now. Inside the lock. */
  async #wake(id: string): Promise<void> {
    if (this.#closed) return;
    const row = this.#deps.store.get(id);
    if (!row || !row.enabled || row.nextRunAt === null) return;
    const now = this.#clock.now();
    if (row.nextRunAt > now) {
      this.arm(id);
      return;
    }
    await this.#fireScheduled(row, row.nextRunAt, now, false);
    this.arm(id);
    this.#deps.onChange();
  }

  /** Fires `slot` (unless it already ran), then stores the next slot after `now`. Inside the lock. */
  async #fireScheduled(row: CronRow, slot: number, now: number, catchUp: boolean): Promise<void> {
    const store = this.#deps.store;
    if (store.hasRun(row.id, slot)) {
      this.#deps.log.info("cron.slot_already_ran", { cronId: row.id, slot });
    } else {
      try {
        await this.#submit(row, slot, `cron:${row.id}:${slot}`, { manual: false, catchUp });
      } catch (err) {
        // The slot is recorded as failed so it is never retried into a loop; the schedule moves on.
        this.#deps.log.error("cron.fire_failed", { cronId: row.id, slot, error: err });
        store.recordRun({ cronId: row.id, slot, manual: false, catchUp, requestId: `cron:${row.id}:${slot}`, submissionId: null, status: "failed", createdAt: now });
        store.markFired(row.id, slot, now);
      }
    }
    store.setNext(row.id, nextSlot(row.expr, now));
  }

  async #submit(row: CronRow, slot: number, requestId: string, flags: { manual: boolean; catchUp: boolean }): Promise<FireResult> {
    const store = this.#deps.store;
    const data: CronEntryData = { cronId: row.id, name: row.name, slot, catchUp: flags.catchUp, manual: flags.manual };
    const result = await this.#deps.submit({ cronId: row.id, name: row.name, prompt: row.prompt, requestId, data });
    const at = this.#clock.now();
    store.recordRun({ cronId: row.id, slot, manual: flags.manual, catchUp: flags.catchUp, requestId, submissionId: result.submissionId, status: result.status, createdAt: at });
    store.markFired(row.id, slot, at);
    this.#deps.log.info("cron.fired", { cronId: row.id, name: row.name, slot, catchUp: flags.catchUp, manual: flags.manual, submissionId: result.submissionId });
    this.#deps.onFired({ cronId: row.id, name: row.name, slot, submissionId: result.submissionId, catchUp: flags.catchUp });
    this.#track(row.id, slot, result.submissionId);
    return result;
  }

  /** Follows a submission to its outcome in the background and records it. */
  #track(cronId: string, slot: number, submissionId: number): void {
    const settle = this.#deps.settle;
    if (!settle) return;
    void settle(submissionId)
      .then((status) => {
        if (this.#closed) return;
        this.#deps.store.setRunStatus(cronId, slot, status);
        this.#deps.onChange();
      })
      .catch((err: unknown) => {
        if (!this.#closed) this.#deps.log.warn("cron.settle_failed", { cronId, slot, submissionId, error: err });
      });
  }
}

/** `not_found` for an unknown id; shared by the Service methods. */
export function requireCron(store: CronStore, id: unknown): CronRow {
  if (typeof id !== "string" || id === "") throw new ServiceError("invalid", "id must be a cron id");
  const row = store.get(id);
  if (!row) throw new ServiceError("not_found", `no such cron: ${id}; list_crons shows them`);
  return row;
}
