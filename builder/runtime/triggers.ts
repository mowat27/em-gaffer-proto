/**
 * Triggers (design section 10, D17): what starts a turn in a durable run besides a message. In agent.yml:
 *
 *   triggers:
 *     - { on: job.failed }                                           a server job failed
 *     - { cron: daily | hourly | "<5-field cron>", prompt: "<text>" }  a schedule, and what it says
 *
 * A durable run of the agent arms them from its own run process (runtime/main.ts, armTriggers); a run in another mode
 * ignores them (runtime/resolve.ts pins them only for durable runs). The builder never calls the agent: the run
 * watches files. Each firing is a user message through the run's MessageDesk (runtime/messaging.ts), so it starts a
 * turn, or is queued as a follow-up while a turn runs, and is journaled `trigger.fired` with pi's answer.
 *
 * job.failed: the run follows the machine feed (runtime/feed.ts) for `job.result` with outcome failed, which the
 * server writes once per job. The turn gets the job, its workflow run id and the reason. The last failure handed over
 * is kept in the agent's state/triggers.json, so a run that starts again (a restart, the systemd unit coming back)
 * first catches up on the failures since then, oldest first (E20): at most CATCH_UP of them, the first naming how many
 * older ones it leaves out. With no state yet (the agent's first durable run) it starts at the feed's end: a new
 * operator agent does not investigate the whole history.
 *
 * cron: five fields, minute hour day-of-month month day-of-week, each `*`, a number, a range `a-b`, a list `a,b` or a
 * step `*\/n` / `a-b/n` (day of week 0 or 7 is Sunday), in local time, as cron reads them: when both day fields are
 * restricted either may match. `daily` is `0 0 * * *`, `hourly` `0 * * * *`. A firing missed while the run was down is
 * not made up, as with cron; one already made in a minute is not made again in it (state/triggers.json).
 *
 * Observation, not safety: a trigger that cannot be delivered is journaled and logged, never fails the run (G7).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobName } from "../engine/job-name.ts";
import { followFeed, readFeed, type FeedEvent } from "./feed.ts";
import type { JournalSink } from "./journal.ts";
import { newMessageId, type Delivery, type MessageMeta } from "./messaging.ts";
import type { Trigger } from "./types.ts";

export type { Trigger } from "./types.ts";

/** How many missed failures a starting run hands over (newest kept). */
export const CATCH_UP = 10;
export const TRIGGER_STATE_FILE = "triggers.json";
const CRON_ALIASES: Record<string, string> = { daily: "0 0 * * *", hourly: "0 * * * *" };

// ---- agent.yml ----

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Check agent.yml `triggers:` and normalise it. Throws `triggers[<i>] ...`. */
export function parseTriggers(raw: unknown): Trigger[] {
  if (!Array.isArray(raw)) throw new Error("triggers must be a list: [{ on: job.failed }, { cron: daily, prompt: ... }]");
  return raw.map((t, i) => {
    const at = `triggers[${i}]`;
    if (!isMap(t)) throw new Error(`${at} must be a map: { on: job.failed } or { cron: <schedule>, prompt: <text> }`);
    if ("on" in t) {
      for (const k of Object.keys(t)) if (k !== "on") throw new Error(`unknown key ${at}.${k}`);
      if (t.on !== "job.failed") throw new Error(`${at}.on must be job.failed (not ${JSON.stringify(t.on)})`);
      return { on: "job.failed" as const };
    }
    if ("cron" in t) {
      for (const k of Object.keys(t)) if (k !== "cron" && k !== "prompt") throw new Error(`unknown key ${at}.${k}`);
      if (typeof t.cron !== "string" || !t.cron.trim()) throw new Error(`${at}.cron must be daily, hourly or a 5-field cron schedule`);
      try {
        parseCron(t.cron);
      } catch (err) {
        throw new Error(`${at}.cron: ${(err as Error).message}`);
      }
      if (typeof t.prompt !== "string" || !t.prompt.trim()) throw new Error(`${at}.prompt must be the text the schedule sends`);
      return { cron: t.cron.trim(), prompt: t.prompt };
    }
    throw new Error(`${at} must have on (job.failed) or cron (with a prompt)`);
  });
}

// ---- cron ----

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS: [name: string, min: number, max: number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
];

function field(text: string, [name, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    if (!/^\d+$/.test(s)) throw new Error(`${name} ${JSON.stringify(text)} is not a number, range, list or step`);
    const n = Number(s);
    if (n < min || n > max) throw new Error(`${name} ${n} is outside ${min}-${max}`);
    return n;
  };
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : num(stepText);
    if (step < 1) throw new Error(`${name} step must be at least 1`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [lo, hi] = [num(a), num(b)];
      if (lo > hi) throw new Error(`${name} range ${range} runs backwards`);
    } else {
      lo = num(range);
      hi = stepText === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** daily, hourly or five cron fields. Throws with what is wrong (the caller names the key). */
export function parseCron(spec: string): CronSchedule {
  const text = CRON_ALIASES[spec.trim()] ?? spec.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error(`${JSON.stringify(spec)} is not daily, hourly or 5 fields (minute hour day-of-month month day-of-week)`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** Does the schedule fire in the minute of `d` (local time)? */
export function cronMatches(s: CronSchedule, d: Date): boolean {
  if (!s.minute.has(d.getMinutes()) || !s.hour.has(d.getHours()) || !s.month.has(d.getMonth() + 1)) return false;
  const dom = s.dom.has(d.getDate());
  const dow = s.dow.has(d.getDay());
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return dow;
  if (s.dowAny) return dom;
  return dom || dow;
}

// ---- state ----

export interface TriggerState {
  /** The last failure handed over: its feed seq, time and run. */
  jobFailed?: { seq: number; ts: string; runId?: string };
  /** Per cron trigger (its schedule and prompt), the minute it last fired (ISO). */
  cron?: Record<string, string>;
}

export function readTriggerState(stateDir: string): TriggerState | null {
  try {
    const s = JSON.parse(readFileSync(join(stateDir, TRIGGER_STATE_FILE), "utf8")) as TriggerState;
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function writeTriggerState(stateDir: string, s: TriggerState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, TRIGGER_STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    /* the next start catches up from the older state */
  }
}

const cronKey = (t: { cron: string; prompt: string }) => `${t.cron}|${t.prompt}`;

// ---- messages ----

const isFailure = (e: FeedEvent) => e.kind === "job.result" && e.data.outcome === "failed";

/** The turn a failed job starts. */
export function failureMessage(e: FeedEvent, o: { catchUp?: boolean; skipped?: number } = {}): string {
  const jobId = e.jobId ?? "?";
  const lines = [
    `job.failed: job ${jobName(jobId)} (${jobId}) failed${e.runId ? `, workflow run ${e.runId}` : ""}.`,
    `Reason: ${String(e.data.reason ?? "(none given)")}`,
  ];
  if (o.catchUp) lines.push(`(Caught up when this run started: the job failed at ${e.ts}.)`);
  if (o.skipped) lines.push(`(${o.skipped} earlier failure${o.skipped > 1 ? "s" : ""} since the last one handed over ${o.skipped > 1 ? "are" : "is"} not listed: run_list or the feed has them.)`);
  return lines.join("\n");
}

// ---- arming ----

export interface ArmOptions {
  triggers: Trigger[];
  /** The agent's state/ (triggers.json). */
  stateDir: string;
  /** The runs directory whose machine feed is followed. */
  runsDir: string;
  /** Hand pi a turn (the run's MessageDesk, journal off: trigger.fired is journaled here). */
  deliver(message: string, meta: MessageMeta): Promise<Delivery>;
  journal?: JournalSink | null;
  /** Stops following when it aborts. */
  signal: AbortSignal;
  log?(text: string): void;
  /** How often the feed is read. Default 1000 ms. */
  feedPollMs?: number;
}

/** Arm a durable run's triggers. Resolves when the signal aborts. Never throws. */
export async function armTriggers(o: ArmOptions): Promise<void> {
  const state: TriggerState = readTriggerState(o.stateDir) ?? {};
  const save = () => writeTriggerState(o.stateDir, state);
  // One firing at a time, in order, so the state is written in the order things happened.
  let queue: Promise<unknown> = Promise.resolve();
  const fire = (message: string, data: Record<string, unknown>, after?: (d: Delivery) => void) => {
    queue = queue.then(async () => {
      const id = newMessageId("trigger");
      let d: Delivery;
      try {
        d = await o.deliver(message, { id, via: "trigger", from: { kind: "trigger" } });
      } catch (err) {
        d = { id, accepted: null, error: (err as Error).message };
      }
      o.journal?.append({ kind: "trigger.fired", data: { ...data, id, accepted: d.accepted, ...(d.disposition ? { disposition: d.disposition } : {}), ...(d.error ? { error: d.error } : {}) } });
      if (d.accepted === false || d.error) o.log?.(`[builder] trigger ${String(data.trigger)}: ${d.error ?? "pi refused the turn"}\n`);
      try {
        after?.(d);
      } catch {
        /* bookkeeping */
      }
    });
    return queue;
  };

  const waits: Promise<unknown>[] = [];
  let caughtUp = 0;
  if (o.triggers.some((t) => "on" in t && t.on === "job.failed")) {
    const feed = readFeed(o.runsDir);
    const end = feed.length ? feed[feed.length - 1].seq : 0;
    const seen = state.jobFailed;
    if (!seen) {
      state.jobFailed = { seq: end, ts: new Date().toISOString() };
      save();
    } else {
      // A feed that is shorter than the seq we saw was replaced: fall back to the time.
      const replaced = end < seen.seq;
      const missed = feed.filter((e) => isFailure(e) && (replaced ? Date.parse(e.ts) > Date.parse(seen.ts) : e.seq > seen.seq));
      const kept = missed.slice(-CATCH_UP);
      caughtUp = kept.length;
      kept.forEach((e, i) => {
        void fire(failureMessage(e, { catchUp: true, ...(i === 0 && missed.length > kept.length ? { skipped: missed.length - kept.length } : {}) }), { trigger: "job.failed", jobId: e.jobId, runId: e.runId, reason: e.data.reason, feedSeq: e.seq, catchUp: true }, (d) => {
          if (d.accepted === false) return;
          state.jobFailed = { seq: e.seq, ts: e.ts, ...(e.runId ? { runId: e.runId } : {}) };
          save();
        });
      });
      // Everything up to here is caught up (or deliberately skipped): from now on only what is new.
      if (!kept.length && end > seen.seq) {
        state.jobFailed = { ...seen, seq: end };
        save();
      }
    }
    waits.push(
      followFeed(
        o.runsDir,
        { since: { seq: end }, kind: "job.result" },
        (e) => {
          if (!isFailure(e)) return;
          void fire(failureMessage(e), { trigger: "job.failed", jobId: e.jobId, runId: e.runId, reason: e.data.reason, feedSeq: e.seq }, (d) => {
            if (d.accepted === false) return;
            state.jobFailed = { seq: e.seq, ts: e.ts, ...(e.runId ? { runId: e.runId } : {}) };
            save();
          });
        },
        o.signal,
        o.feedPollMs ?? 1000,
      ).catch(() => {}),
    );
  }

  const crons = o.triggers.filter((t): t is { cron: string; prompt: string } => "cron" in t).map((t) => ({ t, s: parseCron(t.cron) }));
  if (crons.length) waits.push(cronLoop(crons, state, save, fire, o.signal));

  o.journal?.append({ kind: "triggers.armed", data: { triggers: o.triggers, ...(caughtUp ? { caughtUp } : {}) } });
  await Promise.all(waits);
}

/** The cron triggers due in the minute of `at` that have not fired in it yet. */
export function dueCrons<T extends { cron: string; prompt: string }>(crons: { t: T; s: CronSchedule }[], state: TriggerState, at: Date): T[] {
  const minute = new Date(at);
  minute.setSeconds(0, 0);
  const stamp = minute.toISOString();
  return crons.filter(({ t, s }) => cronMatches(s, minute) && state.cron?.[cronKey(t)] !== stamp).map(({ t }) => t);
}

/** Wake at each minute's start and fire what is due. */
async function cronLoop(crons: { t: { cron: string; prompt: string }; s: CronSchedule }[], state: TriggerState, save: () => void, fire: (m: string, data: Record<string, unknown>) => Promise<unknown>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const now = Date.now();
    await new Promise<void>((r) => {
      const t = setTimeout(r, 60_000 - (now % 60_000) + 50);
      signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
    if (signal.aborted) return;
    const at = new Date();
    const due = dueCrons(crons, state, at);
    if (!due.length) continue;
    const minute = new Date(at);
    minute.setSeconds(0, 0);
    for (const t of due) {
      state.cron = { ...(state.cron ?? {}), [cronKey(t)]: minute.toISOString() };
      save();
      void fire(t.prompt, { trigger: "cron", cron: t.cron, prompt: t.prompt });
    }
  }
}
