/**
 * The scaffold end to end: a workflow run (clone, prepare, classify, scaffold, an agent step, checks, commit) whose agent
 * is real pi on the fake LLM (test/harness/fake-llm.ts) with the real shared:context and shared:outcome, offline.
 *
 * The set renders a command file with a BUILD: marker and a test file. The scripted agent reads the scaffold report
 * with context_get, calls done (refused: the marker is left), fills the marker, and calls done again.
 *
 * Skipped when pi is not installed ($BUILDER_TEST_PI, default ~/.pi/agent/bin/pi).
 */
import assert from "node:assert/strict";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJournal } from "../../runtime/journal.ts";
import { createRuntime } from "../../runtime/run.ts";
import { SLICE } from "../harness/dispatch.ts";
import { startFakeLlm } from "../harness/fake-llm.ts";
import { createFixtureRepo, FIXTURE_SETUP_COMMANDS } from "../harness/fixture-repo.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const url = (rel: string) => JSON.stringify(pathToFileURL(join(BUILDER, rel)).href);

const SLICE_DIR = `src/slices/${SLICE.contextName}/${SLICE.title}`;
const COMMAND = `${SLICE_DIR}/${SLICE.title}Command.ts`;

const tmp = tempDir("builder-scaffold-e2e");
after(() => tmp.remove());

describe("scaffold end to end (real pi on the fake LLM)", () => {
  it("the agent starts from the scaffold: the summary in its prompt, the report through context_get, done refuses a marker left", { skip, timeout: 120_000 }, async () => {
    const llm = await startFakeLlm([
      { tools: [{ name: "context_get", args: { step: "scaffold" } }] },
      { tools: [{ name: "done", args: {} }] },
      { tools: [{ name: "write", args: { path: COMMAND, content: "export const decide = () => [];\n" } }] },
      { tools: [{ name: "done", args: {} }] },
    ]);
    try {
      const repo = createFixtureRepo(tmp.dir);
      const agentics = join(tmp.dir, "agentics");
      writeTree(agentics, {
        "agents/fake-agent/agent.yml": [
          "description: A test agent on the fake LLM",
          "mode: headless",
          "prompt: own:prompts/implement.md",
          "uses:",
          "  extensions: [shared:context, shared:outcome]",
          "tools:",
          "  enable: [read, write, ls, context_get, done, halt]",
          "",
        ].join("\n"),
        "agents/fake-agent/prompts/implement.md": "Implement the slice in $1 ($2).\n",
        ...Object.fromEntries(Object.entries(llm.agentFiles()).map(([f, c]) => [`agents/fake-agent/${f}`, c])),
      });
      symlinkSync(join(BUILDER, "agentics", "shared"), join(agentics, "shared"));
      symlinkSync(join(BUILDER, "agentics", "builders"), join(agentics, "builders"));
      const templates = writeTree(join(tmp.dir, "templates"), {
        "state-change/src/slices/{{context}}/{{pascal slice}}/{{pascal slice}}Command.ts.hbs": "export const decide = () => {\n  // BUILD: decide for {{slice}}\n  return [];\n};\n",
        "state-change/src/slices/{{context}}/{{pascal slice}}/{{pascal slice}}.test.ts.hbs": "it('{{slice}}', () => {});\n",
      });

      const builderModule = join(tmp.dir, "scaffold-e2e-builder.mts");
      writeFileSync(
        builderModule,
        `import { agent, code, defineBuilder, template } from ${url("engine/workflow.ts")};
import { clone } from ${url("engine/steps/clone.ts")};
import { prepare } from ${url("engine/steps/prepare.ts")};
import { classify } from ${url("engine/steps/classify.ts")};
import { commitScopeChecks } from ${url("engine/steps/checks.ts")};
import { commit } from ${url("engine/steps/commit.ts")};
import { templatesDir } from ${url("agentics/builders/supabase-api/builder.ts")};
import { viewModel } from ${url("agentics/builders/supabase-api/view-model.ts")};
const appDir = (ctx) => ctx.get("prepare").appDir;
export default defineBuilder({
  name: "scaffold-e2e",
  provides: ["stack:stub"],
  budgetMinutes: 5,
  steps: [
    code("clone", clone({ repo: "app" })),
    code("prepare", prepare({ setup: ${JSON.stringify(FIXTURE_SETUP_COMMANDS)}, baseCheck: ["npx tsc --noEmit"], setupTimeoutMinutes: 1 })),
    code("classify", classify),
    template("scaffold", { set: (ctx) => templatesDir(ctx.get("classify").kind, ${JSON.stringify(templates)}), data: (ctx) => viewModel(ctx.get("classify"), ctx), dir: appDir }),
    agent("implement", { agent: "fake-agent", args: (ctx) => [".slice.json", ctx.job.dispatch.task.title], cwd: appDir, budgetMinutes: 2 }),
    code("checks", commitScopeChecks),
    code("commit", commit({ repo: "app" })),
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
        changes: { verdict: "NEW", since: null },
        callback: "http://127.0.0.1:9/jobs/scaffold-e2e-1",
      };
      const wf = await rt.start({ workflow: builderModule, input: { dispatch } });
      const result = await rt.wait(wf.id);
      const wj = readJournal(rt.dir(wf.id));
      if (result.outcome !== "done") assert.fail(`the workflow failed: ${result.reason}\n${JSON.stringify(wj.slice(-12), null, 2)}`);

      // The workflow: classify and scaffold ran before the agent, and the scaffold journaled each file.
      assert.deepEqual(
        wj.filter((e) => e.kind === "step.end").map((e) => [e.step, e.data.status]),
        ["clone", "prepare", "classify", "scaffold", "implement", "checks", "commit"].map((s) => [s, "ok"]),
      );
      assert.deepEqual(wj.find((e) => e.kind === "classify")?.data.kind, "state-change");
      assert.deepEqual(
        wj.filter((e) => e.kind === "scaffold.file").map((e) => [e.data.path, e.data.action]),
        [
          [`${SLICE_DIR}/${SLICE.title}.test.ts`, "created"],
          [COMMAND, "created"],
        ],
      );

      // The agent: the slice section in its system prompt, the report through context_get, done refusing the marker.
      const request = (n: number) => JSON.stringify(llm.requests[n] ?? {});
      assert.match(request(0), /<builder_slice>/);
      assert.match(request(0), /Slice Billing\/CreateThing: a state-change slice, verdict NEW/);
      assert.match(request(0), /BUILD: markers to fill: 1 \(src\/slices\/Billing\/CreateThing\/CreateThingCommand\.ts 1\)/);
      assert.match(request(1), /\\"markers\\": \[/, "context_get returned the scaffold report");
      assert.match(request(1), /BUILD: decide for CreateThing/);
      assert.match(request(2), /done refused/);
      assert.match(request(2), /\[build-markers\] 1 BUILD: marker\(s\) left by the scaffold/);
      assert.equal(llm.requests.length, 4, "the second done ended the run");

      // The patch: the filled command and the scaffold's test file.
      const patch = result.patches!.app;
      assert.match(patch, /\+export const decide = \(\) => \[\];/);
      assert.match(patch, /\+it\('CreateThing', \(\) => \{\}\);/);
      assert.doesNotMatch(patch, /BUILD:/);
      assert.match(patch, /^Step-Durations: clone \d+s, prepare \d+s, classify \d+s, scaffold \d+s, implement \d+s, checks \d+s$/m);
    } finally {
      await llm.stop();
    }
  });
});
