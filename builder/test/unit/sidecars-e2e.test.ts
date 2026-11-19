/**
 * Sidecars end to end: a workflow run whose builder has the real tool-summariser agent (its agent.yml, SYSTEM.md and
 * prompt template, with settings.json and models.json pointed at the fake LLM, test/harness/fake-llm.ts) as a sidecar
 * every 3 tool.end events. A code step journals three tool.end events, so the sidecar starts: real pi, headless, no
 * workspace, no tools.
 *
 *   - It produces a summary: the step waits until the sidecar's output is in the journal, so the test sees a
 *     `sidecar.output` with the model's text, its artifact, its sidecar.start and sidecar.end, and the sidecar run as a
 *     child of the workflow run.
 *   - A hanging sidecar (the fake LLM never answers) does not delay the job: the step ends as soon as the sidecar has
 *     started, the job ends done, and the sidecar is stopped after its 10 s grace (E7), well inside its 2 min budget.
 *
 * Skipped when pi is not installed ($BUILDER_TEST_PI, default ~/.pi/agent/bin/pi).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJournal, type JournalEvent } from "../../runtime/journal.ts";
import { createRuntime } from "../../runtime/run.ts";
import { startFakeLlm, type FakeLlm } from "../harness/fake-llm.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const url = (rel: string) => JSON.stringify(pathToFileURL(join(BUILDER, rel)).href);
const REAL = join(BUILDER, "agentics", "agents", "tool-summariser");

const tmp = tempDir("builder-sidecars-e2e");
after(() => tmp.remove());
let n = 0;

/** An agent tree with the real tool-summariser on the fake LLM, and a builder whose step waits for `waitFor` in its journal. */
function setup(llm: FakeLlm, waitFor: "sidecar.output" | "sidecar.start") {
  const root = join(tmp.dir, `t-${++n}`);
  const agentics = join(root, "agentics");
  const agent = join(agentics, "agents", "tool-summariser");
  mkdirSync(join(agent, "prompts"), { recursive: true });
  for (const f of ["agent.yml", "SYSTEM.md", "prompts/summarise.md"]) copyFileSync(join(REAL, f), join(agent, f));
  writeTree(agent, llm.agentFiles());
  symlinkSync(join(BUILDER, "agentics", "shared"), join(agentics, "shared"));
  symlinkSync(join(BUILDER, "agentics", "builders"), join(agentics, "builders"));
  const builderModule = join(root, "sidecar-e2e-builder.mts");
  writeFileSync(
    builderModule,
    `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { code, defineBuilder } from ${url("engine/workflow.ts")};
import { sidecar } from ${url("engine/sidecars.ts")};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (ctx, kind) => {
  const file = join(ctx.runtime.dir(ctx.job.runId), "journal.jsonl");
  return existsSync(file) && readFileSync(file, "utf8").includes('"kind":"' + kind + '"');
};
export default defineBuilder({
  name: "sidecar-e2e",
  provides: [],
  budgetMinutes: 3,
  steps: [
    code("work", async (ctx) => {
      ctx.emit("tool.end", "npm test", { tool: "npm", isError: true, outcome: "error", output: "1 failing: createClient rejects a duplicate email" });
      ctx.emit("tool.end", "read", { tool: "read", isError: false, outcome: "ok", output: "export const createClient = () => {};" });
      ctx.emit("tool.end", "write", { tool: "write", isError: false, outcome: "ok", output: "Successfully wrote 120 bytes to src/slices/CreateClient/decide.ts" });
      const until = Date.now() + 90_000;
      while (Date.now() < until && !has(ctx, ${JSON.stringify(waitFor)})) await sleep(50);
      return { seen: has(ctx, ${JSON.stringify(waitFor)}) };
    }),
  ],
  sidecars: [sidecar("tool-summariser", { on: "tool.end", every: 3 })],
});
`,
  );
  const rt = createRuntime({ runsDir: join(root, "runs"), piCommand: PI, agenticsDir: agentics });
  const dispatch = {
    requires: ["stack:stub"],
    repo: { url: "file:///nowhere", base: "0000000" },
    task: { sliceId: "s-1", title: "CreateClient", context: "Clients", handover: false, attempt: 1 },
    slice: {},
    callback: "http://127.0.0.1:9/jobs/sidecar-e2e",
  };
  return { rt, builderModule, dispatch };
}

const one = (events: JournalEvent[], kind: string): JournalEvent => {
  const found = events.filter((e) => e.kind === kind);
  assert.equal(found.length, 1, `one ${kind} (got ${found.length})`);
  return found[0];
};

describe("sidecars end to end (real pi on the fake LLM)", () => {
  it("the tool-summariser sidecar summarises a batch of tool calls: sidecar.start, sidecar.output with an artifact, sidecar.end", { skip, timeout: 120_000 }, async () => {
    const SUMMARY = "Ran npm test, read createClient and wrote decide.ts.\nThe tests failed on a duplicate email.";
    const llm = await startFakeLlm([{ text: SUMMARY }]);
    try {
      const { rt, builderModule, dispatch } = setup(llm, "sidecar.output");
      const wf = await rt.start({ workflow: builderModule, input: { dispatch } });
      const result = await rt.wait(wf.id);
      const wfDir = rt.dir(wf.id);
      if (result.outcome !== "done") assert.fail(`the workflow failed: ${result.reason}\n${readFileSync(join(wfDir, "log"), "utf8").slice(-3000)}`);
      const wj = readJournal(wfDir);
      const start = one(wj, "sidecar.start");
      const output = one(wj, "sidecar.output");
      const end = one(wj, "sidecar.end");
      const stepEnd = wj.find((e) => e.kind === "step.end" && e.step === "work")!;
      assert.ok(start.seq < output.seq && output.seq < end.seq);
      assert.ok(output.seq < stepEnd.seq, "the output arrived while the job ran (the step waited for it)");
      assert.equal(output.data.text, SUMMARY);
      assert.equal(output.data.sidecar, "sidecar-tool-summariser");
      assert.equal(output.data.events, 3);
      const tools = wj.filter((e) => e.kind === "tool.end");
      assert.deepEqual(output.data.range, { from: { runId: wf.id, seq: tools[0].seq }, to: { runId: wf.id, seq: tools[2].seq } });
      assert.equal(end.data.status, "done");
      const artifact = join(wfDir, "artifacts", "sidecar-tool-summariser", "batch-1.md");
      assert.match(readFileSync(artifact, "utf8"), /The tests failed on a duplicate email\./);
      assert.ok(wj.some((e) => e.kind === "listener.artifact" && e.data.path === artifact));
      const summary = JSON.parse(readFileSync(join(wfDir, "summary.json"), "utf8")) as { listeners?: Record<string, { outputs?: number; batches?: number }> };
      assert.deepEqual({ batches: summary.listeners?.["sidecar-tool-summariser"]?.batches, outputs: summary.listeners?.["sidecar-tool-summariser"]?.outputs }, { batches: 1, outputs: 1 });

      // The sidecar run: a child of the workflow run, headless, no workspace, no tools, the small budget.
      const sc = rt.get(String(start.data.sidecarRunId))!;
      assert.equal(sc.parent, wf.id);
      assert.equal(sc.state, "done");
      assert.equal(sc.spec.agent, "tool-summariser");
      assert.equal(sc.spec.workspace, "none");
      assert.equal(sc.spec.budgetMinutes, 2);
      assert.equal(sc.resolved?.mode, "headless");
      assert.deepEqual(sc.resolved?.tools, []);
      assert.equal(sc.resolved?.cwd, rt.dir(sc.id));
      assert.ok(!wj.some((e) => e.data.childRunId === sc.id), "the sidecar is not a step's child: its journal is not followed");

      // What the model saw: the summariser's system prompt and template with the batch, and no tools.
      const body = JSON.stringify(llm.requests[0]);
      assert.match(body, /You summarise what a coding agent did/);
      assert.match(body, /Write two lines of plain text/);
      assert.match(body, /npm -> error: 1 failing: createClient rejects a duplicate email/);
      assert.match(body, /write -> ok: Successfully wrote 120 bytes/);
      assert.ok(!(llm.requests[0].tools as unknown[] | undefined)?.length, "no tools");
      assert.equal(llm.requests.length, 1);
    } finally {
      await llm.stop();
    }
  });

  it("a hanging sidecar never delays the job: the step goes on, the job ends done, the sidecar is stopped after its 10 s grace", { skip, timeout: 120_000 }, async () => {
    const llm = await startFakeLlm([{ text: "never sent" }]);
    llm.onRequest = () => new Promise<void>(() => {});
    try {
      const { rt, builderModule, dispatch } = setup(llm, "sidecar.start");
      const t0 = Date.now();
      const wf = await rt.start({ workflow: builderModule, input: { dispatch } });
      const result = await rt.wait(wf.id);
      const took = Date.now() - t0;
      const wfDir = rt.dir(wf.id);
      if (result.outcome !== "done") assert.fail(`the workflow failed: ${result.reason}\n${readFileSync(join(wfDir, "log"), "utf8").slice(-3000)}`);
      const wj = readJournal(wfDir);
      const stepEnd = wj.find((e) => e.kind === "step.end" && e.step === "work")!;
      assert.ok(Number(stepEnd.data.ms) < 10_000, `the step did not wait on the sidecar (${String(stepEnd.data.ms)} ms)`);
      const start = one(wj, "sidecar.start");
      const end = one(wj, "sidecar.end");
      assert.ok(stepEnd.seq < end.seq);
      assert.equal(end.data.status, "stopped");
      assert.match(String(end.data.reason), /job ended: sidecar-tool-summariser stopped after its 10 s grace/);
      assert.ok(!wj.some((e) => e.kind === "sidecar.output"));
      const runEnd = wj.find((e) => e.kind === "run.end")!;
      const afterSteps = Date.parse(runEnd.ts) - Date.parse(stepEnd.ts);
      assert.ok(afterSteps >= 9_000 && afterSteps < 25_000, `the run ended about the grace after its last step (${afterSteps} ms)`);
      assert.ok(took < 60_000, `the job took ${took} ms, far inside the sidecar's 2 min budget`);
      const sc = rt.get(String(start.data.sidecarRunId))!;
      assert.equal(sc.state, "stopped");
      assert.equal(llm.requests.length, 1, "the sidecar was waiting on the model");
    } finally {
      await llm.stop();
    }
  });
});
