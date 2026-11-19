/**
 * The pi adapter (ops/pi-extension.ts) in real pi on the fake LLM: the runner loads it for an agent whose tools
 * include an ops/core tool, and it registers exactly the run's allowed core tools. The scripted agent calls one (it
 * runs), one its agent.yml does not enable (pi never had it), and, after an operator's config_reload took it away
 * mid-turn, one it still had registered (the core refuses it). When that turn ends the tool is taken away, so the next
 * request no longer offers it, and the journal has config.loaded. Skipped when pi is not installed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool } from "../../ops/core/tool.ts";
import { readJournal } from "../../runtime/journal.ts";
import { PI_EXTENSION } from "../../runtime/pi.ts";
import { createRuntime } from "../../runtime/run.ts";
import { startFakeLlm } from "../harness/fake-llm.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const skip = existsSync(PI) ? false : `pi is not installed at ${PI}`;
const tmp = tempDir("builder-pi-extension");
after(() => tmp.remove());

type Body = { messages?: { role: string; tool_call_id?: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] };
const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function?.name ?? "").sort();
/** The tool results in a request, by tool call id. */
function results(b: Body): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of b.messages ?? []) if (m.role === "tool" && m.tool_call_id) out[m.tool_call_id] = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return out;
}

describe("ops/pi-extension.ts in real pi", () => {
  it("registers the run's core tools; a tool never enabled is unknown to pi; one a reload took away is refused by the core, then deactivated", { skip, timeout: 120_000 }, async () => {
    const runsDir = join(tmp.dir, "runs");
    const layer = join(tmp.dir, "layer.yml");
    const llm = await startFakeLlm([
      { tools: [{ name: "run_list", args: { limit: 5 }, id: "c-list" }] },
      { tools: [{ name: "run_get", args: { run: "self" }, id: "c-get" }] },
      { tools: [{ name: "journal_query", args: { run: "self", kind: "run.start" }, id: "c-query" }] },
      { text: "That is all." },
    ]);
    try {
      const agentics = writeTree(join(tmp.dir, "agentics"), {
        "agents/ops-lab/agent.yml": "description: An operator's helper on the fake LLM\nmode: headless\ntools:\n  enable: [read, run_list, journal_query, context_get]\n",
        ...Object.fromEntries(Object.entries(llm.agentFiles()).map(([f, c]) => [`agents/ops-lab/${f}`, c])),
      });
      const rt = createRuntime({ runsDir, piCommand: PI, agenticsDir: agentics });
      // The operator's side: a config whose limit leaves out journal_query, reloaded while the agent's turn 2 is asked for.
      writeTree(tmp.dir, { "layer.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` });
      const config = loadConfig({ packaged: join(tmp.dir, "absent.yml"), userConfig: join(tmp.dir, "absent.yml"), env: {}, configPath: layer });
      const operator = cliContext(config, createRuntime({ runsDir, piCommand: PI }));
      let reloaded: unknown = null;
      llm.onRequest = async (n) => {
        if (n !== 2) return;
        writeTree(tmp.dir, { "layer.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'], disable: [journal_query] } }\n` });
        reloaded = await callTool("config_reload", {}, operator);
      };

      const rec = await rt.start({ agent: "ops-lab", input: { message: "look around" }, workspace: "none", journal: true });
      const result = await rt.wait(rec.id);
      const journal = readJournal(rt.dir(rec.id));
      if (result.outcome !== "done") assert.fail(`the run failed: ${result.reason}\n${JSON.stringify(journal.slice(-8), null, 2)}`);

      const req = llm.requests as Body[];
      assert.equal(req.length, 4);
      assert.deepEqual(toolNames(req[0]), ["context_get", "journal_query", "read", "run_list"], "the run's core tools are registered beside pi's own");
      assert.match(results(req[1])["c-list"], /"runs": \[/, "run_list ran in pi's process through the core");
      assert.match(results(req[1])["c-list"], new RegExp(rec.id), "it sees its own run");
      assert.match(results(req[2])["c-get"], /run_get/i, "run_get was never registered");
      assert.match(results(req[2])["c-get"], /not found|unknown|not available/i);
      assert.deepEqual((reloaded as { runs: string[] }).runs, [rec.id], "the reload told the live run");
      assert.match(results(req[3])["c-query"], new RegExp(`^refused: journal_query is not allowed for agent ops-lab \\(run ${rec.id}\\)$`), "the core checks again on every call");
      assert.deepEqual(toolNames(req[3]), ["context_get", "read", "run_list"], "the next turn no longer offers it");

      const loaded = journal.filter((e) => e.kind === "config.loaded");
      assert.equal(loaded.length, 1);
      assert.deepEqual(loaded[0].data.removed, ["journal_query"]);
      assert.deepEqual(loaded[0].data.tools, ["read", "run_list", "context_get"]);
      const start = journal.find((e) => e.kind === "agent.start")!;
      assert.ok((start.data.resources as { ref: string; path: string }[]).some((r) => r.ref === "ops:pi-extension" && r.path === PI_EXTENSION), "agent.start lists the adapter");
      const ends = journal.filter((e) => e.kind === "tool.end").map((e) => [e.data.tool, e.data.isError]);
      assert.deepEqual(ends, [
        ["run_list", false],
        ["run_get", true],
        ["journal_query", true],
      ]);
    } finally {
      await llm.stop();
    }
  });
});
