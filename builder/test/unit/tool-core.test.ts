/**
 * The tool core: callTool is the one entry (unknown, refused, invalid, not available, failed, ok), listTools, the
 * registry feeding ops/groups.ts with design section 9's names, and when the runner loads the pi adapter.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { coreGroups, isAvailableCoreTool, registry } from "../../ops/core/index.ts";
import { callTool, isToolError, listTools, stub, ToolError, type ToolContext, type ToolDef } from "../../ops/core/tool.ts";
import { allTools, groupOf, groups, toolsOf } from "../../ops/groups.ts";
import { needsCoreTools, PI_EXTENSION } from "../../runtime/pi.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-tool-core");
after(() => tmp.remove());
const none = join(tmp.dir, "absent.yml");

/** A CLI context on a config whose limit is `limit` (YAML) and whose runs are in the temp dir. */
function ctxWith(limit: string): ToolContext {
  const d = writeTree(join(tmp.dir, `c-${Math.random().toString(16).slice(2)}`), { "c.yml": `builder:\n  limit: ${limit}\n  server: { runsDir: ./runs }\n` });
  return cliContext(loadConfig({ packaged: none, userConfig: none, env: {}, configPath: join(d, "c.yml") }));
}

/** The error callTool rejects with. */
async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    assert.ok(isToolError(err), `not a ToolError: ${String(err)}`);
    return err as ToolError;
  }
  return assert.fail("the call did not fail");
}

describe("callTool", () => {
  const all = ctxWith("{ tools: { enable: ['*'] } }");

  it("runs an allowed tool with valid arguments and returns its value", async () => {
    const out = (await callTool("run_list", { limit: 5 }, all)) as { runs: unknown[]; total: number };
    assert.deepEqual(out.runs, []);
    assert.equal(out.total, 0);
  });

  it("an unknown tool: unknown", async () => {
    const e = await rejection(callTool("no_such_tool", {}, all));
    assert.equal(e.code, "unknown");
    assert.match(e.message, /unknown tool "no_such_tool"/);
  });

  it("a tool outside caller.allowed is refused, before its arguments are even looked at, on every call", async () => {
    const observeOnly = ctxWith("{ tools: { enable: [observe] } }");
    const e = await rejection(callTool("run_list", { bogus: true }, observeOnly));
    assert.equal(e.code, "refused");
    assert.equal(e.message, "run_list is not allowed for the CLI (the machine limit)");
    // The check reads caller.allowed at call time: narrowing it refuses the next call.
    const ctx: ToolContext = { ...all, caller: { ...all.caller, allowed: new Set(all.caller.allowed) } };
    assert.ok(await callTool("run_list", {}, ctx));
    ctx.caller.allowed.delete("run_list");
    assert.equal((await rejection(callTool("run_list", {}, ctx))).code, "refused");
    const agent: ToolContext = { ...all, caller: { kind: "agent", runId: "r1", agent: "dev/lab", allowed: new Set(["context_get"]) } };
    assert.equal((await rejection(callTool("run_list", {}, agent))).message, "run_list is not allowed for agent dev/lab (run r1)");
  });

  it("arguments are validated against the tool's schema: wrong types, unknown and missing arguments", async () => {
    const wrong = await rejection(callTool("run_list", { limit: "five" }, all));
    assert.equal(wrong.code, "invalid");
    assert.match(wrong.message, /^run_list: limit: must be integer/);
    assert.match((await rejection(callTool("run_list", { colour: "red" }, all))).message, /^run_list: unknown argument colour$/);
    assert.match((await rejection(callTool("job_get", {}, all))).message, /^job_get: the arguments: must have required properties? job/);
    assert.match((await rejection(callTool("control_send", { action: "explode" }, all))).message, /^control_send: action: /);
    assert.equal((await rejection(callTool("run_list", [1, 2], all))).code, "invalid");
  });

  it("a stub answers not available (a tool named now and built later; since P6 every tool is built, so the test registers one)", async () => {
    const reg = registry() as Map<string, ToolDef>;
    reg.set("later_tool", stub("notify", "later_tool", "A tool a later phase builds, for this test only.", "not available until P9"));
    try {
      const msg = await rejection(callTool("later_tool", { anything: 1 }, { ...all, caller: { ...all.caller, allowed: new Set(["later_tool"]) } }));
      assert.equal(msg.code, "unavailable");
      assert.equal(msg.message, "later_tool is not available until P9");
    } finally {
      reg.delete("later_tool");
    }
    assert.equal(listTools().some((t) => !t.available), false, "every tool design section 9 names is built");
  });

  it("what a tool throws comes back as failed with its message", async () => {
    const e = await rejection(callTool("run_get", { run: "20990101-000000-abcdef" }, all));
    assert.equal(e.code, "failed");
    assert.match(e.message, /^no run 20990101-000000-abcdef in .*runs/);
  });
});

describe("the registry and the groups", () => {
  it("names exactly design section 9's tools in each ops/core group", () => {
    const g = coreGroups();
    assert.deepEqual(Object.keys(g), ["verify", "observe", "runs", "messaging", "operate", "process", "definitions", "git", "notify"]);
    assert.deepEqual(g.observe, ["instance_get", "job_get", "journal_query", "journal_tail", "context_get", "data_list", "job_artifacts", "session_entries", "run_stories", "run_story", "run_log", "metrics"]);
    assert.deepEqual(g.runs, ["run_start", "run_list", "run_get", "run_stop", "run_wait", "config_resolve", "workspace_reset"]);
    assert.deepEqual(g.operate, ["control_send", "config_reload", "runs_prune"]);
    assert.deepEqual(g.messaging, ["run_send", "run_subscribe"]);
    assert.deepEqual(g.process, ["server_start", "server_stop", "server_restart", "server_settings_get"]);
    assert.deepEqual(g.git, ["git_status", "git_diff", "git_log", "git_branch", "git_commit", "git_push"]);
    assert.deepEqual(g.notify, ["notify_operator", "notifications_list"]);
    assert.deepEqual(g.verify, ["verify"]);
    for (const t of ["builder_list", "builder_activate", "agent_create", "agent_update", "skill_update", "template_get", "gate_list", "listener_delete", "prompt_create", "definitions_validate", "history_rollback", "changeset_apply"]) {
      assert.ok(g.definitions.includes(t), t);
    }
  });

  it("ops/groups.ts merges them with the pi-native groups: one map, every name known to agent.yml and the limit", () => {
    assert.deepEqual(Object.keys(groups()), ["files", "project", "outcome", "verify", "observe", "runs", "messaging", "operate", "process", "definitions", "git", "notify"]);
    for (const name of registry().keys()) assert.ok(allTools().includes(name), name);
    assert.equal(groupOf("journal_tail"), "observe");
    assert.equal(groupOf("read"), "files");
    assert.equal(groupOf("capture-learning"), null);
    assert.deepEqual(toolsOf({ enable: ["operate", "tool:git"] }), ["control_send", "config_reload", "runs_prune", "git"]);
  });

  it("every tool has a description and an object schema; built tools and stubs are told apart", () => {
    for (const t of listTools()) {
      assert.ok(t.description.length > 10, t.name);
      assert.equal((t.params as { type?: string }).type, "object", t.name);
    }
    assert.equal(listTools().find((t) => t.name === "metrics")?.available, true);
    assert.equal(listTools().find((t) => t.name === "notifications_list")?.available, true, "notify is built (P6)");
  });

  it("listTools with a context lists only what its caller may call", () => {
    const names = listTools(ctxWith("{ tools: { enable: [observe, notify] } }")).map((t) => t.name);
    assert.deepEqual(names, [...coreGroups().observe, ...coreGroups().notify]);
  });

  it("the runner loads ops/pi-extension.ts only for a run with a built ops/core tool", () => {
    assert.ok(PI_EXTENSION.endsWith(join("ops", "pi-extension.ts")));
    assert.equal(needsCoreTools(["read", "write", "done", "context_get"]), true, "supabase-api has context_get");
    assert.equal(needsCoreTools(["read", "edit", "fetch_docs", "try_rules", "verify"]), true, "the verifier's verify is the core's");
    assert.equal(needsCoreTools(["read", "edit", "fetch_docs", "try_rules"]), false, "its own extension tools are not core tools");
    assert.equal(needsCoreTools(["read", "notify_operator"]), true, "notify_operator is a built core tool (P6)");
    assert.equal(isAvailableCoreTool("run_start"), true);
    assert.equal(isAvailableCoreTool("read"), false);
  });
});
