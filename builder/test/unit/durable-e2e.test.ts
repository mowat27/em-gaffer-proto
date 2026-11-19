/**
 * A durable run end to end, real pi on the fake LLM (D17, D20, E20): an agent with `triggers: [{ on: job.failed }]`
 * runs durably; the operator's run_send starts a turn; a server job failing (a job.result in the machine feed) while
 * that turn runs is queued and becomes the next turn; trigger.fired and message.received are in the run's journal and
 * the failure handed over is in the agent's state/. Stopped, it misses a failure; started again it resumes its session
 * (the model sees the earlier turns) and catches up on that failure first. Skipped when pi is not installed.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool } from "../../ops/core/tool.ts";
import { appendFeed, readFeed } from "../../runtime/feed.ts";
import { readJournal } from "../../runtime/journal.ts";
import { createRuntime } from "../../runtime/run.ts";
import { isFinal } from "../../runtime/types.ts";
import { startFakeLlm } from "../harness/fake-llm.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const tmp = tempDir("builder-durable-e2e");
after(() => tmp.remove());

type Body = { messages?: { role: string; content?: unknown }[] };
const text = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");
/** The user messages of a request, in order. */
const userTexts = (b: Body) => (b.messages ?? []).filter((m) => m.role === "user").map((m) => text(m.content));
const assistantTexts = (b: Body) => (b.messages ?? []).filter((m) => m.role === "assistant").map((m) => text(m.content));

describe("a durable run on the fake LLM", () => {
  it("takes a message and a job.failed trigger (queued while a turn runs); restarted, it resumes its session and catches up", { skip, timeout: 180_000 }, async () => {
    const runsDir = join(tmp.dir, "runs");
    const llm = await startFakeLlm([{ text: "Hello, operator." }, { text: "Looking at the failed job." }, { text: "Caught up on the missed failure." }]);
    try {
      const agentics = writeTree(join(tmp.dir, "agentics"), {
        "agents/watcher/agent.yml": "description: A durable watcher on the fake LLM\nmode: durable\ntools: { enable: [read] }\ntriggers:\n  - { on: job.failed }\n",
        ...Object.fromEntries(Object.entries(llm.agentFiles()).map(([f, c]) => [`agents/watcher/${f}`, c])),
      });
      const stateFile = join(agentics, "agents", "watcher", "state", "triggers.json");
      const rt = createRuntime({ runsDir, piCommand: PI, agenticsDir: agentics });
      writeTree(tmp.dir, { "layer.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` });
      const operator = cliContext(loadConfig({ packaged: join(tmp.dir, "absent.yml"), userConfig: join(tmp.dir, "absent.yml"), env: {}, configPath: join(tmp.dir, "layer.yml") }), rt);

      const rec = await rt.start({ agent: "watcher", workspace: "none" });
      assert.deepEqual(rec.resolved?.triggers, [{ on: "job.failed" }]);
      const dir = rt.dir(rec.id);
      // While the model answers the message, a server job fails: the trigger's turn is queued behind it.
      llm.onRequest = async (n) => {
        if (n !== 0) return;
        appendFeed(runsDir, { kind: "job.result", jobId: "job-e2e-1", runId: "20990101-000000-aaaaaa", data: { outcome: "failed", reason: "tsc failed during implement" } });
        await waitFor("the trigger to be handed to pi", () => readJournal(dir, { kind: "trigger.fired" })[0], 30_000, 100);
      };
      await waitFor("the control socket", () => rt.get(rec.id)?.socket, 30_000, 100);
      await waitFor("the triggers to be armed", () => readJournal(dir, { kind: "triggers.armed" })[0], 30_000, 100);
      const sent = (await callTool("run_send", { target: rec.id, message: "Hello there" }, operator)) as { disposition: string };
      assert.equal(sent.disposition, "started");
      await waitFor("the trigger's turn", () => (llm.requests.length >= 2 ? true : undefined), 60_000, 100);

      const req = llm.requests as Body[];
      assert.deepEqual(userTexts(req[0]), ["Hello there"]);
      const triggerTurn = userTexts(req[1]).at(-1) ?? "";
      assert.match(triggerTurn, /^job\.failed: job [a-z]+-[a-z]+ \(job-e2e-1\) failed, workflow run 20990101-000000-aaaaaa\.\nReason: tsc failed during implement$/);
      assert.deepEqual(assistantTexts(req[1]), ["Hello, operator."], "the queued turn came after the first one ended");
      const received = readJournal(dir, { kind: "message.received" });
      assert.deepEqual([received.length, received[0].data.via, received[0].data.message, received[0].data.disposition], [1, "run_send", "Hello there", "started"]);
      const fired = readJournal(dir, { kind: "trigger.fired" })[0];
      assert.deepEqual([fired.data.trigger, fired.data.jobId, fired.data.disposition, fired.data.accepted], ["job.failed", "job-e2e-1", "queued", true]);
      const failedSeq = readFeed(runsDir, { kind: "job.result" })[0].seq;
      assert.equal((JSON.parse(readFileSync(stateFile, "utf8")) as { jobFailed: { seq: number } }).jobFailed.seq, failedSeq, "state/ keeps the failure handed over");
      await waitFor("the trigger's turn to be journaled", () => readJournal(dir, { kind: "turn.end" }).length >= 2 || undefined, 30_000, 100);
      await rt.stop(rec.id, "restart");

      // Down: one job fails, one succeeds. Started again, the run resumes its session and catches up on the failure.
      appendFeed(runsDir, { kind: "job.result", jobId: "job-e2e-2", runId: "20990101-000000-bbbbbb", data: { outcome: "failed", reason: "the agent finished without calling done" } });
      appendFeed(runsDir, { kind: "job.result", jobId: "job-e2e-3", runId: "20990101-000000-cccccc", data: { outcome: "done", patchBytes: 120 } });
      const again = await rt.start({ agent: "watcher", workspace: "none" });
      assert.ok(again.resolved!.argv.includes("--fork"), "the durable session is carried into the new run");
      await waitFor("the catch-up turn", () => (llm.requests.length >= 3 ? true : undefined), 60_000, 100);
      const resumed = req[2];
      assert.match(userTexts(resumed).at(-1) ?? "", /\(job-e2e-2\)[\s\S]*Reason: the agent finished without calling done\n\(Caught up when this run started: the job failed at /);
      assert.deepEqual(userTexts(resumed).slice(0, 2), ["Hello there", triggerTurn], "the model sees the earlier turns");
      const armed = await waitFor("triggers.armed", () => readJournal(rt.dir(again.id), { kind: "triggers.armed" })[0], 10_000, 100);
      assert.equal(armed.data.caughtUp, 1);
      const caught = await waitFor("trigger.fired", () => readJournal(rt.dir(again.id), { kind: "trigger.fired" })[0], 10_000, 100);
      assert.deepEqual([caught.data.jobId, caught.data.catchUp], ["job-e2e-2", true]);
      await rt.stop(again.id, "test over");
    } finally {
      // A run left live would keep this test's process alive.
      const runs = createRuntime({ runsDir, piCommand: PI });
      for (const r of runs.list()) if (!isFinal(r.state)) await runs.stop(r.id, "test cleanup");
      await llm.stop();
    }
  });
});
