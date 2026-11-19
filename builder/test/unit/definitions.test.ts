/**
 * The definitions tools through callTool, on a temp agent tree: versions and E15 (a stale expectedVersion is refused),
 * validation before a write (schema, references, a type error, a template that does not parse, a gate that is not one,
 * deleting a skill an agent loads), history (list, diff, rollback), E25 (an agent never widens itself or a run above
 * it), propose mode and change sets, agent_create from a template, builders (create, activate, delete), the feed's
 * definition.changed, and definitions_validate.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { coreGroups } from "../../ops/core/index.ts";
import { callTool, isToolError, type ToolContext, type ToolError } from "../../ops/core/tool.ts";
import { locate, readFileSet, versionOf } from "../../ops/definitions/kinds.ts";
import { readFeed } from "../../runtime/feed.ts";
import { contentHash } from "../../runtime/resolve.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-definitions");
after(() => tmp.remove());
const runsDir = join(tmp.dir, "runs");
const none = join(tmp.dir, "absent.yml");
const configFile = join(writeTree(join(tmp.dir, "config"), { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` }), "c.yml");
const config = loadConfig({ packaged: none, userConfig: none, env: {}, configPath: configFile });

const GATES = JSON.stringify(join(BUILDER, "engine", "gates.ts"));
const WORKFLOW = JSON.stringify(join(BUILDER, "engine", "workflow.ts"));
const skill = (description: string, body = "Say hello.") => `---\nname: hello\ndescription: ${description}\n---\n\n${body}\n`;
const builderTs = (name: string, extra = "") => `import { code, defineBuilder } from ${WORKFLOW};\n${extra}\nexport default defineBuilder({ name: ${JSON.stringify(name)}, provides: [], steps: [code("one", async () => ({ n: 1 }))] });\n`;

/** A fresh agent tree with the real agent templates. */
function tree(name: string): string {
  const root = writeTree(join(tmp.dir, name), {
    "agents/lab/agent.yml": "description: a lab\nmode: interactive\nprompt: own:SYSTEM.md\ntools: { enable: [read, definitions] }\nruns: { may_start: [agent:helper] }\n",
    "agents/lab/SYSTEM.md": "You are the lab.\n",
    "agents/lab/data/notes.md": "data stays\n",
    "agents/helper/agent.yml": "description: a helper\nmode: headless\nprompt: own:prompts/go.md\nuses: { skills: [shared:demo/*], prompts: [own:prompts/*] }\ngates: [shared:allow-all]\ntools: { enable: [read, definitions] }\n",
    "agents/helper/prompts/go.md": "---\ndescription: go\n---\nGo: $@\n",
    "agents/prop/agent.yml": "description: proposes\nmode: headless\nprompt: own:prompts/go.md\ntools: { enable: [read, definitions] }\ndefinitions: { changes: propose }\n",
    "agents/prop/prompts/go.md": "Go\n",
    "shared/skills/demo/hello/SKILL.md": skill("Greets"),
    "shared/gates/allow-all.ts": `import { allow, defineGate } from ${GATES};\nexport default defineGate({ tools: "*", check: () => allow() });\n`,
    "builders/one/builder.ts": builderTs("one"),
    "shared/data/dispatches/.keep": "",
    // builder/package.json makes the real tree's .ts files ES modules; a temp tree needs its own.
    "package.json": `{ "type": "module" }\n`,
  });
  cpSync(join(BUILDER, "agentics", "shared", "agent-templates"), join(root, "shared", "agent-templates"), { recursive: true });
  return root;
}

function context(agentics: string): ToolContext {
  return cliContext(config, createRuntime({ runsDir, piCommand: "/bin/false", agenticsDir: agentics, limit: config.limit }));
}

/** An agent run record written by hand: the caller of an agent's tool call. */
function agentRun(id: string, agent: string, parent: string | null = null): RunRecord {
  const rec: RunRecord = { id, parent, kind: "agent", spec: { agent }, state: "running", pid: process.pid, startedAt: new Date().toISOString() };
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify(rec));
  return rec;
}
const asAgent = (ctx: ToolContext, rec: RunRecord): ToolContext => ({ ...ctx, caller: { kind: "agent", runId: rec.id, agent: rec.spec.agent, allowed: ctx.caller.allowed } });

const call = async <T = Record<string, any>>(ctx: ToolContext, name: string, args: unknown) => (await callTool(name, args, ctx)) as T;
async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    assert.ok(isToolError(err), `not a ToolError: ${String(err)}`);
    return err as ToolError;
  }
  return assert.fail("the call did not fail");
}

describe("definitions tools", { concurrency: true }, () => {
  it("the group names the tools design section 9 lists, plus changeset_list", () => {
    const g = coreGroups().definitions;
    for (const k of ["skill", "template", "gate", "listener", "prompt"]) for (const v of ["list", "get", "create", "update", "delete"]) assert.ok(g.includes(`${k}_${v}`), `${k}_${v}`);
    for (const t of ["builder_list", "builder_get", "builder_create", "builder_clone", "builder_update", "builder_activate", "builder_delete", "agent_list", "agent_get", "agent_create", "agent_update", "agent_delete", "definitions_validate", "history_list", "history_diff", "history_rollback", "changeset_list", "changeset_apply"]) {
      assert.ok(g.includes(t), t);
    }
  });

  it("a version is the content hash of the definition's files; an agent's leaves out data/ and nested agents", () => {
    const agentics = tree("versions");
    writeTree(agentics, { "agents/lab/nested/agent.yml": "description: nested\n" });
    const lab = locate("agent", "lab", agentics);
    assert.deepEqual([...readFileSet(lab)!.keys()], ["agent.yml", "SYSTEM.md"]);
    const sk = locate("skill", "demo/hello", agentics);
    assert.equal(versionOf(readFileSet(sk)!, false), contentHash(sk.path), "a skill's version is the hash agent.start journals");
    const gate = locate("gate", "allow-all", agentics);
    assert.equal(versionOf(readFileSet(gate)!, true), contentHash(gate.path));
    assert.throws(() => locate("template", "only-one", agentics), /2 segments/);
    assert.throws(() => locate("agent", "../escape", agentics), /not a agent id/);
  });

  it("E15, history and rollback: a stale expectedVersion is refused; a change keeps the previous version, journals definition.changed and names what loads it", async () => {
    const agentics = tree("e15");
    const ctx = context(agentics);
    const got = await call(ctx, "skill_get", { id: "demo/hello", file: "SKILL.md" });
    assert.match(got.content, /Greets/);
    const v1 = got.version as string;

    const changed = await call(ctx, "skill_update", { id: "demo/hello", expectedVersion: v1, edits: [{ file: "SKILL.md", find: "Say hello.", replace: "Say hello twice." }], reason: "louder" });
    assert.notEqual(changed.version, v1);
    assert.equal(changed.previous, v1);
    assert.deepEqual(changed.affects, { agents: ["helper"], builders: [] });
    assert.ok(existsSync(join(changed.history, "SKILL.md")), "the previous version is kept");
    assert.match(readFileSync(join(changed.history, "SKILL.md"), "utf8"), /Say hello\.$/m);
    assert.match(readFileSync(join(agentics, "shared/skills/demo/hello/SKILL.md"), "utf8"), /twice/);

    // The second writer read v1 too: refused, and nothing changes.
    const stale = await rejection(call(ctx, "skill_update", { id: "demo/hello", expectedVersion: v1, files: { "SKILL.md": skill("Greets", "Other") } }));
    assert.equal(stale.code, "refused");
    assert.match(stale.message, /has changed: you expected version .* it is at version .*E15/);
    assert.match(readFileSync(join(agentics, "shared/skills/demo/hello/SKILL.md"), "utf8"), /twice/);

    const feed = readFeed(runsDir, { kind: "definition.changed" }).filter((e) => e.data.version === changed.version);
    assert.equal(feed.length, 1);
    assert.deepEqual([feed[0].data.kind, feed[0].data.id, feed[0].data.change, feed[0].data.reason], ["skill", "demo/hello", "update", "louder"]);

    const hist = await call(ctx, "history_list", { kind: "skill", id: "demo/hello" });
    assert.equal(hist.current, changed.version);
    assert.deepEqual(hist.entries.map((e: { version: string }) => e.version), [v1]);
    assert.equal(hist.entries[0].change.next, changed.version);
    const diff = await call(ctx, "history_diff", { kind: "skill", id: "demo/hello" });
    assert.match(diff.diff, /^-Say hello\.$/m);
    assert.match(diff.diff, /^\+Say hello twice\.$/m);

    const back = await call(ctx, "history_rollback", { kind: "skill", id: "demo/hello", version: v1.slice(0, 8), expectedVersion: changed.version });
    assert.equal(back.version, v1, "rolled back to exactly the earlier files");
    assert.equal((await call(ctx, "history_list", { kind: "skill", id: "demo/hello" })).entries.length, 2);
    const same = await call(ctx, "skill_update", { id: "demo/hello", expectedVersion: v1, files: { "SKILL.md": readFileSync(join(agentics, "shared/skills/demo/hello/SKILL.md"), "utf8") } });
    assert.equal(same.unchanged, true);
  });

  it("validation before writing: bad front matter, a skill an agent loads, a gate that is not one, a type error, a template that does not parse", async () => {
    const agentics = tree("validate");
    const ctx = context(agentics);
    const v = (await call(ctx, "skill_get", { id: "demo/hello" })).version;
    const bad = await rejection(call(ctx, "skill_update", { id: "demo/hello", expectedVersion: v, files: { "SKILL.md": "no front matter\n" } }));
    assert.equal(bad.code, "invalid");
    assert.match(bad.message, /does not validate, nothing was written:\n- SKILL.md needs front matter with a description/);
    assert.equal((await call(ctx, "skill_get", { id: "demo/hello" })).version, v);

    const used = await rejection(call(ctx, "skill_delete", { id: "demo/hello", expectedVersion: v }));
    assert.equal(used.code, "invalid");
    assert.match(used.message, /agent helper: .*shared:demo\/\* does not resolve/);

    const notGate = await rejection(call(ctx, "gate_create", { id: "nothing", content: "export default { tools: 1 };\n" }));
    assert.match(notGate.message, /not a gate/);
    assert.ok(!existsSync(join(agentics, "shared/gates/nothing.ts")));

    const bv = (await call(ctx, "builder_get", { id: "one" })).version;
    const typeError = await rejection(call(ctx, "builder_update", { id: "one", expectedVersion: bv, files: { "builder.ts": builderTs("one", `const n: number = "not a number";`) } }));
    assert.equal(typeError.code, "invalid");
    assert.match(typeError.message, /builders\/one\/builder\.ts:\d+: TS2322/);

    const hbs = await rejection(call(ctx, "template_create", { id: "one/state-change", files: { "x.ts.hbs": "{{#if open}}never closed\n" } }));
    assert.match(hbs.message, /template set builders\/one\/templates\/state-change: x\.ts\.hbs: Parse error/);
    const ok = await call(ctx, "template_create", { id: "one/state-change", files: { "src/{{context}}.ts.hbs": "// {{slice}}\n" } });
    assert.match(ok.version, /^[0-9a-f]{64}$/);
    assert.deepEqual(ok.affects.builders, ["one"]);
  });

  it("E25: an agent never widens its own agent.yml or one above it; narrowing, and other agents, are fine", async () => {
    const agentics = tree("e25");
    const ctx = context(agentics);
    const lab = agentRun("20261118-100000-e25001", "lab");
    const helper = agentRun("20261118-100001-e25002", "helper", lab.id);
    const labV = (await call(ctx, "agent_get", { id: "lab" })).version;
    const widen = { id: "lab", expectedVersion: labV, edits: [{ file: "agent.yml", find: "enable: [read, definitions]", replace: "enable: [read, definitions, runs]" }] };
    const own = await rejection(call(asAgent(ctx, lab), "agent_update", widen));
    assert.equal(own.code, "refused");
    assert.match(own.message, /would widen the calling agent lab: it would gain tools run_start/);
    const above = await rejection(call(asAgent(ctx, helper), "agent_update", widen));
    assert.match(above.message, /would widen agent lab \(run 20261118-100000-e25001, above the caller\)/);
    const mayStart = await rejection(call(asAgent(ctx, lab), "agent_update", { id: "lab", expectedVersion: labV, edits: [{ file: "agent.yml", find: "[agent:helper]", replace: "['*']" }] }));
    assert.match(mayStart.message, /runs\.may_start \*/);

    // A gate is a limit: helper can neither drop the gate it loads nor change it.
    const helperYml = (await call(ctx, "agent_get", { id: "helper" })).version;
    const dropGate = await rejection(call(asAgent(ctx, helper), "agent_update", { id: "helper", expectedVersion: helperYml, edits: [{ file: "agent.yml", find: "gates: [shared:allow-all]\n", replace: "" }] }));
    assert.match(dropGate.message, /fewer gates: shared:allow-all no longer checks its tool calls/);
    const gateV = (await call(ctx, "gate_get", { id: "allow-all" })).version;
    const loosen = await rejection(call(asAgent(ctx, helper), "gate_update", { id: "allow-all", expectedVersion: gateV, edits: [{ find: "check: () => allow()", replace: "check: () => allow() /* looser */" }] }));
    assert.match(loosen.message, /a changed gate allow-all, which checks its own tool calls/);
    // lab loads no gate: it may change the one its child loads (the child's next run gets it).
    await call(asAgent(ctx, lab), "gate_update", { id: "allow-all", expectedVersion: gateV, edits: [{ find: "check: () => allow()", replace: "check: () => allow() /* reviewed */" }] });

    const narrowed = await call(asAgent(ctx, lab), "agent_update", { id: "lab", expectedVersion: labV, edits: [{ file: "agent.yml", find: "enable: [read, definitions]", replace: "enable: [definitions]" }] });
    assert.equal(narrowed.affects.agents[0], "lab");
    // Another agent's tools are its own business, within the machine limit (the child ceiling caps what it starts).
    const helperV = (await call(ctx, "agent_get", { id: "helper" })).version;
    await call(asAgent(ctx, lab), "agent_update", { id: "helper", expectedVersion: helperV, edits: [{ file: "agent.yml", find: "enable: [read, definitions]", replace: "enable: [read, definitions, observe]" }] });
    // The operator (the CLI) may widen anything.
    const now = (await call(ctx, "agent_get", { id: "lab" })).version;
    await call(ctx, "agent_update", { id: "lab", expectedVersion: now, edits: [{ file: "agent.yml", find: "enable: [definitions]", replace: "enable: [read, definitions, runs]" }] });
  });

  it("E25 compares areas as the same places before and after: a relative area is no widening, moving a writable one is", async () => {
    const agentics = tree("e25-areas");
    writeTree(agentics, { "agents/arealab/agent.yml": "description: has areas\nmode: interactive\ntools: { enable: [read, definitions] }\nareas:\n  work: { path: ./work, write: true }\n  ref: { path: ./ref, write: false }\n" });
    const ctx = context(agentics);
    const me = asAgent(ctx, agentRun("20261118-100003-area01", "arealab"));
    // An unrelated change (a skill) never reads as widening the caller's relative areas (the P5 proof's false refusal).
    const v = (await call(ctx, "skill_get", { id: "demo/hello" })).version;
    const ok = await call(me, "skill_update", { id: "demo/hello", expectedVersion: v, edits: [{ file: "SKILL.md", find: "Say hello.", replace: "Say hi." }] });
    assert.notEqual(ok.version, v);
    // The same place written another way is not a widening.
    let yml = (await call(ctx, "agent_get", { id: "arealab" })).version;
    const same = await call(me, "agent_update", { id: "arealab", expectedVersion: yml, edits: [{ file: "agent.yml", find: "path: ./work", replace: `path: ${JSON.stringify(join(agentics, "agents/arealab/work"))}` }] });
    yml = same.version;
    // Moving the writable area elsewhere is (G6), and so is making a read-only area writable.
    const moved = await rejection(call(me, "agent_update", { id: "arealab", expectedVersion: yml, edits: [{ file: "agent.yml", find: JSON.stringify(join(agentics, "agents/arealab/work")), replace: "./elsewhere" }] }));
    assert.equal(moved.code, "refused");
    assert.match(moved.message, /writable areas work at .*agents\/arealab\/elsewhere/);
    const writable = await rejection(call(me, "agent_update", { id: "arealab", expectedVersion: yml, edits: [{ file: "agent.yml", find: "path: ./ref, write: false", replace: "path: ./ref, write: true" }] }));
    assert.match(writable.message, /writable areas ref at /);
  });

  it("propose mode: the change is validated and saved as a change set; only a caller that does not propose applies it", async () => {
    const agentics = tree("propose");
    const ctx = context(agentics);
    const prop = agentRun("20261118-100002-prop01", "prop");
    const v = (await call(ctx, "skill_get", { id: "demo/hello" })).version;
    const proposal = await call(asAgent(ctx, prop), "skill_update", { id: "demo/hello", expectedVersion: v, files: { "SKILL.md": skill("Greets warmly") }, reason: "warmer" });
    assert.equal(proposal.proposed, true);
    assert.match(proposal.diff, /^\+description: Greets warmly$/m);
    assert.equal((await call(ctx, "skill_get", { id: "demo/hello" })).version, v, "nothing was written");
    const invalid = await rejection(call(asAgent(ctx, prop), "skill_update", { id: "demo/hello", expectedVersion: v, files: { "SKILL.md": "nope\n" } }));
    assert.equal(invalid.code, "invalid", "a proposal is validated too");

    const listed = await call(ctx, "changeset_list", { state: "proposed" });
    assert.deepEqual(listed.changesets.map((c: { id: string }) => c.id), [proposal.changeset]);
    const one = await call(ctx, "changeset_list", { id: proposal.changeset });
    assert.equal(one.tool, "skill_update");
    assert.ok(existsSync(join(agentics, "changesets", proposal.changeset, "change.diff")));

    const self = await rejection(call(asAgent(ctx, prop), "changeset_apply", { id: proposal.changeset }));
    assert.equal(self.code, "refused");
    const applied = await call(ctx, "changeset_apply", { id: proposal.changeset });
    assert.equal(applied.result.version, proposal.version);
    assert.match(readFileSync(join(agentics, "shared/skills/demo/hello/SKILL.md"), "utf8"), /Greets warmly/);
    const entry = (await call(ctx, "history_list", { kind: "skill", id: "demo/hello" })).entries[0];
    assert.equal(entry.change.changeset, proposal.changeset);
    assert.equal((await call(ctx, "changeset_list", { id: proposal.changeset })).state, "applied");
    assert.match((await rejection(call(ctx, "changeset_apply", { id: proposal.changeset }))).message, /was applied/);
  });

  it("agent_create from a template, agent_get resolved, prompts, and agent_delete keeping data/", async () => {
    const agentics = tree("create");
    const ctx = context(agentics);
    const made = await call(ctx, "agent_create", { path: "team/greeter", description: "Greets: people", template: "headless" });
    assert.deepEqual(made.files, ["agent.yml", "prompts/task.md", "SYSTEM.md"].sort((a, b) => a.localeCompare(b)));
    assert.match(readFileSync(join(agentics, "agents/team/greeter/agent.yml"), "utf8"), /^description: "Greets: people"$/m);
    assert.match(readFileSync(join(agentics, "agents/team/greeter/SYSTEM.md"), "utf8"), /You are greeter, an agent of the gaffer builder \(team\/greeter\)/);
    const again = await rejection(call(ctx, "agent_create", { path: "team/greeter" }));
    assert.equal(again.code, "refused");
    assert.match((await rejection(call(ctx, "agent_create", { path: "x", template: "nope" }))).message, /no agent template nope \(templates: basic, headless\)/);

    const got = await call(ctx, "agent_get", { id: "team/greeter" });
    assert.equal(got.resolved.yml.mode, "headless");
    assert.ok(got.resolved.resources.some((r: { kind: string; ref: string }) => r.kind === "prompt" && r.ref === "own:prompts/task.md"));
    assert.deepEqual(got.resolved.tools, ["read", "grep", "find", "ls"]);

    const p = await call(ctx, "prompt_create", { id: "team/greeter/wave", content: "---\ndescription: wave\n---\nWave at $1\n" });
    assert.deepEqual(p.affects.agents, ["team/greeter"]);
    const empty = await rejection(call(ctx, "prompt_update", { id: "team/greeter/wave", expectedVersion: p.version, content: "---\ndescription: wave\n---\n" }));
    assert.match(empty.message, /the prompt template is empty/);

    const lab = await call(ctx, "agent_get", { id: "lab" });
    assert.ok(!lab.files.some((f: { path: string }) => f.path.startsWith("data/")));
    const dataFile = await rejection(call(ctx, "agent_update", { id: "lab", expectedVersion: lab.version, files: { "data/x.md": "no" } }));
    assert.match(dataFile.message, /data is not part of an agent's definition/);
    await call(ctx, "agent_delete", { id: "lab", expectedVersion: lab.version });
    assert.ok(!existsSync(join(agentics, "agents/lab/agent.yml")));
    assert.ok(existsSync(join(agentics, "agents/lab/data/notes.md")), "data/ stays");
    const restored = await call(ctx, "history_rollback", { kind: "agent", id: "lab", version: lab.version, expectedVersion: null });
    assert.equal(restored.version, lab.version);
  });

  it("builders: create, clone, activate (active.yml, versioned) and delete; the active one cannot be deleted", async () => {
    const agentics = tree("builders");
    const ctx = context(agentics);
    const made = await call(ctx, "builder_create", { id: "two", files: { "builder.ts": builderTs("two") } });
    assert.deepEqual(made.affects.builders, ["two"]);
    const got = await call(ctx, "builder_get", { id: "two" });
    assert.deepEqual(got.definition, { name: "two", provides: [], steps: [{ kind: "code", name: "one" }] });
    await call(ctx, "builder_clone", { from: "two", id: "three" });
    assert.equal((await call(ctx, "builder_get", { id: "three" })).version, made.version, "a clone has the same files");

    let list = await call(ctx, "builder_list", {});
    assert.equal(list.active.source, "default");
    assert.equal(list.active.activeYml.version, null);
    const act = await call(ctx, "builder_activate", { id: "two", expectedVersion: null });
    assert.equal(act.builder, "two");
    assert.match(readFileSync(join(agentics, "builders/active.yml"), "utf8"), /^builder: two$/m);
    list = await call(ctx, "builder_list", {});
    assert.deepEqual([list.active.id, list.active.source], ["two", "active.yml"]);
    assert.deepEqual(list.builders.filter((b: { active: boolean }) => b.active).map((b: { id: string }) => b.id), ["two"]);
    const missing = await rejection(call(ctx, "builder_activate", { id: "nine", expectedVersion: act.version }));
    assert.match(missing.message, /active\.yml names builder nine, which does not exist/);

    const busy = await rejection(call(ctx, "builder_delete", { id: "two", expectedVersion: made.version }));
    assert.equal(busy.code, "refused");
    await call(ctx, "builder_delete", { id: "three", expectedVersion: made.version });
    assert.ok(!existsSync(join(agentics, "builders/three")));
  });

  it("a link inside the tree never takes a write outside it (the machine config stays the operator's)", async () => {
    const agentics = tree("links");
    const outside = writeTree(join(tmp.dir, "links-outside"), { "keep.md": "outside\n" });
    symlinkSync(outside, join(agentics, "agents/lab/prompts"));
    const e = await rejection(call(context(agentics), "prompt_create", { id: "lab/sneaky", content: "---\ndescription: x\n---\nhi\n" }));
    assert.equal(e.code, "refused");
    assert.match(e.message, /resolves outside the agent tree/);
    assert.ok(!existsSync(join(outside, "sneaky.md")));
  });

  it("definitions_validate checks every definition as it is", async () => {
    const agentics = tree("validate-all");
    const ctx = context(agentics);
    const all = await call(ctx, "definitions_validate", {});
    assert.equal(all.ok, true, JSON.stringify(all.results.filter((r: { ok: boolean }) => !r.ok)));
    assert.ok(all.checked >= 7);
    writeFileSync(join(agentics, "agents/lab/agent.yml"), "description: broken\nunknown: 1\n");
    const one = await call(ctx, "definitions_validate", { kind: "agent", id: "lab" });
    assert.equal(one.ok, false);
    assert.match(one.results[0].errors[0], /unknown key unknown/);
  });
});
