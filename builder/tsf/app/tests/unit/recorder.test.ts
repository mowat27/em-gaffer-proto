/**
 * The run recorder (DESIGN 7 "Recorder"), on the real agent with the faux model. Each test records into its own
 * sqlite file and bus, so it never meets the Service's own recorder (which writes to tsf/data/tsf.sqlite).
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecorder, type RunRecorder } from "../../src/agent/recorder.ts";
import { createBus } from "../../src/core/bus.ts";
import { openAppDb, type AppDb } from "../../src/core/db.ts";
import { silentLogger } from "../../src/core/log.ts";
import type { AppEvent } from "../../src/shared/events.ts";
import type { RunSummary } from "../../src/shared/types.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

type TestFactory = Awaited<ReturnType<typeof createTestFactory>>;

let factory: TestFactory;
let dbs: AppDb[] = [];
let recorders: RunRecorder[] = [];
let dir: string;

beforeEach(async () => {
  process.env.TSF_FAUX_TPS = "1000";
  factory = await createTestFactory();
  dir = await tmpDir("tsf-recorder");
  dbs = [];
  recorders = [];
});

afterEach(async () => {
  delete process.env.TSF_FAUX_TPS;
  for (const r of recorders) r.stop();
  await factory.close();
  for (const d of dbs) d.close();
  await cleanupTmp();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Rig {
  db: AppDb;
  events: AppEvent[];
  recorded: RunSummary[];
  recorder: RunRecorder;
}

async function rig(file = "runs.sqlite", db?: AppDb): Promise<Rig> {
  const theDb = db ?? openAppDb(join(dir, file));
  if (!db) dbs.push(theDb);
  const bus = createBus(silentLogger);
  const events: AppEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const recorder = await createRecorder({
    feed: factory.agent.feed,
    main: factory.agent.main,
    db: theDb,
    bus,
    log: silentLogger,
  });
  recorders.push(recorder);
  return {
    db: theDb,
    events,
    recorder,
    get recorded(): RunSummary[] {
      return events.flatMap((e) => (e.type === "run.recorded" ? [e.run] : []));
    },
  };
}

const send = (text: string, requestId: string) => factory.service.sendMessage({ text, requestId }, { by: "ui" });

describe("recorder", () => {
  it("records a chat run with one tool call: trigger, start, turns, tools, usage, cost source and prompt", async () => {
    const r = await rig();
    const before = Date.now();
    const prompt = 'probe bash {"command":"echo hi"}';
    await send(prompt, "rec-1");
    const run = await until("run.recorded", () => r.recorded[0]);

    expect(r.recorder.list({})).toHaveLength(1);
    expect(run).toMatchObject({
      trigger: "chat",
      status: "answered",
      turns: 1,
      toolCalls: 1,
      costSource: "estimate",
      failure: null,
      prompt,
      model: "faux/faux-1",
    });
    expect(run.startedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(run.finishedAt).not.toBeNull();
    expect(run.finishedAt!).toBeGreaterThanOrEqual(run.startedAt);
    expect(run.durationMs).toBe(run.finishedAt! - run.startedAt);
    // Two model requests (the tool call, then the answer): usage is summed over both.
    expect(run.usage.output).toBeGreaterThan(0);
    expect(run.usage.totalTokens).toBeGreaterThan(run.usage.output);
    expect(run.usage.costUsd).toBe(0);

    const detail = r.recorder.get(run.id)!;
    expect(detail.tools).toHaveLength(1);
    expect(detail.tools[0]).toMatchObject({ name: "bash", status: "done", diagnostic: null });
    expect(JSON.parse(detail.tools[0]!.args)).toEqual({ command: "echo hi" });
    expect(detail.tools[0]!.output).toContain("hi");
    expect(detail.tools[0]!.durationMs).not.toBeNull();
    expect(r.recorder.get(run.id + 100_000)).toBeUndefined();
  });

  it("publishes run.recorded once per run, at its end, and the row is already readable", async () => {
    const r = await rig();
    await send("ping", "rec-2");
    await until("run.recorded", () => r.recorded[0]);
    await sleep(300);
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toEqual(r.recorder.list({})[0]);
  });

  it("records a failed tool call as a failed tool row", async () => {
    const r = await rig();
    await send('probe read {"path":"/etc/hosts"}', "rec-3");
    const run = await until("run.recorded", () => r.recorded[0]);
    const tool = r.recorder.get(run.id)!.tools[0]!;
    expect(tool).toMatchObject({ name: "read", status: "failed", diagnostic: "tool_error" });
    expect(tool.output).toContain("outside the project");
  });

  it("gives a tsf.cron input the trigger cron", async () => {
    const r = await rig();
    await factory.agent.main.submit(
      {
        type: "input",
        content: "ping",
        requestId: "cron:nightly:1",
        whenBusy: "followUp",
        entry: { kind: "tsf.cron", data: { cronId: "nightly", name: "Nightly", slot: 1, catchUp: false, manual: false } },
      } as never,
      ctx,
    );
    const run = await until("run.recorded", () => r.recorded[0]);
    expect(run).toMatchObject({ trigger: "cron", status: "answered", prompt: "ping" });
  });

  it("records an aborted run, then a continue run with the trigger continue", async () => {
    const r = await rig();
    await send("long turn", "rec-long");
    await until("the run to stream", () => factory.agent.feed.view().live.busy);
    await sleep(300);
    await factory.service.stopRun({ by: "ui" });
    const first = await until("the aborted run", () => r.recorded[0]);
    expect(first).toMatchObject({ trigger: "chat", status: "aborted", failure: "aborted", prompt: "long turn" });

    await factory.agent.main.submit({ type: "continue", requestId: "continue:rec" } as never, ctx);
    const second = await until("the continue run", () => r.recorded[1]);
    expect(second).toMatchObject({ trigger: "continue", status: "answered", failure: null, prompt: "long turn" });
    expect(second.id).not.toBe(first.id);
    expect(r.recorder.list({}).map((x) => x.id)).toEqual([second.id, first.id]);
    // The continue run does not count the aborted attempt's entry again.
    const rows = r.db.db.prepare("SELECT first_entry FROM runs ORDER BY id").all() as { first_entry: number }[];
    expect(rows[0]!.first_entry).toBe(rows[1]!.first_entry);
    expect(second.usage.output).toBeGreaterThan(1_500);
    expect(second.usage.output).toBeLessThan(first.usage.output * 1.5);
  });

  it("a second recorder over the same feed and db does not duplicate rows (idle restart)", async () => {
    const a = await rig("shared.sqlite");
    await send("ping", "rec-4");
    const run = await until("run.recorded", () => a.recorded[0]);
    a.recorder.stop();

    const b = await rig("shared.sqlite", a.db);
    expect(b.recorder.list({})).toEqual([run]);
    expect((b.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
    await send("ping", "rec-5");
    await until("the second run", () => b.recorded[0]);
    expect(b.recorder.list({})).toHaveLength(2);
  });

  it("a recorder started in the middle of a run matches the open row and finishes it once", async () => {
    const a = await rig("mid.sqlite");
    await send("long turn", "rec-mid");
    const running = await until("a running row", () => a.recorder.list({})[0]?.status === "running" && a.recorder.list({})[0]);
    a.recorder.stop();

    const b = await rig("mid.sqlite", a.db);
    const done = await until("run.recorded", () => b.recorded[0]);
    expect(done.id).toBe(running.id);
    expect(done).toMatchObject({ status: "answered", trigger: "chat", prompt: "long turn" });
    expect(done.usage.output).toBeGreaterThan(1_500);
    expect(b.recorder.list({})).toHaveLength(1);
    expect((b.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
  });

  it("closes a row left running when its run ended while nothing watched", async () => {
    const db = openAppDb(join(dir, "stale.sqlite"));
    dbs.push(db);
    db.runs.save(
      {
        id: 4242,
        trigger: "chat",
        status: "running",
        startedAt: 1,
        finishedAt: null,
        durationMs: null,
        model: null,
        turns: 0,
        toolCalls: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
        costSource: "estimate",
        failure: null,
        prompt: "old",
        firstEntry: null,
      },
      [],
    );
    const r = await rig("stale.sqlite", db);
    expect(r.recorder.get(4242)).toMatchObject({ status: "answered" });
    expect(r.recorded.map((x) => x.id)).toEqual([4242]);
  });

  it("stops: no run is recorded after stop()", async () => {
    const r = await rig();
    r.recorder.stop();
    await send("ping", "rec-6");
    await until("the answer", () => factory.agent.feed.view().items.some((i) => i.kind === "assistant"));
    await sleep(300);
    expect(r.recorder.list({})).toEqual([]);
  });
});

describe("RunsRepo", () => {
  const row = (id: number, over: Partial<RunSummary> = {}) => ({
    id,
    trigger: "chat" as const,
    status: "answered" as const,
    startedAt: 1_000 + id,
    finishedAt: 2_000 + id,
    durationMs: 1_000,
    model: "faux/faux-1",
    turns: 0,
    toolCalls: 0,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, costUsd: 0.5 },
    costSource: "provider" as const,
    failure: null,
    prompt: `run ${id}`,
    firstEntry: id,
    ...over,
  });

  it("lists newest first with limit (default 20, max 200) and before", async () => {
    const db = openAppDb(join(await tmpDir("tsf-runs"), "r.sqlite"));
    dbs.push(db);
    for (let id = 1; id <= 25; id++) db.runs.save(row(id), []);
    expect(db.runs.list({}).map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(db.runs.list({ limit: 3 }).map((r) => r.id)).toEqual([25, 24, 23]);
    expect(db.runs.list({ limit: 3, before: 10 }).map((r) => r.id)).toEqual([9, 8, 7]);
    expect(db.runs.list({ limit: 5_000 })).toHaveLength(25);
    expect(db.runs.list({ limit: 0 })).toHaveLength(1);
    expect(db.runs.list({}).every((r) => !("firstEntry" in r))).toBe(true);
    expect(db.runs.list({ limit: 1 })[0]).toMatchObject({ usage: { costUsd: 0.5, totalTokens: 10 }, costSource: "provider" });
  });

  it("upserts a run and its tools, and caps args and output at 20 000", async () => {
    const db = openAppDb(join(await tmpDir("tsf-runs"), "r.sqlite"));
    dbs.push(db);
    const tool = (over = {}) => ({
      callId: "c1",
      name: "bash",
      status: "pending" as const,
      durationMs: null,
      diagnostic: null,
      args: "a".repeat(30_000),
      output: "",
      ...over,
    });
    db.runs.save(row(7, { status: "running", finishedAt: null, durationMs: null }), [tool()]);
    db.runs.save(row(7), [tool({ status: "done", output: "o".repeat(30_000), durationMs: 5 })]);
    const run = db.runs.get(7)!;
    expect(run.status).toBe("answered");
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({ status: "done", durationMs: 5 });
    expect(run.tools[0]!.args).toHaveLength(20_000);
    expect(run.tools[0]!.output).toHaveLength(20_000);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM run_tools").get() as { n: number }).n).toBe(1);
    expect(db.runs.byFirstEntry(7).map((r) => r.id)).toEqual([7]);
    expect(db.runs.running()).toEqual([]);
    expect(db.runs.get(8)).toBeUndefined();
  });

  it("migration 2 sets schema_version 2 and is not applied twice", async () => {
    const file = join(await tmpDir("tsf-runs"), "r.sqlite");
    const db = openAppDb(file);
    db.runs.save(row(1), []);
    db.close();
    const again = openAppDb(file);
    dbs.push(again);
    const v = again.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(v.value)).toBeGreaterThanOrEqual(2);
    expect(again.runs.get(1)).toBeDefined();
  });
});

describe("GET /api/runs (through the Service's own recorder)", () => {
  const get = (path: string) => factory.app.request(path);

  it("lists newest first, pages with limit and before, and reads one run with its tools", async () => {
    await factory.service.sendMessage({ text: 'probe bash {"command":"echo one"}', requestId: "api-1" }, { by: "ui" });
    const waitRuns = async (n: number) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const runs = (await (await get("/api/runs")).json()) as RunSummary[];
        if (runs.length >= n && runs.every((r) => r.status !== "running")) return runs;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} runs`);
        await sleep(25);
      }
    };
    await waitRuns(1);
    await factory.service.sendMessage({ text: "ping", requestId: "api-2" }, { by: "ui" });
    const runs = await waitRuns(2);
    expect(runs.map((r) => r.prompt)).toEqual(["ping", 'probe bash {"command":"echo one"}']);
    expect(runs[0]!.id).toBeGreaterThan(runs[1]!.id);

    const page = (await (await get(`/api/runs?limit=1&before=${runs[0]!.id}`)).json()) as RunSummary[];
    expect(page.map((r) => r.id)).toEqual([runs[1]!.id]);

    const detail = (await (await get(`/api/runs/${runs[1]!.id}`)).json()) as { tools: { name: string; status: string }[] };
    expect(detail.tools).toMatchObject([{ name: "bash", status: "done" }]);
  });

  it("answers 400 for a bad query or id and a JSON not_found for an unknown run", async () => {
    expect((await get("/api/runs?limit=abc")).status).toBe(400);
    expect((await get("/api/runs?before=-1")).status).toBe(400);
    expect((await get("/api/runs/abc")).status).toBe(400);
    const missing = await get("/api/runs/0");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
