/**
 * The machine feed (runs/index.jsonl): appending, seq by line, filters, --since, following, and what the runtime and
 * the engine write there for a workflow run (run.start, step.*, run.end), including a run whose process vanished.
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFeed, feedPath, followFeed, parseSince, readFeed, type FeedEvent } from "../../runtime/feed.ts";
import { createRuntime } from "../../runtime/run.ts";
import { tempDir, waitFor } from "../harness/util.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = JSON.stringify(pathToFileURL(join(BUILDER, "engine", "workflow.ts")).href);
const tmp = tempDir("builder-feed");
after(() => tmp.remove());
let n = 0;
const runsDir = () => join(tmp.dir, `runs-${++n}`);

describe("the machine feed", () => {
  it("appends one line per event; a line's seq is its line number; data is redacted", () => {
    const dir = runsDir();
    process.env.FEED_TEST_TOKEN = "sekret-value-123";
    try {
      appendFeed(dir, { kind: "server.start", data: { pid: 1, note: "token sekret-value-123" } });
      appendFeed(dir, { kind: "run.start", runId: "r1", data: { kind: "agent" } });
      appendFeed(dir, { kind: "step.end", runId: "r2", jobId: "j1", step: "implement", data: { status: "ok" } });
    } finally {
      delete process.env.FEED_TEST_TOKEN;
    }
    const events = readFeed(dir);
    assert.deepEqual(events.map((e) => [e.seq, e.kind, e.runId ?? null, e.jobId ?? null, e.step ?? null]), [
      [1, "server.start", null, null, null],
      [2, "run.start", "r1", null, null],
      [3, "step.end", "r2", "j1", "implement"],
    ]);
    assert.equal(events[0].data.note, "token [redacted:FEED_TEST_TOKEN]");
    assert.ok(!Number.isNaN(Date.parse(events[0].ts)));
  });

  it("filters: kind (or a prefix*), run, job, the last n, and since a seq or a time", () => {
    const dir = runsDir();
    for (const kind of ["server.start", "server.state", "run.start", "server.state", "run.end"] as const) appendFeed(dir, { kind, runId: kind.startsWith("run") ? "r1" : undefined, data: {} });
    assert.deepEqual(readFeed(dir, { kind: "server.*" }).map((e) => e.seq), [1, 2, 4]);
    assert.deepEqual(readFeed(dir, { kind: "server.state" }).map((e) => e.seq), [2, 4]);
    assert.deepEqual(readFeed(dir, { runId: "r1" }).map((e) => e.kind), ["run.start", "run.end"]);
    assert.deepEqual(readFeed(dir, { last: 2 }).map((e) => e.seq), [4, 5]);
    assert.deepEqual(readFeed(dir, { since: { seq: 3 } }).map((e) => e.seq), [4, 5]);
    assert.deepEqual(readFeed(dir, { since: { time: Date.now() + 60_000 } }), []);
    assert.equal(readFeed(dir, { since: { time: Date.now() - 60_000 } }).length, 5);
    assert.deepEqual(readFeed(join(tmp.dir, "nowhere")), [], "a missing feed reads as no events");
  });

  it("--since: digits are a seq, 10m/2h/1d a duration, anything else a time", () => {
    const now = Date.parse("2026-11-18T12:00:00.000Z");
    assert.deepEqual(parseSince("42", now), { seq: 42 });
    assert.deepEqual(parseSince("10m", now), { time: now - 600_000 });
    assert.deepEqual(parseSince("1d", now), { time: now - 86_400_000 });
    assert.deepEqual(parseSince("2026-11-18T11:00:00Z", now), { time: Date.parse("2026-11-18T11:00:00Z") });
    assert.throws(() => parseSince("yesterday"), /--since yesterday: a seq/);
  });

  it("a torn line keeps its number and a line still being written is not read yet", () => {
    const dir = runsDir();
    appendFeed(dir, { kind: "run.start", data: {} });
    appendFileSync(feedPath(dir), "{not json\n");
    appendFileSync(feedPath(dir), '{"ts":"2026-11-18T12:00:00.000Z","kind":"run.end","data":{}}');
    assert.deepEqual(readFeed(dir).map((e) => [e.seq, e.kind]), [[1, "run.start"]]);
    appendFileSync(feedPath(dir), "\n");
    assert.deepEqual(readFeed(dir).map((e) => [e.seq, e.kind]), [
      [1, "run.start"],
      [3, "run.end"],
    ]);
  });

  it("follow: replays from since, then delivers what is appended, until aborted", async () => {
    const dir = runsDir();
    appendFeed(dir, { kind: "server.start", data: {} });
    appendFeed(dir, { kind: "server.state", data: { state: "idle" } });
    const got: FeedEvent[] = [];
    const ac = new AbortController();
    const done = followFeed(dir, { since: { seq: 1 } }, (e) => got.push(e), ac.signal, 50);
    await waitFor("the replay", () => (got.length === 1 ? true : undefined), 2000, 20);
    appendFeed(dir, { kind: "job.accepted", jobId: "j1", data: {} });
    appendFeed(dir, { kind: "run.start", runId: "r1", data: {} });
    await waitFor("the appended events", () => (got.length === 3 ? true : undefined), 2000, 20);
    ac.abort();
    await done;
    assert.deepEqual(got.map((e) => [e.seq, e.kind]), [
      [2, "server.state"],
      [3, "job.accepted"],
      [4, "run.start"],
    ]);
    const last: FeedEvent[] = [];
    const ac2 = new AbortController();
    const done2 = followFeed(dir, { last: 1 }, (e) => last.push(e), ac2.signal, 50);
    await waitFor("the last event", () => (last.length ? true : undefined), 2000, 20);
    ac2.abort();
    await done2;
    assert.deepEqual(last.map((e) => e.seq), [4], "--last applies to the replay");
  });

  it("the runtime writes run.start and run.end, the engine each step, with the run and job ids", async () => {
    const dir = runsDir();
    const mod = join(tmp.dir, "feed-builder.mts");
    writeFileSync(mod, `import { code, defineBuilder } from ${WORKFLOW};\nexport default defineBuilder({ name: "feed", provides: [], steps: [code("one", async () => ({ ok: 1 })), code("two", async () => { throw new Error("step two broke"); })] });\n`);
    const rt = createRuntime({ runsDir: dir, piCommand: "/bin/false" });
    const dispatch = { requires: [], repo: { url: "/nowhere", base: "abc1234" }, task: { sliceId: "s1", title: "T", context: "C", handover: false, attempt: 1 }, slice: null, callback: "http://127.0.0.1:9/jobs/feed-job-1" };
    const rec = await rt.start({ workflow: mod, input: { dispatch } });
    assert.equal((await rt.wait(rec.id)).outcome, "failed");
    const events = readFeed(dir, { runId: rec.id });
    assert.deepEqual(events.map((e) => [e.kind, e.step ?? null, e.data.status ?? e.data.state ?? null]), [
      ["run.start", null, null],
      ["step.start", "one", null],
      ["step.end", "one", "ok"],
      ["step.start", "two", null],
      ["step.end", "two", "failed"],
      ["run.end", null, "failed"],
    ]);
    assert.equal(events[0].data.workflow, mod);
    assert.equal(events[4].data.reason, "step two broke");
    assert.equal(events[5].data.reason, "step two broke");
  });

  it("a run whose process vanished gets its run.end from the starter that noticed", async () => {
    const dir = runsDir();
    const mod = join(tmp.dir, "feed-long.mts");
    writeFileSync(mod, `import { code, defineBuilder } from ${WORKFLOW};\nexport default defineBuilder({ name: "long", provides: [], steps: [code("wait", () => new Promise((r) => setTimeout(r, 60_000)))] });\n`);
    const rt = createRuntime({ runsDir: dir, piCommand: "/bin/false" });
    const dispatch = { requires: [], repo: { url: "/nowhere", base: "abc1234" }, task: { sliceId: "s1", title: "T", context: "C", handover: false, attempt: 1 }, slice: null, callback: "http://127.0.0.1:9/jobs/feed-job-2" };
    const rec = await rt.start({ workflow: mod, input: { dispatch } });
    await waitFor("the step to start", () => (readFeed(dir, { kind: "step.start" }).length ? true : undefined), 10_000, 50);
    process.kill(rec.pid!, "SIGKILL");
    const result = await rt.wait(rec.id);
    assert.equal(result.outcome, "failed");
    const end = readFeed(dir, { kind: "run.end" });
    assert.equal(end.length, 1);
    assert.equal(end[0].data.by, "starter");
    assert.match(String(end[0].data.reason), /ended without a result \(signal SIGKILL\)/);
  });
});
