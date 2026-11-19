/**
 * Triggers (runtime/triggers.ts): agent.yml's `triggers:` checked and pinned for durable runs only; cron schedules as
 * cron reads them; and armTriggers on a real machine feed with a stand-in for the run's message desk: a job.failed
 * turn per failed job.result, the last one handed over kept in state/triggers.json, catch-up on start (at most
 * CATCH_UP, the first naming what it leaves out), nothing to catch up on a first start, and a refused turn not counted
 * as handed over.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendFeed, feedPath } from "../../runtime/feed.ts";
import type { JournalInput, JournalSink } from "../../runtime/journal.ts";
import type { Delivery, MessageMeta } from "../../runtime/messaging.ts";
import { checkAgentYml, resolve } from "../../runtime/resolve.ts";
import { armTriggers, CATCH_UP, cronMatches, dueCrons, parseCron, parseTriggers, readTriggerState } from "../../runtime/triggers.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-triggers");
after(() => tmp.remove());

describe("triggers in agent.yml", () => {
  it("parses on: job.failed and cron with a prompt; anything else names the entry and the key", () => {
    assert.deepEqual(parseTriggers([{ on: "job.failed" }, { cron: "daily", prompt: "review the last day's jobs" }, { cron: "*/15 9-17 * * 1-5", prompt: "look" }]), [
      { on: "job.failed" },
      { cron: "daily", prompt: "review the last day's jobs" },
      { cron: "*/15 9-17 * * 1-5", prompt: "look" },
    ]);
    assert.throws(() => parseTriggers({ on: "job.failed" }), /triggers must be a list/);
    assert.throws(() => parseTriggers([{ on: "job.done" }]), /triggers\[0\]\.on must be job\.failed/);
    assert.throws(() => parseTriggers([{ on: "job.failed", when: 1 }]), /unknown key triggers\[0\]\.when/);
    assert.throws(() => parseTriggers([{ on: "job.failed" }, { cron: "daily" }]), /triggers\[1\]\.prompt must be/);
    assert.throws(() => parseTriggers([{ cron: "61 * * * *", prompt: "x" }]), /triggers\[0\]\.cron: minute 61 is outside 0-59/);
    assert.throws(() => parseTriggers([{ cron: "weekly", prompt: "x" }]), /not daily, hourly or 5 fields/);
    assert.throws(() => parseTriggers(["job.failed"]), /triggers\[0\] must be a map/);
    assert.throws(() => checkAgentYml({ description: "x", triggers: [{ cron: "daily" }] }, "agent.yml", { requireDescription: true }), /agent\.yml: triggers\[0\]\.prompt/);
  });

  it("a durable run pins its triggers; a run of the same agent in another mode does not arm them", () => {
    const agentics = writeTree(join(tmp.dir, "pin-agentics"), {
      "agents/watch/agent.yml": "description: watches\nmode: durable\ntriggers:\n  - { on: job.failed }\n  - { cron: hourly, prompt: check in }\n",
    });
    const opts = { config: { limit: { enable: ["*"], disable: [] } }, agentics };
    assert.deepEqual(resolve({ agent: "watch" }, opts).triggers, [{ on: "job.failed" }, { cron: "hourly", prompt: "check in" }]);
    assert.equal(resolve({ agent: "watch", mode: "rpc" }, opts).triggers, undefined);
  });
});

describe("cron schedules", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);
  it("five fields with *, numbers, ranges, lists and steps, in local time; daily and hourly; dom or dow when both are set", () => {
    const daily = parseCron("daily");
    assert.equal(cronMatches(daily, at(2026, 11, 18, 0, 0)), true);
    assert.equal(cronMatches(daily, at(2026, 11, 18, 0, 1)), false);
    assert.equal(cronMatches(parseCron("hourly"), at(2026, 11, 18, 13, 0)), true);
    const office = parseCron("*/15 9-17 * * 1-5");
    assert.equal(cronMatches(office, at(2026, 11, 18, 9, 45)), true, "a Wednesday");
    assert.equal(cronMatches(office, at(2026, 11, 18, 9, 50)), false);
    assert.equal(cronMatches(office, at(2026, 11, 22, 10, 0)), false, "a Sunday");
    assert.equal(cronMatches(parseCron("0 12 * * 7"), at(2026, 11, 22, 12, 0)), true, "7 is Sunday too");
    const either = parseCron("0 8 1 * 1");
    assert.equal(cronMatches(either, at(2026, 12, 1, 8, 0)), true, "the 1st (a Tuesday)");
    assert.equal(cronMatches(either, at(2026, 11, 23, 8, 0)), true, "a Monday");
    assert.equal(cronMatches(either, at(2026, 11, 24, 8, 0)), false);
    assert.equal(cronMatches(parseCron("5,35 * * 2 *"), at(2027, 2, 3, 4, 35)), true);
    assert.throws(() => parseCron("5-1 * * * *"), /runs backwards/);
    assert.throws(() => parseCron("* * * *"), /5 fields/);
  });

  it("dueCrons: what matches this minute and has not fired in it", () => {
    const t = { cron: "30 6 * * *", prompt: "morning" };
    const crons = [{ t, s: parseCron(t.cron) }];
    const when = at(2026, 11, 18, 6, 30);
    assert.deepEqual(dueCrons(crons, {}, new Date(when.getTime() + 20_000)), [t]);
    const fired = new Date(when);
    assert.deepEqual(dueCrons(crons, { cron: { "30 6 * * *|morning": fired.toISOString() } }, when), [], "fired in this minute already");
    assert.deepEqual(dueCrons(crons, {}, at(2026, 11, 18, 6, 31)), []);
  });
});

describe("armTriggers on the machine feed", () => {
  /** A desk stand-in that answers `answer` and records what it was handed, and a journal that keeps events. */
  function harness(name: string, answer: (n: number) => Partial<Delivery> = () => ({ accepted: true, disposition: "started" })) {
    const runsDir = join(tmp.dir, name, "runs");
    const stateDir = join(tmp.dir, name, "state");
    const delivered: { message: string; meta: MessageMeta }[] = [];
    const events: JournalInput[] = [];
    const journal: JournalSink = { append: (e) => (events.push(e), null) };
    const deliver = async (message: string, meta: MessageMeta): Promise<Delivery> => {
      delivered.push({ message, meta });
      return { id: meta.id ?? "x", accepted: true, ...answer(delivered.length) };
    };
    const arm = () => {
      const ac = new AbortController();
      const done = armTriggers({ triggers: [{ on: "job.failed" }], stateDir, runsDir, deliver, journal, signal: ac.signal, feedPollMs: 30 });
      return { stop: async () => (ac.abort(), await done) };
    };
    const fail = (jobId: string, reason: string, runId = `run-${jobId}`) => appendFeed(runsDir, { kind: "job.result", jobId, runId, data: { outcome: "failed", reason } });
    return { runsDir, stateDir, delivered, events, arm, fail };
  }

  it("a first start catches up on nothing; a failure then starts a turn with the job, run and reason, journaled trigger.fired and kept in state/", async () => {
    const h = harness("first");
    h.fail("job-old", "before the agent was ever started");
    appendFeed(h.runsDir, { kind: "run.end", runId: "r0", data: {} });
    const armed = h.arm();
    await waitFor("triggers.armed", () => h.events.find((e) => e.kind === "triggers.armed"), 5000, 20);
    assert.deepEqual(readTriggerState(h.stateDir)?.jobFailed?.seq, 2, "it starts at the feed's end");
    appendFeed(h.runsDir, { kind: "job.result", jobId: "job-ok", runId: "r1", data: { outcome: "done", patchBytes: 10 } });
    h.fail("job-new-1", "tsc failed during implement");
    await waitFor("the turn", () => h.events.find((e) => e.kind === "trigger.fired"), 5000, 20);
    await armed.stop();
    assert.equal(h.delivered.length, 1, "the old failure and the done job start nothing");
    assert.match(h.delivered[0].message, /^job\.failed: job [a-z]+-[a-z]+ \(job-new-1\) failed, workflow run run-job-new-1\.\nReason: tsc failed during implement$/);
    assert.equal(h.delivered[0].meta.via, "trigger");
    const fired = h.events.find((e) => e.kind === "trigger.fired")!;
    assert.deepEqual({ ...fired.data, id: typeof fired.data.id }, { trigger: "job.failed", jobId: "job-new-1", runId: "run-job-new-1", reason: "tsc failed during implement", feedSeq: 4, id: "string", accepted: true, disposition: "started" });
    assert.deepEqual(readTriggerState(h.stateDir)?.jobFailed, { seq: 4, ts: JSON.parse(readFileSync(feedPath(h.runsDir), "utf8").trim().split("\n")[3]).ts, runId: "run-job-new-1" });
  });

  it("a start after downtime catches up oldest first, at most CATCH_UP, the first naming the ones it leaves out; then follows", async () => {
    const h = harness("restart");
    (await h.arm().stop());
    for (let i = 1; i <= CATCH_UP + 2; i++) h.fail(`job-${i}`, `reason ${i}`);
    const armed = h.arm();
    await waitFor("the catch-up", () => (h.delivered.length === CATCH_UP ? true : undefined), 5000, 20);
    assert.match(h.delivered[0].message, /\(job-3\)[\s\S]*Caught up when this run started[\s\S]*2 earlier failures since the last one handed over are not listed/);
    assert.match(h.delivered[CATCH_UP - 1].message, /\(job-12\)/);
    assert.ok(!/earlier failure/.test(h.delivered[1].message));
    h.fail("job-live", "after the start");
    await waitFor("the live one", () => (h.delivered.length === CATCH_UP + 1 ? true : undefined), 5000, 20);
    await armed.stop();
    assert.equal(h.events.filter((e) => e.kind === "triggers.armed").at(-1)?.data.caughtUp, CATCH_UP);
    assert.equal(h.events.filter((e) => e.kind === "trigger.fired" && e.data.catchUp === true).length, CATCH_UP);
    assert.equal(readTriggerState(h.stateDir)?.jobFailed?.runId, "run-job-live");
  });

  it("a turn pi refuses is not counted as handed over: the next start offers it again", async () => {
    const h = harness("refused", () => ({ accepted: false, error: "not now" }));
    await h.arm().stop();
    h.fail("job-r", "refused once");
    const armed = h.arm();
    await waitFor("the attempt", () => h.events.find((e) => e.kind === "trigger.fired"), 5000, 20);
    await armed.stop();
    const before = readTriggerState(h.stateDir)?.jobFailed?.seq;
    assert.equal(before, 0, "still before the refused failure");
    assert.deepEqual([h.events.find((e) => e.kind === "trigger.fired")?.data.accepted, h.events.find((e) => e.kind === "trigger.fired")?.data.error], [false, "not now"]);
  });

  it("a feed that was replaced (shorter than the seq seen) is caught up by time", async () => {
    const h = harness("replaced");
    for (let i = 0; i < 5; i++) appendFeed(h.runsDir, { kind: "run.end", runId: `r${i}`, data: {} });
    await h.arm().stop();
    assert.equal(readTriggerState(h.stateDir)?.jobFailed?.seq, 5);
    rmSync(feedPath(h.runsDir));
    await new Promise((r) => setTimeout(r, 5));
    h.fail("job-after", "in the new feed");
    const armed = h.arm();
    await waitFor("the catch-up", () => (h.delivered.length ? true : undefined), 5000, 20);
    await armed.stop();
    assert.match(h.delivered[0].message, /job-after/);
  });

  it("a broken state file is a first start, not a crash", async () => {
    const h = harness("broken");
    writeTree(h.stateDir, { "triggers.json": "{ not json" });
    h.fail("job-x", "x");
    await h.arm().stop();
    assert.equal(h.delivered.length, 0);
    assert.equal(readTriggerState(h.stateDir)?.jobFailed?.seq, 1);
  });
});
