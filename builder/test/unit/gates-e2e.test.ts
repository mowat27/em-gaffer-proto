/**
 * Gates in a real pi process: pi loads runtime/gate-host.ts as an extension, the host loads the gate modules, and a
 * scripted model (test/harness/fake-llm.ts, local, no network) makes the tool calls. Proves that blocks reach the model
 * as the tool result and the file is untouched, that allowed calls run, that a throwing gate blocks (E9), that a
 * tool_result gate patches what the model sees, that a host without its gates file blocks everything, and that every
 * decision reaches the journal (here its fallback file). Skipped when pi is not installed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { GateHostFile } from "../../engine/gates.ts";
import { GATE_HOST } from "../../runtime/resolve.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "../../runtime/root.ts";
import { startFakeLlm, type FakeTurn } from "../harness/fake-llm.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const PI = process.env.BUILDER_TEST_PI ?? join(homedir(), ".pi", "agent", "bin", "pi");
const tmp = tempDir("builder-gates-e2e");
after(() => tmp.remove());
const SHARED_GATES = join(AGENTICS_DIR, "shared", "gates");
const ENGINE = join(BUILDER_ROOT, "engine", "gates.ts");

interface PiRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The tool results the model was sent, by tool call id. */
  results: Record<string, string>;
  /** tool.gate events from the journal fallback file. */
  gates: { span?: string; data: Record<string, unknown> }[];
}

/** One headless pi run with the gate host, in `cwd`, against a fake model playing `script`. */
async function runPi(name: string, cwd: string, script: FakeTurn[], gatesFile: GateHostFile | null, tools = "read,write,edit"): Promise<PiRun> {
  const llm = await startFakeLlm(script);
  try {
    const agent = writeTree(join(tmp.dir, name, "agent"), llm.agentFiles());
    const file = join(tmp.dir, name, "gates.json");
    if (gatesFile) writeFileSync(file, JSON.stringify(gatesFile));
    const journal = join(tmp.dir, name, "journal.fallback.jsonl");
    const args = ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes", "-e", GATE_HOST, "--tools", tools, "--no-session", "--provider", llm.provider, "--model", llm.model, "-p", "--", "go"];
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_NO_UPDATE_CHECK: "1", BUILDER_JOURNAL_FALLBACK: journal };
    delete env.BUILDER_JOURNAL_SOCK;
    if (gatesFile) env.BUILDER_GATES = file;
    else delete env.BUILDER_GATES;
    // spawn, not spawnSync: the fake model answers from this process's event loop.
    const child = spawn(PI, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    const results: Record<string, string> = {};
    for (const body of llm.requests) {
      for (const m of (body.messages ?? []) as { role: string; tool_call_id?: string; content?: unknown }[]) {
        if (m.role === "tool" && m.tool_call_id) results[m.tool_call_id] = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      }
    }
    const gates = existsSync(journal)
      ? readFileSync(journal, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { kind: string; span?: string; data: Record<string, unknown> })
          .filter((e) => e.kind === "tool.gate")
      : [];
    return { code, stdout, stderr, results, gates };
  } finally {
    await llm.stop();
  }
}

function app(name: string): string {
  const dir = writeTree(join(tmp.dir, name, "app"), { "package.json": "{}\n", "README.md": "# app\n", "src/index.ts": "export {};\n", "secret.txt": "token sk-abc123\n" });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

describe("gates in a real pi process", { skip: existsSync(PI) ? false : `pi is not installed at ${PI}` }, () => {
  it("the shared gates block today's paths before the tool runs and let the slice's own files through; every decision is journaled", async () => {
    const cwd = app("shared");
    const gatesFile: GateHostFile = {
      gates: ["blocked-paths", "write-scope", "append-only-migrations", "learnings-file"].map((n) => ({ ref: `shared:${n}`, path: join(SHARED_GATES, `${n}.ts`) })),
      ctx: { cwd, base: "", writes: ["src/**", "supabase/migrations/**", "LEARNINGS.md", ".scratch/**"], areas: {}, protectedPaths: [], dispatch: true },
    };
    const r = await runPi("shared", cwd, [
      {
        tools: [
          { name: "write", args: { path: "package.json", content: "{\"hacked\":true}" }, id: "c-pkg" },
          { name: "edit", args: { path: "README.md", edits: [{ oldText: "# app", newText: "# hacked" }] }, id: "c-readme" },
          { name: "write", args: { path: "src/slices/clients/CreateClient/CreateClientCommand.ts", content: "export {};\n" }, id: "c-slice" },
        ],
      },
      { text: "finished" },
    ], gatesFile);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), "{}\n", "blocked: never written");
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# app\n");
    assert.ok(existsSync(join(cwd, "src/slices/clients/CreateClient/CreateClientCommand.ts")), "allowed: written");
    assert.match(r.results["c-pkg"], /^package\.json: dependency\/package manifest changes are not allowed from a slice commit\. Do not change it with write\./);
    assert.match(r.results["c-readme"], /^README\.md: outside src\/slices\/\{context\}\/\{slice\}\/ and not a documented exception\. Do not change it with edit\./);
    assert.match(r.results["c-slice"], /Successfully wrote/);
    const byCall = (span: string) => r.gates.filter((e) => e.span === span).map((e) => `${e.data.gate}:${e.data.decision}`);
    assert.deepEqual(byCall("t-c-pkg"), ["shared:blocked-paths:block"]);
    assert.deepEqual(byCall("t-c-readme"), ["shared:blocked-paths:allow", "shared:write-scope:block"]);
    assert.deepEqual(byCall("t-c-slice"), ["shared:blocked-paths:allow", "shared:write-scope:allow", "shared:append-only-migrations:allow", "shared:learnings-file:allow"]);
    assert.deepEqual(r.gates.find((e) => e.span === "t-c-pkg")?.data, { tool: "write", gate: "shared:blocked-paths", on: "tool_call", decision: "block", reason: r.results["c-pkg"], path: "package.json" });
  });

  it("E9: a throwing gate blocks the call with its error; a tool_result gate patches what the model sees", async () => {
    const cwd = app("e9");
    const dir = join(tmp.dir, "e9", "gates");
    writeTree(dir, {
      "boom.ts": `import { defineGate } from ${JSON.stringify(ENGINE)};\nexport default defineGate({ tools: ["edit"], check: () => { throw new Error("cannot decide"); } });\n`,
      "redact.ts": `import { defineGate } from ${JSON.stringify(ENGINE)};\nexport default defineGate({ tools: ["read"], on: "tool_result", check: (c) => ({ patch: { content: (c.result!.content as { type: string; text: string }[]).map((x) => ({ ...x, text: x.text.replace(/sk-[a-z0-9]+/g, "[redacted]") })) } }) });\n`,
    });
    const r = await runPi("e9", cwd, [
      {
        tools: [
          { name: "edit", args: { path: "README.md", edits: [{ oldText: "# app", newText: "# changed" }] }, id: "c-edit" },
          { name: "read", args: { path: "secret.txt" }, id: "c-read" },
        ],
      },
      { text: "finished" },
    ], { gates: [{ ref: "own:boom", path: join(dir, "boom.ts") }, { ref: "own:redact", path: join(dir, "redact.ts") }], ctx: { cwd, base: "", writes: [], areas: {}, protectedPaths: [], dispatch: false } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.results["c-edit"], "gate own:boom failed: cannot decide");
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# app\n");
    assert.match(r.results["c-read"], /token \[redacted\]/);
    assert.doesNotMatch(r.results["c-read"], /sk-abc123/);
    assert.deepEqual(r.gates.map((e) => [e.span, e.data.gate, e.data.decision, e.data.error ?? false]), [["t-c-edit", "own:boom", "block", true], ["t-c-read", "own:redact", "patch", false]]);
  });

  it("a gate host without its gates file blocks every call (fails closed)", async () => {
    const cwd = app("broken");
    const r = await runPi("broken", cwd, [{ tools: [{ name: "read", args: { path: "README.md" }, id: "c-read" }] }, { text: "finished" }], null, "read");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.results["c-read"], "the gate host is loaded but $BUILDER_GATES is not set");
  });
});
