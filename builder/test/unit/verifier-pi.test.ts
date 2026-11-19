/**
 * The verifier's extension in real pi on the fake LLM, with `verify` from the tool core: the pi adapter registers the
 * core's verify beside the extension's try_rules (one tool of each name); verify runs the tree's verifier (a
 * stand-in here); the extension follows its result and remembers the build (its system prompt section names it from
 * the next prompt on); and try_rules with no workspace verifies that build again through the same core function (the
 * real verifier's run.ts, on a build that changed nothing, so no Jev call). Skipped when pi is not installed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readJournal } from "../../runtime/journal.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import { createRuntime } from "../../runtime/run.ts";
import { startFakeLlm } from "../harness/fake-llm.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const tmp = tempDir("builder-verifier-pi");
after(() => tmp.remove());

type Body = { messages?: { role: string; tool_call_id?: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] };
const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function?.name ?? "").sort();
const results = (b: Body): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of b.messages ?? []) if (m.role === "tool" && m.tool_call_id) out[m.tool_call_id] = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return out;
};
const system = (b: Body) => JSON.stringify((b.messages ?? []).filter((m) => m.role === "system"));

describe("the verifier's extension with the core's verify, in real pi", () => {
  it("verify comes from the core, the extension remembers the build, try_rules re-verifies it with the real verifier", { skip, timeout: 120_000 }, async () => {
    const ws = join(tmp.dir, "ws");
    writeTree(ws, {
      "verdict.json": JSON.stringify({ verdict: "pass", summary: "2 checks, 0 failed, 0 unsure", findings: [] }),
      "src/index.ts": "export const x = 1;\n",
      ".slice.json": '{ "title": "T", "sliceType": "STATE_CHANGE", "context": "C" }\n',
    });
    git(ws, ["init", "-q", "-b", "main"]);
    git(ws, ["add", "verdict.json", "src"]);
    git(ws, ["commit", "-q", "-m", "base"]);

    const llm = await startFakeLlm([
      { tools: [{ name: "verify", args: { workspace: ws }, id: "c-verify" }] },
      { tools: [{ name: "try_rules", args: { action: "verify" }, id: "c-try" }] },
      { text: "PASS" },
    ]);
    try {
      const agentics = writeTree(join(tmp.dir, "agentics"), {
        "package.json": '{ "type": "module" }\n',
        // The tree's verifier, which the core's verify runs: a stand-in that prints the workspace's verdict.json.
        "agents/verifier/agent.yml": "description: a stand-in verifier\nmode: headless\n",
        "agents/verifier/run.ts": `import { readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
console.log(readFileSync(join(args[args.indexOf("--workspace") + 1], "verdict.json"), "utf8"));
`,
        "agents/vlab/agent.yml": `description: the verifier's extension on the fake LLM\nmode: headless\nuses: { extensions: [${JSON.stringify(join(AGENTICS_DIR, "agents", "verifier", "extensions", "verifier.ts"))}] }\ntools: { enable: [read, verify, try_rules] }\n`,
        ...Object.fromEntries(Object.entries(llm.agentFiles()).map(([f, c]) => [`agents/vlab/${f}`, c])),
      });
      const rt = createRuntime({ runsDir: join(tmp.dir, "runs"), piCommand: PI, agenticsDir: agentics });
      const rec = await rt.start({ agent: "vlab", input: { message: "verify it" }, workspace: "none", journal: true });
      const result = await rt.wait(rec.id);
      const journal = readJournal(rt.dir(rec.id));
      if (result.outcome !== "done") assert.fail(`the run failed: ${result.reason}\n${JSON.stringify(journal.slice(-8), null, 2)}`);

      const req = llm.requests as Body[];
      assert.equal(req.length, 3);
      assert.deepEqual(toolNames(req[0]), ["read", "try_rules", "verify"]);
      assert.match(system(req[0]), /No build has been verified in this session yet/);
      const verified = JSON.parse(results(req[1])["c-verify"]);
      assert.deepEqual([verified.verdict, verified.workspace, verified.base], ["pass", ws, "HEAD"], "the core ran the tree's (stand-in) verifier");
      const tried = JSON.parse(results(req[2])["c-try"]);
      assert.deepEqual([tried.verdict, tried.summary, tried.workspace], ["fail", "the build changed no files", ws], "try_rules re-verified the last build with the real verifier");
      const ends = journal.filter((e) => e.kind === "tool.end").map((e) => [e.data.tool, e.data.isError]);
      assert.deepEqual(ends, [
        ["verify", false],
        ["try_rules", false],
      ]);
    } finally {
      await llm.stop();
    }
  });
});
