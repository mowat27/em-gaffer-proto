/**
 * The ops agent investigates a failed job, end to end in real pi on the fake LLM (scripted, no real model, no push).
 *
 * A job's workflow run fails in a code step; the server's `job.result` (outcome failed) goes to the machine feed. The
 * ops agent, its real agent.yml, SYSTEM.md and the shared tree in a temp agent tree (only its model pointed at the fake
 * LLM, its API on a free port, its gate named by the real file's path, and its daily cron left out, so the schedule
 * cannot take a scripted turn), runs durable with a journal. Its job.failed trigger starts a turn naming the run and the reason. The script then calls
 * journal_query on the failed run, run_start of the fixed workflow on the same dispatch, run_wait on that check run,
 * and notify_operator, in that order, and ends the turn. The notification is in control/notifications.jsonl and the
 * feed; the check run is the ops run's child and done; the durable run stays up until it is stopped.
 *
 * Skipped when pi is not installed.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendFeed, readFeed } from "../../runtime/feed.ts";
import { readJournal, type JournalEvent } from "../../runtime/journal.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "../../runtime/root.ts";
import { createRuntime } from "../../runtime/run.ts";
import { isFinal } from "../../runtime/types.ts";
import { startFakeLlm, type FakeTurn } from "../harness/fake-llm.ts";
import { freePort, tempDir, waitFor } from "../harness/util.ts";

const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const tmp = tempDir("builder-ops-e2e");
after(() => tmp.remove());

type Body = { messages?: { role: string; content?: unknown; tool_call_id?: string }[] };
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
/** The user messages of a request, as text. */
const userText = (b: Body) => (b.messages ?? []).filter((m) => m.role === "user").map((m) => text(m.content)).join("\n");
/** A tool result in a request, by tool call id. */
const toolResult = (b: Body, id: string) => text((b.messages ?? []).find((m) => m.role === "tool" && m.tool_call_id === id)?.content ?? "");

/** A builder module of one code step, importing the real engine. */
const builderModule = (name: string, body: string) =>
  `import { code, defineBuilder } from ${JSON.stringify(join(BUILDER_ROOT, "engine", "workflow.ts"))};\n` +
  `export default defineBuilder({ name: ${JSON.stringify(name)}, provides: [], steps: [code("check", async () => { ${body} })] });\n`;

const REASON = "the slice has no command: nothing to build";
const DISPATCH = {
  requires: ["repo:fixture"],
  repo: { url: "file:///nowhere", base: "0000000000000000000000000000000000000000" },
  task: { sliceId: "s-ops-e2e", title: "CreateClient", context: "Clients", handover: false, attempt: 1 },
  slice: {},
  callback: "http://127.0.0.1:9/jobs/job-ops-e2e",
};

describe("the ops agent on a failed job", () => {
  it("is woken by job.failed and calls journal_query, run_start (the check run), run_wait and notify_operator, in order", { skip, timeout: 240_000 }, async () => {
    const runsDir = join(tmp.dir, "runs");
    const agentics = join(tmp.dir, "agentics");
    const builders = join(tmp.dir, "builders");
    mkdirSync(builders, { recursive: true });
    const failing = join(builders, "failing.ts");
    const fixed = join(builders, "fixed.ts");
    writeFileSync(failing, builderModule("ops-e2e", `throw new Error(${JSON.stringify(REASON)});`));
    writeFileSync(fixed, builderModule("ops-e2e-fixed", `return { ok: true };`));

    // The fake LLM reads its script by reference: the turns are added once the failed run's id is known.
    const script: FakeTurn[] = [];
    const llm = await startFakeLlm(script);
    // A durable run never ends by itself: whatever happens, it is stopped, so the test process can exit.
    let stopOps: () => Promise<void> = async () => {};
    try {
      // The real ops agent, its model pointed at the fake LLM; the real shared tree (skills, gates, listeners).
      const ops = join(agentics, "agents", "ops");
      mkdirSync(ops, { recursive: true });
      for (const f of ["SYSTEM.md", "MEMORY.md"]) cpSync(join(AGENTICS_DIR, "agents", "ops", f), join(ops, f));
      const port = await freePort();
      const yml = readFileSync(join(AGENTICS_DIR, "agents", "ops", "agent.yml"), "utf8");
      // The gate by its real path: the gate host loads a gate from the path it is given, and write-scope's relative
      // imports (engine/, builders/) resolve only from the real tree.
      const ours = yml
        .replace("listen: 127.0.0.1:8090", `listen: 127.0.0.1:${port}`)
        .replace(/^ {2}- \{ cron: .*\n/m, "")
        .replace("gates: [shared:write-scope]", `gates: [${JSON.stringify(join(AGENTICS_DIR, "shared", "gates", "write-scope.ts"))}]`);
      assert.match(ours, new RegExp(`listen: 127\\.0\\.0\\.1:${port}`), "the API on a free port");
      assert.doesNotMatch(ours, /shared:write-scope/, "the real gate file");
      assert.doesNotMatch(ours, /cron:/, "the daily trigger is left out");
      assert.match(ours, /- \{ on: job\.failed \}/);
      writeFileSync(join(ops, "agent.yml"), ours);
      for (const [f, c] of Object.entries(llm.agentFiles())) writeFileSync(join(ops, f), c);
      symlinkSync(join(AGENTICS_DIR, "shared"), join(agentics, "shared"));

      // The machine config every run in the tree reads: these runs, no limit, no notify sink (nothing leaves the test).
      const layer = join(tmp.dir, "layer.yml");
      writeFileSync(layer, `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n  notify: []\n`);
      delete process.env.GAFFER_CONFIG;
      delete process.env.GAFFER_INSTANCE;
      process.env.OPS_API_TOKEN = "ops-e2e-token";
      const rt = createRuntime({ runsDir, piCommand: PI, agenticsDir: agentics, configFiles: [layer] });

      // The ops agent, durable with a journal, armed before anything fails (its first run starts at the feed's end).
      const opsRun = await rt.start({ agent: "ops", workspace: "none", journal: true });
      stopOps = () => rt.stop(opsRun.id, "the test is done");
      assert.equal(opsRun.resolved?.mode, "durable");
      const opsDir = rt.dir(opsRun.id);
      const journal = (kind?: string): JournalEvent[] => readJournal(opsDir, kind ? { kind } : {});
      await waitFor(
        "the ops run's triggers.armed (runtime/triggers.ts)",
        () => {
          const rec = rt.get(opsRun.id);
          if (rec && isFinal(rec.state)) assert.fail(`the ops run ended: ${JSON.stringify(rec.result)}`);
          return journal("triggers.armed").length ? true : undefined;
        },
        30_000,
        100,
      );

      // A job fails: its workflow run fails in its code step, and the server's job.result goes to the feed.
      const job = await rt.start({ workflow: failing, workspace: "none", input: { dispatch: DISPATCH } }, { job: { jobId: "job-ops-e2e", callback: DISPATCH.callback } });
      assert.deepEqual(await rt.wait(job.id), { outcome: "failed", reason: REASON });

      // The script: one turn per request. run_wait names the check run that run_start answered with.
      let checkRun = "";
      llm.onRequest = (n, body) => {
        if (n !== 2) return;
        checkRun = /"runId": "([^"]+)"/.exec(toolResult(body as Body, "c-start"))?.[1] ?? "(run_start gave no runId)";
        script[2] = { tools: [{ name: "run_wait", args: { run: checkRun, timeoutSeconds: 120 }, id: "c-wait" }] };
      };
      const summary = `${job.id} failed in step check (${REASON}); the fixed workflow passes on the same dispatch`;
      script.push(
        { tools: [{ name: "journal_query", args: { run: job.id, kind: "step.end" }, id: "c-query" }] },
        { tools: [{ name: "run_start", args: { workflow: fixed, workspace: "none", input: { dispatch: DISPATCH } }, id: "c-start" }] },
        { text: "(replaced once run_start has answered)" },
        { tools: [{ name: "notify_operator", args: { severity: "info", summary, runId: job.id, link: "origin/ops/job-ops-e2e-fix" }, id: "c-notify" }] },
        { text: "Investigated and reported." },
      );
      assert.equal(llm.requests.length, 0, "nothing has spoken to the model before the failure");

      appendFeed(runsDir, { kind: "job.result", jobId: "job-ops-e2e", runId: job.id, data: { outcome: "failed", reason: REASON } });

      await waitFor("the trigger's turn to reach the model (the job.failed trigger)", () => (llm.requests.length > 0 ? true : undefined), 60_000, 100);
      await waitFor("the scripted investigation to finish", () => (llm.requests.length >= 5 ? true : undefined), 120_000, 100);
      await waitFor("notify_operator's tool.end in the ops run's journal", () => (journal("tool.end").some((e) => e.data.tool === "notify_operator") ? true : undefined), 20_000, 100);

      const req = llm.requests as Body[];
      // The trigger's turn names the failed run and the reason.
      assert.match(userText(req[0]), new RegExp(`job\\.failed: job .*\\(job-ops-e2e\\) failed, workflow run ${job.id}`));
      assert.match(userText(req[0]), new RegExp(`Reason: ${REASON}`));
      const fired = journal("trigger.fired");
      assert.equal(fired.length, 1);
      assert.equal(fired[0].data.trigger, "job.failed");
      assert.equal(fired[0].data.runId, job.id);

      // The calls, in order, each through the tool core.
      const calls = journal("tool.end").map((e) => [e.data.tool, e.data.isError]);
      assert.deepEqual(calls, [
        ["journal_query", false],
        ["run_start", false],
        ["run_wait", false],
        ["notify_operator", false],
      ]);
      assert.match(toolResult(req[1], "c-query"), /"kind": "step.end"/, "journal_query read the failed run's journal");
      assert.match(toolResult(req[1], "c-query"), new RegExp(REASON));
      assert.match(toolResult(req[3], "c-wait"), /"outcome": "done"/, "the check run passed");

      // The check run: the ops run's child, the fixed workflow on the same dispatch.
      const check = rt.get(checkRun)!;
      assert.equal(check.parent, opsRun.id);
      assert.equal(check.spec.workflow, fixed);
      assert.deepEqual(check.result, { outcome: "done" });

      // The notification: recorded beside the runs (control/notifications.jsonl) and in the machine feed.
      const recorded = readFileSync(join(tmp.dir, "control", "notifications.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].severity, "info");
      assert.equal(recorded[0].summary, summary);
      assert.equal(recorded[0].runId, job.id);
      assert.equal(recorded[0].link, "origin/ops/job-ops-e2e-fix");
      assert.ok(readFeed(runsDir, { kind: "notification" }).some((e) => JSON.stringify(e.data).includes(summary)), "the notification is in the feed");

      // Durable: the run stays up after its turn, until it is stopped.
      assert.equal(rt.get(opsRun.id)?.state, "running");
      await rt.stop(opsRun.id, "the test is done");
      assert.ok(isFinal(rt.get(opsRun.id)!.state));
    } finally {
      await stopOps().catch(() => {});
      await llm.stop();
    }
  });
});
