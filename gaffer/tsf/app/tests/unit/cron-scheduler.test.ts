/**
 * CronStore and CronScheduler (DESIGN 9, spec 8.6) on a fake clock: slots fire once, a restart never repeats a slot,
 * boot catch-up runs a missed entry once, a late timer fires once, queueing and outcomes are recorded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { checkExpr, CronStore, nextSlot, type CronRunStatus } from "../../src/core/cron-store.ts";
import { openAppDb, type AppDb } from "../../src/core/db.ts";
import { ServiceError } from "../../src/core/errors.ts";
import { silentLogger } from "../../src/core/log.ts";
import { KeyedMutex } from "../../src/core/mutex.ts";
import { CronScheduler, type CronClock, type CronFired, type FireJob } from "../../src/server/cron.ts";

const T0 = Date.UTC(2026, 10, 3, 12, 0, 30);
const MIN = 60_000;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

class FakeClock implements CronClock {
  time: number;
  timers: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;
  constructor(start: number) {
    this.time = start;
  }
  now = (): number => this.time;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const t = { at: this.time + ms, fn, id: ++this.#id };
    this.timers.push(t);
    return t.id;
  };
  clearTimeout = (h: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  /** Moves time forward, firing each timer at its own time. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
      await flush();
    }
    this.time = target;
  }
  /** Jumps over `ms` at once (a sleeping laptop), then fires what is due. */
  async jump(ms: number): Promise<void> {
    this.time += ms;
    for (const t of this.timers.filter((x) => x.at <= this.time)) {
      this.timers = this.timers.filter((x) => x !== t);
      t.fn();
    }
    await flush();
  }
}

interface Rig {
  db: AppDb;
  store: CronStore;
  clock: FakeClock;
  jobs: FireJob[];
  fired: CronFired[];
  changes: { n: number };
  settle: Map<number, (s: CronRunStatus) => void>;
  make(opts?: { submitStatus?: CronRunStatus; failSubmit?: boolean }): CronScheduler;
}

const open: AppDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function rig(start = T0, existing?: { db: AppDb }): Rig {
  const db = existing?.db ?? openAppDb(":memory:");
  if (!existing) open.push(db);
  const store = new CronStore(db.db);
  const clock = new FakeClock(start);
  const mutex = new KeyedMutex();
  const jobs: FireJob[] = [];
  const fired: CronFired[] = [];
  const changes = { n: 0 };
  const settle = new Map<number, (s: CronRunStatus) => void>();
  let nextSubmission = 100;
  return {
    db,
    store,
    clock,
    jobs,
    fired,
    changes,
    settle,
    make(opts = {}) {
      return new CronScheduler({
        store,
        log: silentLogger,
        clock,
        lock: (fn) => mutex.run("cron", fn),
        onChange: () => void changes.n++,
        onFired: (e) => void fired.push(e),
        submit: async (job) => {
          if (opts.failSubmit) throw new Error("admission failed");
          jobs.push(job);
          return { submissionId: nextSubmission++, status: opts.submitStatus ?? "running" };
        },
        settle: (id) => new Promise<CronRunStatus>((resolve) => settle.set(id, resolve)),
      });
    },
  };
}

const create = (r: Rig, name: string, expr: string, enabled = true) =>
  r.store.insert({ id: `c-${name}`, name, expr, prompt: `do ${name}`, enabled, nextRunAt: enabled ? nextSlot(expr, r.clock.now()) : null }).row;

describe("cron expressions", () => {
  it("accepts 5 and 6 fields and rejects the rest", () => {
    expect(checkExpr(" */5  * * * * ")).toBe("*/5 * * * *");
    expect(checkExpr("*/10 * * * * *")).toBe("*/10 * * * * *");
    for (const bad of ["", "not a cron", "* * * *", "@daily", "61 * * * *", "0 0 31 2 *", 5]) {
      expect(() => checkExpr(bad), String(bad)).toThrow(ServiceError);
    }
  });

  it("nextSlot is strictly after the given time", () => {
    const slot = Date.UTC(2026, 10, 3, 12, 1, 0);
    expect(nextSlot("* * * * *", T0)).toBe(slot);
    expect(nextSlot("* * * * *", slot)).toBe(slot + MIN);
  });
});

describe("CronStore", () => {
  it("keys an agent create on its id and refuses a name taken by another row", () => {
    const r = rig();
    const a = r.store.insert({ id: "c-1", name: "A", expr: "* * * * *", prompt: "p", enabled: true, nextRunAt: 1 });
    expect(a.created).toBe(true);
    const again = r.store.insert({ id: "c-1", name: "A", expr: "* * * * *", prompt: "p", enabled: true, nextRunAt: 1 });
    expect(again).toMatchObject({ created: false, row: { id: "c-1" } });
    expect(() => r.store.insert({ id: "c-2", name: "A", expr: "* * * * *", prompt: "q", enabled: true, nextRunAt: 1 })).toThrow(/already exists/);
    expect(r.store.list()).toHaveLength(1);
  });

  it("records a slot once and deletes an entry with its runs", () => {
    const r = rig();
    create(r, "A", "* * * * *");
    const run = { cronId: "c-A", slot: 5, manual: false, catchUp: false, requestId: "cron:c-A:5", submissionId: 1, status: "queued" as const, createdAt: 9 };
    expect(r.store.recordRun(run)).toBe(true);
    expect(r.store.recordRun({ ...run, submissionId: 2 })).toBe(false);
    expect(r.store.lastRun("c-A")).toMatchObject({ submissionId: 1 });
    expect(r.store.delete("c-A")).toBe(true);
    expect(r.store.hasRun("c-A", 5)).toBe(false);
  });
});

describe("CronScheduler", () => {
  it("fires each slot once with the run key, the entry data and the slot as next_run_at", async () => {
    const r = rig();
    const row = create(r, "Pages", "* * * * *");
    const s = r.make();
    await s.start();
    expect(r.jobs).toHaveLength(0);
    const slot1 = Date.UTC(2026, 10, 3, 12, 1, 0);
    await r.clock.advance(29_000);
    expect(r.jobs).toHaveLength(0);
    await r.clock.advance(1_000);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({
      cronId: row.id,
      prompt: "do Pages",
      requestId: `cron:${row.id}:${slot1}`,
      data: { cronId: row.id, name: "Pages", slot: slot1, catchUp: false, manual: false },
    });
    expect(r.store.get(row.id)).toMatchObject({ nextRunAt: slot1 + MIN, lastSlot: slot1 });
    await r.clock.advance(MIN);
    await r.clock.advance(MIN);
    expect(r.jobs.map((j) => j.data.slot)).toEqual([slot1, slot1 + MIN, slot1 + 2 * MIN]);
    expect(r.fired.map((f) => f.slot)).toEqual([slot1, slot1 + MIN, slot1 + 2 * MIN]);
    expect(r.store.runs(row.id)).toHaveLength(3);
    s.close();
  });

  it("a restart never runs a slot twice: a recorded slot is skipped, an unrecorded one is the single catch-up", async () => {
    const r = rig();
    const row = create(r, "Pages", "* * * * *");
    const first = r.make();
    await first.start();
    await r.clock.advance(30_000);
    expect(r.jobs).toHaveLength(1);
    const slot1 = r.jobs[0]!.data.slot;
    first.close();

    // Crash between the fire and the schedule update: next_run_at still names the slot that ran.
    r.store.setNext(row.id, slot1);
    const second = r.make();
    await second.start();
    expect(r.jobs).toHaveLength(1);
    expect(r.store.get(row.id)!.nextRunAt).toBe(slot1 + MIN);
    // The next slot then fires once, with the normal key.
    await r.clock.advance(MIN);
    expect(r.jobs.map((j) => j.requestId)).toEqual([`cron:${row.id}:${slot1}`, `cron:${row.id}:${slot1 + MIN}`]);
    second.close();
  });

  it("on boot an entry that missed slots runs once, keyed to the missed slot, then continues on schedule", async () => {
    const r = rig();
    const row = create(r, "Pages", "* * * * *");
    const missed = r.store.get(row.id)!.nextRunAt!;
    // The server was down for ten minutes.
    r.clock.time = T0 + 10 * MIN;
    const s = r.make();
    await s.start();
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ requestId: `cron:${row.id}:${missed}`, data: { slot: missed, catchUp: true, manual: false } });
    expect(r.fired[0]).toMatchObject({ slot: missed, catchUp: true });
    const next = r.store.get(row.id)!.nextRunAt!;
    expect(next).toBeGreaterThan(r.clock.now());
    expect(next - r.clock.now()).toBeLessThanOrEqual(MIN);
    await r.clock.advance(next - r.clock.now());
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[1]!.data).toMatchObject({ slot: next, catchUp: false });
    s.close();
  });

  it("an entry that missed nothing, a disabled one and a closed scheduler do not run", async () => {
    const r = rig();
    create(r, "Fine", "0 0 1 1 *");
    create(r, "Off", "* * * * *", false);
    const s = r.make();
    await s.start();
    await r.clock.advance(5 * MIN);
    expect(r.jobs).toHaveLength(0);
    s.close();
    const live = r.store.insert({ id: "c-live", name: "Live", expr: "* * * * *", prompt: "p", enabled: true, nextRunAt: nextSlot("* * * * *", r.clock.now()) }).row;
    s.arm(live.id);
    await r.clock.advance(5 * MIN);
    expect(r.jobs).toHaveLength(0);
  });

  it("a timer that wakes late fires its slot once and schedules the next one after now", async () => {
    const r = rig();
    const row = create(r, "Pages", "* * * * *");
    const s = r.make();
    await s.start();
    await r.clock.jump(30 * MIN);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.data.catchUp).toBe(false);
    const next = r.store.get(row.id)!.nextRunAt!;
    expect(next).toBeGreaterThan(r.clock.now());
    await r.clock.advance(next - r.clock.now());
    expect(r.jobs).toHaveLength(2);
    s.close();
  });

  it("a fire while the agent is busy is queued; the outcome is recorded when it settles", async () => {
    const r = rig();
    const row = create(r, "Pages", "* * * * *");
    const s = r.make({ submitStatus: "queued" });
    await s.start();
    await r.clock.advance(30_000);
    expect(r.store.entry(r.store.get(row.id)!).lastStatus).toBe("queued");
    const changed = r.changes.n;
    r.settle.get(100)!("answered");
    await flush();
    expect(r.store.entry(r.store.get(row.id)!).lastStatus).toBe("answered");
    expect(r.changes.n).toBeGreaterThan(changed);
    s.close();
  });

  it("boot reattaches the runs whose outcome was still open", async () => {
    const r = rig();
    const row = create(r, "Pages", "0 0 1 1 *");
    r.store.recordRun({ cronId: row.id, slot: 7, manual: false, catchUp: false, requestId: `cron:${row.id}:7`, submissionId: 42, status: "queued", createdAt: 1 });
    const s = r.make();
    await s.start();
    r.settle.get(42)!("failed");
    await flush();
    expect(r.store.lastRun(row.id)!.status).toBe("failed");
    s.close();
  });

  it("a failed admission is recorded as a failed slot and the schedule moves on", async () => {
    const r = rig();
    const row = create(r, "Pages", "* * * * *");
    const s = r.make({ failSubmit: true });
    await s.start();
    await r.clock.advance(30_000);
    const slot1 = Date.UTC(2026, 10, 3, 12, 1, 0);
    expect(r.store.lastRun(row.id)).toMatchObject({ slot: slot1, status: "failed", submissionId: null });
    expect(r.store.get(row.id)!.nextRunAt).toBe(slot1 + MIN);
    s.close();
  });

  it("run now keeps the schedule and a replayed call finds its own run", async () => {
    const r = rig();
    const row = create(r, "Pages", "0 0 1 1 *");
    const before = r.store.get(row.id)!.nextRunAt;
    const s = r.make();
    await s.start();
    const a = await s.runNow(row, "call-1");
    const b = await s.runNow(row, "call-1");
    expect(b).toMatchObject({ slot: a.slot, submissionId: a.submissionId });
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ requestId: `cron-now:${row.id}:call-1`, data: { manual: true, catchUp: false } });
    await s.runNow(row, undefined);
    expect(r.jobs).toHaveLength(2);
    expect(r.store.get(row.id)!.nextRunAt).toBe(before);
    s.close();
  });
});
