/**
 * Where definitions meet the runtime: the active builder (a config pin, active.yml, the default) and E2 (a builder
 * that does not load runs its last valid version from the history, or none); pinning what a run reads lazily (D10, E1:
 * skills, prompts, the system prompt files, the agent's settings, a workflow's templates), also through the runner as
 * pi sees it; and `builder agent new`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool } from "../../ops/core/tool.ts";
import { activeBuilder, loadActive } from "../../ops/definitions/active.ts";
import { pinResources, pinTemplates } from "../../runtime/pin.ts";
import { readJournal } from "../../runtime/journal.ts";
import { contentHash, resolve as resolveSpec } from "../../runtime/resolve.ts";
import { createRuntime, NO_LIMIT } from "../../runtime/run.ts";
import { tempDir } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-definitions-runtime");
after(() => tmp.remove());
const none = join(tmp.dir, "absent.yml");
const WORKFLOW = JSON.stringify(join(BUILDER, "engine", "workflow.ts"));
const builderTs = (name: string) => `import { code, defineBuilder } from ${WORKFLOW};\nexport default defineBuilder({ name: ${JSON.stringify(name)}, provides: ["stack:test"], steps: [code("one", async () => ({}))] });\n`;
const defaults = { server: { builder: "supabase-api" }, sources: { "server.builder": "built-in" } } as const;

describe("the active builder and E2", { concurrency: true }, () => {
  it("a pin in the machine config wins, then active.yml, then the default", () => {
    const agentics = writeTree(join(tmp.dir, "active"), { "builders/active.yml": "builder: mine\n" });
    assert.deepEqual(activeBuilder({ server: { builder: "pinned" } as never, sources: { "server.builder": "--config /x.yml" } }, agentics), { id: "pinned", source: "config", layer: "--config /x.yml" });
    assert.deepEqual(activeBuilder(defaults as never, agentics), { id: "mine", source: "active.yml" });
    assert.deepEqual(activeBuilder(defaults as never, join(tmp.dir, "nothing")), { id: "supabase-api", source: "default" });
    writeFileSync(join(agentics, "builders/active.yml"), "nope: 1\n");
    const broken = activeBuilder(defaults as never, agentics);
    assert.equal(broken.source, "default");
    assert.match(broken.warning ?? "", /active\.yml ignored/);
  });

  it("E2: a builder that does not load runs its last valid version from the history; with none, the job's run fails with the error", async () => {
    const runsDir = join(tmp.dir, "e2-runs");
    const agentics = writeTree(join(tmp.dir, "e2"), { "package.json": `{ "type": "module" }\n`, "builders/good/builder.ts": builderTs("good"), "builders/active.yml": "builder: good\n", "builders/lonely/builder.ts": "throw new Error('boom at load');\n" });
    const config = loadConfig({ packaged: none, userConfig: none, env: {}, configPath: join(writeTree(join(tmp.dir, "e2-config"), { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` }), "c.yml") });
    const ctx = cliContext(config, createRuntime({ runsDir, piCommand: "/bin/false", agenticsDir: agentics }));

    const ok = await loadActive(config, agentics);
    assert.deepEqual([ok.id, ok.source, ok.builder?.name, ok.workflow], ["good", "active.yml", "good", join(agentics, "builders/good/builder.ts")]);
    assert.equal(ok.error, undefined);

    // v1 goes to the history through a change; then the file is broken by hand (no tool would write it).
    const v1 = ((await callTool("builder_get", { id: "good" }, ctx)) as { version: string }).version;
    await callTool("builder_update", { id: "good", expectedVersion: v1, files: { "builder.ts": builderTs("good-2") } }, ctx);
    writeFileSync(join(agentics, "builders/good/builder.ts"), "export default { name: 'broken', steps: [] };\n");
    const fell = await loadActive(config, agentics);
    assert.match(fell.error ?? "", /provides must be a string array/);
    assert.equal(fell.fallback?.version, v1);
    assert.equal(fell.builder?.name, "good", "the last valid version from the history");
    assert.equal(fell.workflow, join(agentics, "builders", `.fallback-good-${v1.slice(0, 12)}`, "builder.ts"));
    assert.equal(contentHash(dirname(fell.workflow)), v1, "its Builder-Version is the history version");

    writeFileSync(join(agentics, "builders/active.yml"), "builder: lonely\n");
    const nothing = await loadActive(config, agentics);
    assert.equal(nothing.builder, null);
    assert.match(nothing.error ?? "", /boom at load/);
    assert.equal(nothing.workflow, join(agentics, "builders/lonely/builder.ts"), "the run loads it and fails with builder definition invalid");
  });
});

/** An agent tree whose agent `a` loads a skill, a prompt template, SYSTEM.md and APPEND_SYSTEM.md. */
function pinTree(name: string): string {
  return writeTree(join(tmp.dir, name), {
    "agents/a/agent.yml": "description: pins\nmode: headless\nprompt: own:prompts/p.md\nuses: { skills: [shared:s/*], prompts: [own:prompts/*] }\ntools: { enable: [read] }\n",
    "agents/a/prompts/p.md": "---\ndescription: p\n---\nDo $1\n",
    "agents/a/SYSTEM.md": "system v1\n",
    "agents/a/APPEND_SYSTEM.md": "append v1\n",
    "agents/a/settings.json": `{ "defaultProvider": "p", "defaultModel": "m" }\n`,
    "agents/a/auth.json": "{}\n",
    "shared/skills/s/one/SKILL.md": "---\nname: one\ndescription: one\n---\nskill v1\n",
    "shared/skills/s/one/ref.md": "a reference\n",
    "shared/templates/partials/p.hbs": "partial v1\n",
    "builders/b/templates/k/x.ts.hbs": "template v1\n",
  });
}

describe("pinning (D10, E1)", { concurrency: true }, () => {
  it("pinResources: skills, prompts and the system prompt files are copies named by their hash; the agent directory is a pinned copy of its settings", () => {
    const agentics = pinTree("pin-unit");
    const runDir = join(tmp.dir, "pin-unit-run");
    const r = resolveSpec({ agent: "a", workspace: "none" }, { config: { limit: NO_LIMIT }, agentics, runDir });
    assert.ok(!r.argv.includes("--system-prompt"), "pi finds SYSTEM.md itself before pinning");
    const pin = pinResources(r, runDir);
    const skillDir = join(agentics, "shared/skills/s/one");
    const pinnedSkill = join(runDir, "pinned", contentHash(skillDir), "one");
    const at = (flag: string) => pin.argv[pin.argv.indexOf(flag) + 1];
    assert.equal(at("--skill"), pinnedSkill);
    assert.equal(readFileSync(join(pinnedSkill, "ref.md"), "utf8"), "a reference\n", "a skill's folder is copied whole");
    assert.equal(at("--prompt-template"), join(runDir, "pinned", contentHash(join(agentics, "agents/a/prompts/p.md")), "p.md"));
    assert.equal(readFileSync(at("--system-prompt"), "utf8"), "system v1\n");
    assert.equal(readFileSync(at("--append-system-prompt"), "utf8"), "append v1\n");
    assert.ok(pin.argv.indexOf("--system-prompt") < pin.argv.indexOf("--skill"), "the added flags stand with the resources, before the message");
    const agentDir = pin.env.PI_CODING_AGENT_DIR;
    assert.equal(agentDir, join(runDir, "pinned", "agent"));
    assert.ok(lstatSync(join(agentDir, "settings.json")).isFile(), "settings.json is a copy");
    assert.ok(lstatSync(join(agentDir, "auth.json")).isSymbolicLink(), "credentials are linked, not copied");
    assert.ok(!existsSync(join(agentDir, "SYSTEM.md")) && !existsSync(join(agentDir, "APPEND_SYSTEM.md")), "the system prompt files come by flag only");
    assert.ok(pin.resources.every((x) => x.kind === "gate" || x.kind === "extension" || "pinned" in x));

    // A change after the run started does not reach it.
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: one\ndescription: one\n---\nskill v2\n");
    writeFileSync(join(agentics, "agents/a/settings.json"), `{ "defaultModel": "other" }\n`);
    assert.match(readFileSync(join(pinnedSkill, "SKILL.md"), "utf8"), /skill v1/);
    assert.match(readFileSync(join(agentDir, "settings.json"), "utf8"), /"m"/);
  });

  it("pinTemplates: a workflow run's template sets and shared partials are read from copies", () => {
    const agentics = pinTree("pin-templates");
    const runDir = join(tmp.dir, "pin-templates-run");
    const pinned = pinTemplates(runDir, agentics);
    const set = join(agentics, "builders/b/templates/k");
    const copy = pinned(set);
    assert.notEqual(copy, set);
    assert.ok(copy.startsWith(join(runDir, "pinned")) && copy.endsWith(join("templates", "k")), copy);
    writeFileSync(join(set, "x.ts.hbs"), "template v2\n");
    assert.equal(readFileSync(join(copy, "x.ts.hbs"), "utf8"), "template v1\n");
    assert.equal(readFileSync(join(pinned(join(agentics, "shared/templates/partials")), "p.hbs"), "utf8"), "partial v1\n");
    assert.equal(pinned("/somewhere/else"), "/somewhere/else");
  });

  it("through the runner: pi gets the pinned paths and agent directory, and agent.start names each copy", async () => {
    const agentics = pinTree("pin-runner");
    const runsDir = join(tmp.dir, "pin-runner-runs");
    const pi = fakePi(tmp.dir, "pin-pi", `console.log("seen " + JSON.stringify({ argv: process.argv.slice(2), dir: process.env.PI_CODING_AGENT_DIR }));\n`);
    const rt = createRuntime({ runsDir, piCommand: pi, agenticsDir: agentics });
    const run = await rt.start({ agent: "a", workspace: "none", input: { args: ["it"] }, journal: true });
    const result = await rt.wait(run.id);
    assert.equal(result.outcome, "done", JSON.stringify(result));
    const seen = JSON.parse((result as { data: { output: string } }).data.output.replace(/^seen /, "")) as { argv: string[]; dir: string };
    const pinnedRoot = join(rt.dir(run.id), "pinned");
    assert.equal(seen.dir, join(pinnedRoot, "agent"));
    for (const flag of ["--skill", "--prompt-template", "--system-prompt", "--append-system-prompt"]) assert.ok(seen.argv[seen.argv.indexOf(flag) + 1].startsWith(pinnedRoot), flag);
    const start = readJournal(rt.dir(run.id)).find((e) => e.kind === "agent.start")!;
    const skill = (start.data.resources as { kind: string; path: string; sha256: string; pinned?: string }[]).find((x) => x.kind === "skill")!;
    assert.equal(skill.path, join(agentics, "shared/skills/s/one"));
    assert.equal(skill.pinned, join(pinnedRoot, skill.sha256, "one"));
  });
});

describe("builder agent new", () => {
  it("creates an agent from a template through agent_create, in the tree $BUILDER_AGENTICS_DIR names", () => {
    const agentics = writeTree(join(tmp.dir, "cli-tree"), { "agents/.keep": "" });
    cpSync(join(BUILDER, "agentics", "shared", "agent-templates"), join(agentics, "shared", "agent-templates"), { recursive: true });
    const config = join(writeTree(join(tmp.dir, "cli-config"), { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(join(tmp.dir, "cli-runs"))} }\n  limit: { tools: { enable: ['*'] } }\n` }), "c.yml");
    const home = join(tmp.dir, "cli-home");
    const env = { ...process.env, HOME: home, BUILDER_AGENTICS_DIR: agentics };
    delete (env as Record<string, string | undefined>).GAFFER_CONFIG;
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(BUILDER, "cli", "builder.ts"), ...args, "--config", config], { env, encoding: "utf8", timeout: 60_000 });

    const made = cli("agent", "new", "team/scout", "--description", "Looks around", "--json");
    assert.equal(made.status, 0, made.stderr + made.stdout);
    const r = JSON.parse(made.stdout) as { id: string; template: string; files: string[] };
    assert.deepEqual([r.id, r.template], ["team/scout", "basic"]);
    assert.match(readFileSync(join(agentics, "agents/team/scout/agent.yml"), "utf8"), /^description: "Looks around"$/m);
    assert.ok(existsSync(join(agentics, "agents/team/scout/prompts/task.md")));

    const human = cli("agent", "new", "team/runner", "-t", "headless");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^created agent team\/runner from template headless/);
    assert.match(human.stdout, /run it: builder run team\/runner/);

    const again = cli("agent", "new", "team/scout", "--json");
    assert.equal(again.status, 3, "refused: it exists");
    assert.equal(JSON.parse(again.stdout).error.code, "refused");
    assert.equal(cli("agent", "new", "x", "--template", "nope").status, 2);
    assert.equal(cli("agent", "old", "x").status, 2);
    assert.match(cli("agent", "--help").stdout, /builder agent new <path>/);
  });
});
