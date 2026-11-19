/**
 * The server's control inbox through the contract (E14), with control_send as the operator's side: drain lets the
 * running job finish and then answers 503 until resume; cancel stops the running job, which posts failed with
 * `cancelled by operator`. Each message is answered in the outbox and journaled in the job's run and the machine
 * feed. Also: GET /status is gone, and the feed shows the server's life and its jobs.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool, type ToolContext } from "../../ops/core/tool.ts";
import { readFeed } from "../../runtime/feed.ts";
import { readJournal } from "../../runtime/journal.ts";
import { createRuntime } from "../../runtime/run.ts";
import { startBuilder, type RunningBuilder } from "../harness/builder.ts";
import { dispatch, newJobId, SLICE } from "../harness/dispatch.ts";
import { createFixtureRepo, type FixtureRepo } from "../harness/fixture-repo.ts";
import { startGaffer, type FakeGaffer } from "../harness/gaffer.ts";
import { scenario } from "../harness/scenario.ts";
import { http, sleep, tempDir, waitFor } from "../harness/util.ts";

const SLICE_DIR = `src/slices/${SLICE.contextName}/${SLICE.title}`;
let tmp: ReturnType<typeof tempDir>;
let repo: FixtureRepo;
let gaffer: FakeGaffer;
before(async () => {
  tmp = tempDir("builder-control-inbox");
  repo = createFixtureRepo(tmp.dir);
  gaffer = await startGaffer();
});
after(async () => {
  await gaffer?.stop();
  await sleep(300);
  tmp?.remove();
});

/** The operator's side: a CLI tool context on the builder's runs directory. */
function operator(b: RunningBuilder): ToolContext {
  const base = loadConfig({ packaged: join(tmp.dir, "absent.yml"), userConfig: join(tmp.dir, "absent.yml"), env: {} });
  const config = { ...base, limit: { enable: ["*"], disable: [] }, server: { ...base.server, runsDir: b.runsDir } };
  return cliContext(config, createRuntime({ runsDir: b.runsDir, piCommand: "/bin/false" }));
}

const control = async (ctx: ToolContext, args: Record<string, unknown>) => (await callTool("control_send", args, ctx)) as { action: string; by: string; result: Record<string, unknown> };
const jobRun = (b: RunningBuilder, jobId: string) => createRuntime({ runsDir: b.runsDir, piCommand: "/bin/false" }).list().find((r) => r.job?.jobId === jobId);

describe("the control inbox", { concurrency: true }, () => {
  it("drain: the running job finishes, then 503 until resume; journaled in the job run and the feed", { timeout: 90_000 }, async () => {
    const b = await startBuilder();
    try {
      const ops = operator(b);
      const a = newJobId();
      b.setScenario(a, scenario({ op: "sleep", ms: 1500 }, { op: "write", path: `${SLICE_DIR}/a.ts`, content: "export const a = 1;\n" }, { op: "done" }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, a))).status, 202);
      await waitFor("the agent to start", () => (b.stubRecord(a) ? true : undefined), 30_000);

      const drained = await control(ops, { action: "drain" });
      assert.equal(drained.action, "drain");
      assert.equal(drained.result.ok, true);
      assert.equal(drained.result.state, "draining");
      assert.equal(drained.result.jobId, a);
      assert.equal(((await gaffer.result(a, 30_000)) as { outcome: string }).outcome, "done", "the running job finishes");

      const refused = await waitFor(
        "the drained answer",
        async () => {
          const res = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, newJobId()));
          return (res.json as { error?: string })?.error === "draining" ? res : undefined;
        },
        15_000,
        200,
      );
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get("retry-after"), "15");

      const resumed = await control(ops, { action: "resume" });
      assert.deepEqual([resumed.result.ok, resumed.result.state], [true, "idle"]);
      const c = newJobId();
      b.setScenario(c, scenario({ op: "write", path: `${SLICE_DIR}/c.ts`, content: "export const c = 1;\n" }, { op: "done" }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, c))).status, 202);
      assert.equal(((await gaffer.result(c, 30_000)) as { outcome: string }).outcome, "done");

      const feed = readFeed(b.runsDir);
      const control_ = feed.filter((e) => e.kind.startsWith("control."));
      assert.deepEqual(control_.map((e) => [e.kind, e.data.action]), [
        ["control.received", "drain"],
        ["control.applied", "drain"],
        ["control.received", "resume"],
        ["control.applied", "resume"],
      ]);
      assert.equal(control_[0].jobId, a);
      assert.ok(feed.some((e) => e.kind === "server.state" && e.data.state === "draining" && e.jobId === a));
      const run = jobRun(b, a)!;
      const journaled = await waitFor("the drain in the job's journal", () => {
        const kinds = readJournal(join(b.runsDir, run.id)).filter((e) => e.kind.startsWith("control.")).map((e) => `${e.kind} ${String(e.data.action)}`);
        return kinds.length === 2 ? kinds : undefined;
      }, 10_000);
      assert.deepEqual(journaled, ["control.received drain", "control.applied drain"]);
    } catch (err) {
      if (err instanceof Error) err.message += `\n--- builder output ---\n${b.output()}`;
      throw err;
    } finally {
      await b.stop();
    }
  });

  it("cancel: the running job fails with cancelled by operator; a cancel with no job, or for another job, is refused", { timeout: 90_000 }, async () => {
    const b = await startBuilder();
    try {
      const ops = operator(b);
      assert.deepEqual((await control(ops, { action: "cancel" })).result, { ok: false, error: "no job is running", state: "idle" });
      const j = newJobId();
      b.setScenario(j, scenario({ op: "sleep", ms: 120_000 }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, j))).status, 202);
      await waitFor("the agent to start", () => (b.stubRecord(j) ? true : undefined), 30_000);
      const other = await control(ops, { action: "cancel", jobId: "someone-else" });
      assert.equal(other.result.ok, false);
      assert.match(String(other.result.error), /^job someone-else is not running/);

      const t0 = Date.now();
      const cancelled = await control(ops, { action: "cancel", jobId: j, waitSeconds: 20 });
      assert.equal(cancelled.result.ok, true);
      assert.deepEqual(await gaffer.result(j, 20_000), { outcome: "failed", reason: "cancelled by operator" });
      assert.ok(Date.now() - t0 < 15_000, "the job stopped at once");
      assert.equal(gaffer.calls(j).length, 1, "one callback");

      const run = jobRun(b, j)!;
      assert.equal(run.state, "stopped");
      const journal = await waitFor("the callback in the job's journal", () => {
        const ev = readJournal(join(b.runsDir, run.id));
        return ev.some((e) => e.kind === "callback.ok") ? ev : undefined;
      }, 10_000);
      const kinds = journal.map((e) => e.kind);
      assert.ok(kinds.indexOf("control.received") < kinds.indexOf("run.end"), "received while the run was live, merged before it ended");
      assert.ok(kinds.includes("control.applied"));
      assert.deepEqual(journal.find((e) => e.kind === "job.result")?.data, { outcome: "failed", reason: "cancelled by operator" });
      assert.deepEqual(journal.map((e) => e.seq), journal.map((_, i) => i + 1), "one seq throughout");
      const result = readFeed(b.runsDir, { kind: "job.result", jobId: j });
      assert.deepEqual(result.map((e) => e.data.reason), ["cancelled by operator"]);
    } catch (err) {
      if (err instanceof Error) err.message += `\n--- builder output ---\n${b.output()}`;
      throw err;
    } finally {
      await b.stop();
    }
  });

  it("GET /status is gone; the machine feed has the server's start and state, and a job from accept to callback", { timeout: 60_000 }, async () => {
    const b = await startBuilder();
    try {
      assert.equal((await http("GET", `${b.url}/status`)).status, 404);
      const j = newJobId();
      b.setScenario(j, scenario({ op: "write", path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" }, { op: "done" }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, j))).status, 202);
      assert.equal(((await gaffer.result(j, 30_000)) as { outcome: string }).outcome, "done");
      const feed = await waitFor("the job to be idle again", () => {
        const f = readFeed(b.runsDir);
        return f.some((e) => e.kind === "callback.ok") && f[f.length - 1].kind === "server.state" && f[f.length - 1].data.state === "idle" ? f : undefined;
      }, 10_000);
      assert.equal(feed[0].kind, "server.start");
      assert.equal(feed[0].data.port, Number(new URL(b.url).port));
      const forJob = feed.filter((e) => e.jobId === j);
      const kinds = forJob.map((e) => (e.kind.startsWith("step.") ? `${e.kind} ${e.step}` : e.kind));
      assert.equal(kinds[0], "server.state");
      assert.ok(kinds.includes("job.accepted"));
      for (const k of ["run.start", "step.start clone", "step.end prepare", "step.start implement", "step.end commit", "run.end", "job.result", "callback.ok"]) assert.ok(kinds.includes(k), `${k} in ${kinds.join(", ")}`);
      assert.ok(kinds.indexOf("job.accepted") < kinds.indexOf("run.start"));
      assert.ok(kinds.indexOf("run.end") < kinds.indexOf("job.result"));
      assert.equal(forJob.find((e) => e.kind === "job.accepted")?.data.callback, undefined, "the callback URL stays out of the feed");
      const agentRun = feed.find((e) => e.kind === "run.start" && e.data.agent === "supabase-api");
      assert.equal(agentRun?.jobId, j, "the agent step's run carries the job id");
    } finally {
      await b.stop();
    }
  });
});
