/**
 * The journal end to end: a workflow run (clone, prepare, an agent step, checks, commit) whose agent is real pi on the
 * fake LLM (test/harness/fake-llm.ts), with the real shared:journal and shared:outcome extensions, offline.
 *
 * The scripted agent makes six tool calls over five turns (one of them to a tool it does not have), writes a file over
 * 8 KB holding a secret, then calls done. Between its second and third turn the test drops the run's journal socket
 * (SIGUSR2), so the rest of the run's events take the fallback file and are merged at run end (E12). The builder
 * carries a listener that always throws (E10) and one that emits a hint for failed tool calls.
 *
 * Skipped when pi is not installed ($BUILDER_TEST_PI, default ~/.pi/agent/bin/pi).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { payloadOf, readJournal, type JournalEvent } from "../../runtime/journal.ts";
import { createRuntime } from "../../runtime/run.ts";
import { readStory } from "../../engine/run-story.ts";
import { SLICE } from "../harness/dispatch.ts";
import { startFakeLlm } from "../harness/fake-llm.ts";
import { createFixtureRepo, FIXTURE_SETUP_COMMANDS } from "../harness/fixture-repo.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const url = (rel: string) => JSON.stringify(pathToFileURL(join(BUILDER, rel)).href);

const SECRET = "sk-e2e-0123456789abcdef";
const SLICE_DIR = `src/slices/${SLICE.contextName}/${SLICE.title}`;
const BIG = `# Notes\n\nToken ${SECRET} and header Authorization: Bearer abc.def.ghi\n\n${"lorem ipsum dolor sit amet ".repeat(500)}\n`;

const tmp = tempDir("builder-journal-e2e");
after(() => tmp.remove());

/** Each event of a journal: seq runs 1, 2, 3 ... with no gap. */
function assertContiguous(events: JournalEvent[], what: string): void {
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
    `${what}: seq runs from 1 without gaps`,
  );
}

describe("journal end to end (real pi on the fake LLM)", () => {
  it("every tool call is journaled with tool.start and tool.end; runs link; blobs, redaction, the fallback merge (E12) and a failing listener (E10)", { skip, timeout: 120_000 }, async () => {
    const llm = await startFakeLlm([
      { thinking: "The slice needs a look at the folder first.", text: "Looking around.", tools: [{ name: "ls", args: { path: "." } }] },
      { tools: [{ name: "read", args: { path: ".slice.json" } }, { name: "bash", args: { command: "echo hi" } }] },
      { tools: [{ name: "write", args: { path: `${SLICE_DIR}/notes.md`, content: BIG } }] },
      { tools: [{ name: "write", args: { path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" } }] },
      { tools: [{ name: "done", args: {} }] },
    ]);
    process.env.JOURNAL_E2E_TOKEN = SECRET;
    try {
      const repo = createFixtureRepo(tmp.dir);
      // A test agent tree: the real shared/ and builders/, and one agent on the fake LLM.
      const agentics = join(tmp.dir, "agentics");
      writeTree(agentics, {
        "agents/fake-agent/agent.yml": [
          "description: A test agent on the fake LLM",
          "mode: headless",
          "prompt: own:prompts/build.md",
          "uses:",
          "  extensions: [shared:outcome]",
          "tools:",
          "  enable: [read, write, ls, done, halt]",
          "",
        ].join("\n"),
        "agents/fake-agent/prompts/build.md": "Build the slice in $1 ($2).\n",
        ...Object.fromEntries(Object.entries(llm.agentFiles()).map(([f, c]) => [`agents/fake-agent/${f}`, c])),
      });
      symlinkSync(join(BUILDER, "agentics", "shared"), join(agentics, "shared"));
      symlinkSync(join(BUILDER, "agentics", "builders"), join(agentics, "builders"));

      const builderModule = join(tmp.dir, "journal-e2e-builder.mts");
      writeFileSync(
        builderModule,
        `import { agent, code, defineBuilder } from ${url("engine/workflow.ts")};
import { defineListener } from ${url("engine/listeners.ts")};
import { clone } from ${url("engine/steps/clone.ts")};
import { prepare } from ${url("engine/steps/prepare.ts")};
import { commitScopeChecks } from ${url("engine/steps/checks.ts")};
import { commit } from ${url("engine/steps/commit.ts")};
export default defineBuilder({
  name: "journal-e2e",
  provides: ["stack:stub"],
  budgetMinutes: 5,
  steps: [
    code("clone", clone({ repo: "app" })),
    code("prepare", prepare({ setup: ${JSON.stringify(FIXTURE_SETUP_COMMANDS)}, baseCheck: ["npx tsc --noEmit"], setupTimeoutMinutes: 1 })),
    agent("implement", { agent: "fake-agent", args: (ctx) => [".slice.json", ctx.job.dispatch.task.title], cwd: (ctx) => ctx.get("prepare").appDir, budgetMinutes: 2 }),
    code("checks", commitScopeChecks),
    code("commit", commit({ repo: "app" })),
  ],
  listeners: [
    defineListener({ name: "throws", on: "tool.end", handle() { throw new Error("listener boom"); } }),
    defineListener({ name: "hints", on: "tool.end", match: { isError: true }, handle(e, api) { api.emit("hint", { text: "tool " + e.data.tool + " failed" }); } }),
  ],
});
`,
      );

      const rt = createRuntime({ runsDir: join(tmp.dir, "runs"), piCommand: PI, agenticsDir: agentics });
      const dispatch = {
        requires: [repo.requirement, "stack:stub"],
        repo: { url: repo.url, base: repo.base },
        task: { sliceId: SLICE.id, title: SLICE.title, context: SLICE.contextName, handover: false, attempt: 1 },
        slice: SLICE,
        callback: `http://127.0.0.1:9/jobs/journal-e2e-1?token=${SECRET}`,
      };
      const wf = await rt.start({ workflow: builderModule, input: { dispatch } });
      // Before the third turn: drop the agent run's journal socket, and answer once the writer has let go (its socket
      // is gone). Nothing pi sends from then on is acknowledged, so all of it reaches the fallback file.
      llm.onRequest = async (n) => {
        if (n !== 2) return;
        const child = rt.list().find((r) => r.parent === wf.id && r.kind === "agent");
        assert.ok(child?.pid, "the agent run is running");
        const sock = join(rt.dir(child.id), "journal.sock");
        assert.ok(existsSync(sock), "the agent run's journal socket");
        process.kill(child.pid, "SIGUSR2");
        await waitFor("the writer to drop its clients", () => (existsSync(sock) ? undefined : true), 10_000, 10);
      };
      const result = await rt.wait(wf.id);
      const wfDir = rt.dir(wf.id);
      if (result.outcome !== "done") assert.fail(`the workflow failed: ${result.reason}\n${readFileSync(join(wfDir, "log"), "utf8").slice(-4000)}`);
      assert.ok(result.patches?.app, "a patch for the app repository");

      const child = rt.list().find((r) => r.parent === wf.id && r.kind === "agent")!;
      const childDir = rt.dir(child.id);
      const wj = readJournal(wfDir);
      const cj = readJournal(childDir);
      assertContiguous(wj, "the workflow run's journal");
      assertContiguous(cj, "the agent run's journal");

      // Links: the child's run.start names its parent; the parent's step events name the child.
      const childStart = cj.find((e) => e.kind === "run.start")!;
      assert.equal(childStart.seq, 1);
      assert.equal(childStart.parent, wf.id);
      assert.equal(childStart.step, "implement");
      assert.equal(childStart.agent, "fake-agent");
      const implement = wj.filter((e) => e.step === "implement" && (e.kind === "step.start" || e.kind === "step.end"));
      assert.deepEqual(implement.map((e) => [e.kind, e.data.childRunId]), [
        ["step.start", child.id],
        ["step.end", child.id],
      ]);
      assert.equal(wj[0].kind, "run.start");
      assert.equal(wj.find((e) => e.kind === "job.start")?.data.builder, "journal-e2e");
      assert.deepEqual(
        wj.filter((e) => e.kind === "step.end").map((e) => [e.step, e.data.status]),
        ["clone", "prepare", "implement", "checks", "commit"].map((s) => [s, "ok"]),
      );
      assert.equal(cj[cj.length - 1].kind, "run.end");

      // Every tool call the model made, with tool.start and tool.end, in its span.
      const calls = llm.requests.length;
      assert.equal(calls, 5, "five model requests: done ends the run");
      const ids = ["call_0_0", "call_1_0", "call_1_1", "call_2_0", "call_3_0", "call_4_0"];
      for (const id of ids) {
        assert.equal(cj.filter((e) => e.kind === "tool.start" && e.span === `t-${id}`).length, 1, `tool.start for ${id}`);
        assert.equal(cj.filter((e) => e.kind === "tool.end" && e.span === `t-${id}`).length, 1, `tool.end for ${id}`);
      }
      const end = (id: string) => cj.find((e) => e.kind === "tool.end" && e.span === `t-${id}`)!;
      assert.deepEqual([end("call_0_0").data.tool, end("call_0_0").data.outcome, end("call_0_0").data.isError], ["ls", "ok", false]);
      assert.deepEqual([end("call_1_1").data.tool, end("call_1_1").data.outcome, end("call_1_1").data.isError], ["bash", "invalid", true], "a tool the agent does not have");
      assert.equal(end("call_4_0").data.tool, "done");
      assert.equal(end("call_4_0").data.isError, false);
      assert.equal(cj.filter((e) => e.kind === "turn.end").length, 5);
      const usage = cj.filter((e) => e.kind === "model.usage");
      assert.equal(usage.length, 5);
      assert.deepEqual([usage[0].data.model, usage[0].data.input, usage[0].data.output, usage[0].data.cacheRead], ["fake/fake-model", 800, 50, 200]);
      assert.deepEqual(cj.find((e) => e.kind === "agent.outcome")?.data, { outcome: "done", changes: 2 });

      // The model's side: the model and thinking level, the system prompt sections, the prompt, and each response's
      // thinking, text and tool calls in its turn's span, before its usage.
      const selected = cj.find((e) => e.kind === "model.select");
      assert.deepEqual(selected?.data, { model: "fake/fake-model", thinking: "off" });
      const system = cj.find((e) => e.kind === "model.system")!;
      const sections = payloadOf(childDir, system.data.sections);
      const names = Object.keys(typeof sections === "string" ? (JSON.parse(sections) as object) : (sections as object));
      assert.ok(names.includes("preamble") && names.includes("tools"), `system prompt sections: ${names.join(", ")}`);
      const prompt = cj.find((e) => e.kind === "model.prompt")!;
      assert.equal(prompt.data.role, "user");
      assert.match(String(prompt.data.text), new RegExp(`Build the slice in \\.slice\\.json \\(${SLICE.title}\\)`));
      const messages = cj.filter((e) => e.kind === "model.message");
      assert.equal(messages.length, 5);
      assert.deepEqual(
        [messages[0].span, messages[0].data.thinking, messages[0].data.text, messages[0].data.toolCalls],
        ["u-0", "The slice needs a look at the folder first.", "Looking around.", [{ id: "call_0_0", name: "ls" }]],
      );
      assert.deepEqual(messages[1].data.toolCalls, [{ id: "call_1_0", name: "read" }, { id: "call_1_1", name: "bash" }]);
      assert.ok(messages.every((m) => cj.some((u) => u.kind === "model.usage" && u.span === m.span && u.seq > m.seq)), "each response's usage follows it");

      // The job's story: the workflow run and its agent run merged, from the journals alone.
      const story = readStory(join(tmp.dir, "runs"), wf.id, rt.list().map((r) => ({ id: r.id, parent: r.parent })));
      assert.deepEqual(story.runs.map((r) => r.runId), [wf.id, child.id]);
      const kinds = (k: string) => story.entries.filter((e) => e.kind === k);
      assert.equal(kinds("assistant").length, 5);
      assert.equal(kinds("system").length, 1);
      assert.equal(kinds("user").length, 1);
      assert.equal(kinds("tool").length + kinds("tool-error").length, 6);
      const first = kinds("assistant")[0];
      assert.equal(first.thinking, "The slice needs a look at the folder first.");
      assert.equal(first.text, "Looking around.");
      assert.deepEqual(first.calls, [{ id: "call_0_0", name: "ls", input: { path: "." } }]);
      assert.deepEqual(first.usage, { model: "fake/fake-model", input: 800, output: 50, cacheRead: 200, cacheWrite: 0, cost: first.usage!.cost });
      const write = kinds("assistant")[2].calls![0];
      assert.match(String((write.input as { content: string }).content), /\[redacted:JOURNAL_E2E_TOKEN\]/, "a call's input read back from its blob");
      const invalid = kinds("tool-error").find((e) => e.tool === "bash")!;
      assert.equal(invalid.outcome, "invalid");
      assert.ok(story.entries.some((e) => e.kind === "step" && e.step === "implement"), "the job's steps");
      assert.ok(story.entries.findIndex((e) => e.kind === "step" && e.line?.startsWith("implement started")) < story.entries.findIndex((e) => e.kind === "assistant"), "the step starts before the agent works");
      assert.deepEqual([story.metrics.turns, story.metrics.toolCalls, story.metrics.toolErrors, story.metrics.model, story.metrics.thinking], [5, 6, 1, "fake/fake-model", "off"]);

      // agent.start: the agent.yml and every resource with its hash, shared:journal included, and the model.
      const start = cj.find((e) => e.kind === "agent.start")!;
      assert.equal(start.data.model, "fake/fake-model");
      const resources = start.data.resources as { ref: string; sha256: string }[];
      for (const ref of ["shared:journal", "shared:outcome", "own:prompts/build.md"]) {
        const r = resources.find((x) => x.ref === ref);
        assert.match(r?.sha256 ?? "", /^[0-9a-f]{64}$/, `${ref} with its hash`);
      }
      assert.deepEqual(start.data.tools, ["read", "write", "ls", "done", "halt"]);

      // The 12 KB write: its input is in blobs/, the event keeps a 2 KB preview, and the secret is redacted in both.
      const big = cj.find((e) => e.kind === "tool.start" && e.span === "t-call_2_0")!;
      const marker = big.data.input as { blob: string; bytes: number; preview: string };
      assert.match(marker.blob, /^sha256:[0-9a-f]{64}$/);
      assert.ok(marker.bytes > 8 * 1024);
      assert.ok(marker.preview.length <= 2049);
      const blobFile = join(childDir, "blobs", marker.blob.slice(7));
      assert.ok(existsSync(blobFile), "the blob is in runs/<id>/blobs/");
      const full = payloadOf(childDir, marker) as string;
      assert.match(full, /\[redacted:JOURNAL_E2E_TOKEN\]/);
      assert.match(full, /Authorization: Bearer \[redacted\]/);
      for (const dir of [wfDir, childDir]) {
        const files = ["journal.jsonl", "summary.json", "context/job.json", ...(existsSync(join(dir, "blobs")) ? readdirSync(join(dir, "blobs")).map((b) => `blobs/${b}`) : [])];
        for (const f of files) if (existsSync(join(dir, f))) assert.ok(!readFileSync(join(dir, f), "utf8").includes(SECRET), `no secret in ${f}`);
      }
      assert.ok(readFileSync(join(wfDir, "context", "job.json"), "utf8").includes("[redacted:JOURNAL_E2E_TOKEN]"), "job.json is redacted");

      // E12: the dropped socket's events came through the fallback file and were merged.
      const merged = cj.filter((e) => e.kind === "journal.merged");
      assert.ok(merged.length >= 1, "a journal.merged event");
      // From the third turn on: 3 tool calls (start and end), 3 usages, 3 turn ends and the outcome, each either merged
      // or (the writer read it while letting go) dropped there as a copy.
      const fromFallback = merged.reduce((n, e) => n + Number(e.data.events) + Number(e.data.skipped), 0);
      assert.ok(fromFallback >= 13, `the later events went through the fallback file (${fromFallback})`);
      assert.ok(!existsSync(join(childDir, "journal.fallback.jsonl")), "the fallback file is gone once merged");

      // E10: the throwing listener is off after three errors; the build was unaffected; the other listener kept going.
      const errors = wj.filter((e) => e.kind === "listener.error" && e.data.listener === "throws");
      assert.equal(errors.length, 3);
      assert.equal(errors[0].data.error, "listener boom");
      assert.equal(wj.filter((e) => e.kind === "listener.off" && e.data.listener === "throws").length, 1);
      assert.deepEqual(
        wj.filter((e) => e.kind === "hint").map((e) => e.data),
        [{ text: "tool bash failed", listener: "hints" }],
      );

      // summary.json: the run's metrics, its tree, step durations and the metrics listener's totals.
      const summary = JSON.parse(readFileSync(join(wfDir, "summary.json"), "utf8"));
      assert.equal(summary.tree.toolCalls, 6);
      assert.equal(summary.tree.turns, 5);
      assert.deepEqual(summary.children, [child.id]);
      assert.equal(summary.steps.length, 5);
      assert.equal(summary.listeners.metrics.steps.implement.toolCalls, 6);
      assert.equal(summary.listeners.metrics.tools.write.calls, 2);
      const childSummary = JSON.parse(readFileSync(join(childDir, "summary.json"), "utf8"));
      assert.equal(childSummary.metrics.toolErrors, 1);

      // The commit trailers come from the journals.
      const patch = result.patches!.app;
      assert.match(patch, /^Agent: pi fake\/fake-model$/m);
      assert.match(patch, /^Agent-Turns: 5$/m);
      assert.match(patch, /^Agent-Tool-Calls: 6 \(1 errors\)$/m);
      assert.match(patch, /^Agent-Tokens: input 4000, cache read 1000, output 250$/m);
      assert.match(patch, /^Agent-Cost: \$0\.0050$/m);
      assert.match(patch, /^Builder: journal-e2e$/m);
      assert.match(patch, /^Builder-Version: [0-9a-f]{12}$/m);
      assert.match(patch, /^Step-Durations: clone \d+s, prepare \d+s, implement \d+s, checks \d+s$/m);
    } finally {
      delete process.env.JOURNAL_E2E_TOKEN;
      await llm.stop();
    }
  });
});
