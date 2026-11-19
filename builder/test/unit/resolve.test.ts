/**
 * config_resolve: the supabase-api and verifier agents as they resolve from the real tree (flags, tools, resources
 * with hashes), modes, data: lookup order, area: resolution, E8 (runs.may_start) and tool ceilings.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import { dataCandidates, dataPath, resolveAreas, resolveRef, specPath } from "../../runtime/paths.ts";
import { checkMayStart, resolve } from "../../runtime/resolve.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-resolve");
after(() => tmp.remove());
const NO_LIMIT = { limit: { enable: ["*"], disable: [] } };
const SUPABASE = join(AGENTICS_DIR, "agents", "supabase-api");
const SHARED = join(AGENTICS_DIR, "shared");
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

describe("resolve: the real agents", () => {
  it("supabase-api: discovery off, every resource explicit with its hash, today's tools, the /implement template, settings.json's model", () => {
    const r = resolve({ agent: "supabase-api", input: { args: ['.slice.json', 'Create "Client"'] } }, { config: NO_LIMIT, runDir: "/runs/r1" });
    assert.equal(r.agent?.id, "supabase-api");
    assert.equal(r.agent?.dir, SUPABASE);
    assert.equal(r.agent?.ymlHash, sha(join(SUPABASE, "agent.yml")));
    assert.equal(r.mode, "headless");
    assert.deepEqual(r.argv.slice(0, 6), ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes"]);
    assert.deepEqual(r.tools, ["read", "write", "edit", "grep", "find", "ls", "git", "npm", "npx", "docker", "done", "halt", "capture-learning", "context_get"]);
    assert.deepEqual(flagValues(r.argv, "--tools"), [r.tools.join(",")]);
    assert.ok(!r.tools.includes("bash"));

    const skills = ["board-change-build", "build-automation", "build-state-change", "build-state-view", "build-webhook", "emmett-reference"].map((s) => join(SHARED, "skills", "build", s));
    assert.deepEqual(flagValues(r.argv, "--skill"), skills);
    const exts = ["context", "project-tools", "outcome", "learn"].map((e) => join(SHARED, "extensions", `${e}.ts`));
    assert.deepEqual(flagValues(r.argv, "-e"), exts);
    // The write guards are gates now: resolved with their hashes, loaded by the runner through the gate host (gate-host.test.ts).
    const gates = ["blocked-paths", "write-scope", "append-only-migrations", "learnings-file"].map((g) => join(SHARED, "gates", `${g}.ts`));
    assert.deepEqual(
      r.resources.filter((x) => x.kind === "gate"),
      gates.map((path, i) => ({ kind: "gate", ref: `shared:${["blocked-paths", "write-scope", "append-only-migrations", "learnings-file"][i]}`, path, sha256: sha(path) })),
    );
    assert.deepEqual(r.writes, ["src/**", "supabase/migrations/**", "supabase/functions/**", "supabase/config.toml", "LEARNINGS.md", ".scratch/**"]);
    assert.deepEqual(flagValues(r.argv, "--prompt-template"), [join(SUPABASE, "prompts", "implement.md")]);
    assert.equal(r.argv.includes("--system-prompt") || r.argv.includes("--append-system-prompt"), false, "APPEND_SYSTEM.md is found by pi in PI_CODING_AGENT_DIR");

    const byPath = new Map(r.resources.map((x) => [x.path, x]));
    assert.deepEqual(byPath.get(join(SUPABASE, "prompts", "implement.md")), { kind: "prompt", ref: "own:prompts/implement.md", path: join(SUPABASE, "prompts", "implement.md"), sha256: sha(join(SUPABASE, "prompts", "implement.md")) });
    assert.deepEqual(byPath.get(join(SUPABASE, "APPEND_SYSTEM.md")), { kind: "system", ref: "own:APPEND_SYSTEM.md", path: join(SUPABASE, "APPEND_SYSTEM.md"), sha256: sha(join(SUPABASE, "APPEND_SYSTEM.md")) });
    assert.equal(byPath.get(exts[2])?.sha256, sha(exts[2]));
    assert.equal(byPath.get(skills[0])?.kind, "skill");
    assert.match(byPath.get(skills[0])!.sha256, /^[0-9a-f]{64}$/, "a skill directory gets a hash over its files");
    assert.equal(r.resources.filter((x) => x.kind === "prompt").length, 1, "the prompt and own:prompts/* are the same file, listed once");

    const settings = JSON.parse(readFileSync(join(SUPABASE, "settings.json"), "utf8"));
    assert.deepEqual(r.settings, { provider: settings.defaultProvider, model: settings.defaultModel, thinking: settings.defaultThinkingLevel });
    assert.deepEqual(flagValues(r.argv, "--model"), [settings.defaultModel]);
    assert.deepEqual(flagValues(r.argv, "--session-dir"), ["/runs/r1/sessions"]);
    assert.equal(r.message, '/implement ".slice.json" "Create \\"Client\\""');
    assert.deepEqual(r.argv.slice(-3), ["-p", "--", r.message]);
    assert.equal(r.env.PI_CODING_AGENT_DIR, SUPABASE);
    assert.equal(r.env.BUILDER_DONE_FILE, "/runs/r1/done.json");
    assert.equal(r.env.BUILDER_HALT_FILE, "/runs/r1/halt.json");
    assert.equal(r.env.BUILDER_RUN_DIR, "/runs/r1");
    assert.equal(r.workspace, "empty");
    assert.equal(r.cwd, "/runs/r1/workspace");
  });

  it("supabase-api on a data: dispatch: the BUILDER_* job variables and where the dispatch came from", () => {
    const r = resolve({ agent: "supabase-api", input: { dispatch: "data:dispatches/createclient-new.json" } }, { config: NO_LIMIT, runDir: "/runs/r2" });
    const file = join(SHARED, "data", "dispatches", "createclient-new.json");
    const d = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(r.dispatch, { ref: "data:dispatches/createclient-new.json", path: file, sha256: sha(file) });
    assert.equal(r.env.BUILDER_JOB_ID, d.callback.split("/").pop());
    assert.equal(r.env.BUILDER_SLICE_ID, d.task.sliceId);
    assert.equal(r.env.BUILDER_SLICE_TITLE, d.task.title);
    assert.equal(r.env.BUILDER_SLICE_CONTEXT, d.task.context);
    assert.equal(r.env.BUILDER_ATTEMPT, String(d.task.attempt));
    assert.equal(r.env.BUILDER_SLICE_FILE, ".slice.json");
    assert.equal(r.env.BUILDER_BASE, undefined, "the workspace's HEAD is added when the run starts");
    assert.equal(r.message, "/implement");
  });

  it("verifier: SYSTEM.md is the system prompt, its commands are prompt templates, its own tools; interactive starts with no message", () => {
    const dir = join(AGENTICS_DIR, "agents", "verifier");
    const r = resolve({ agent: "verifier" }, { config: NO_LIMIT, runDir: "/runs/v" });
    assert.equal(r.mode, "interactive");
    assert.deepEqual(r.tools, ["read", "grep", "find", "ls", "edit", "write", "fetch_docs", "try_rules", "verify"]);
    assert.deepEqual(flagValues(r.argv, "--system-prompt"), [join(dir, "SYSTEM.md")]);
    assert.deepEqual(flagValues(r.argv, "--prompt-template"), ["change-rules", "list-rules", "verify"].map((p) => join(dir, "prompts", `${p}.md`)));
    assert.deepEqual(flagValues(r.argv, "--skill"), [join(SHARED, "skills", "verify", "typesafe-ai")]);
    assert.deepEqual(flagValues(r.argv, "-e"), [join(dir, "extensions", "verifier.ts")]);
    assert.equal(r.message, undefined);
    assert.ok(!r.argv.includes("-p") && !r.argv.includes("--mode"), "the TUI");
    assert.throws(() => resolve({ agent: "verifier", mode: "headless" }, { config: NO_LIMIT }), /a headless run of verifier needs input\.message/);
    const h = resolve({ agent: "verifier", mode: "headless", input: { message: "/verify /w" } }, { config: NO_LIMIT, runDir: "/runs/v" });
    assert.deepEqual(h.argv.slice(-3), ["-p", "--", "/verify /w"]);
  });

  it("the machine limit narrows the tools; a spec's settings override settings.json", () => {
    const r = resolve({ agent: "supabase-api", settings: { model: "other/model", thinking: "high" } }, { config: { limit: { enable: ["files", "outcome"], disable: ["write"] } } });
    assert.deepEqual(r.tools, ["read", "edit", "grep", "find", "ls", "done", "halt"]);
    assert.equal(r.settings?.model, "other/model");
    assert.equal(r.settings?.thinking, "high");
    // The built-in limit (observe, notify) leaves supabase-api only context_get, which is in observe.
    const builtIn = resolve({ agent: "supabase-api" }, { config: { limit: { enable: ["observe", "notify"], disable: [] } } });
    assert.deepEqual(builtIn.tools, ["context_get"]);
    const locked = resolve({ agent: "supabase-api" }, { config: { limit: { enable: ["notify"], disable: [] } } });
    assert.deepEqual(locked.tools, []);
    assert.ok(locked.argv.includes("--no-tools"));
  });
});

describe("resolve: modes", () => {
  const root = writeTree(join(tmp.dir, "modes"), {
    "agents/m/agent.yml": "description: m\nprompt: own:prompts/go.md\ntools: { enable: [outcome] }\n",
    "agents/m/prompts/go.md": "Go $1\n",
  });
  const r = (mode: "headless" | "interactive" | "rpc" | "durable", input = {}) => resolve({ agent: "m", mode, input }, { config: NO_LIMIT, agentics: root, runDir: "/runs/x" });
  it("headless: -p with the template message; interactive: no message unless given; rpc: --mode rpc, the message goes over stdin", () => {
    assert.deepEqual(r("headless", { args: ["a b"] }).argv.slice(-3), ["-p", "--", '/go "a b"']);
    assert.equal(r("interactive").message, undefined);
    assert.deepEqual(r("interactive", { message: "hello" }).argv.slice(-2), ["--", "hello"]);
    const rpc = r("rpc", { args: ["x"] });
    assert.deepEqual(rpc.argv.slice(-2), ["--mode", "rpc"]);
    assert.equal(rpc.message, '/go "x"');
    assert.deepEqual(flagValues(rpc.argv, "--session-dir"), ["/runs/x/sessions"]);
  });
  it("durable: rpc with the agent's own state/sessions; the newest session there is forked into the run (its cwd is new each time)", () => {
    const d = r("durable");
    const sessions = join(root, "agents", "m", "state", "sessions");
    assert.deepEqual(flagValues(d.argv, "--session-dir"), [sessions]);
    assert.ok(!d.argv.includes("--fork") && !d.argv.includes("--continue"));
    writeTree(root, { "agents/m/state/sessions/2026-11-17_x.jsonl": "{}\n" });
    utimesSync(join(sessions, "2026-11-17_x.jsonl"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // The newest session was started in a folder this run does not work in: forked into the run's cwd.
    const home = join(root, "home");
    writeTree(root, { "home/.keep": "", "agents/m/state/sessions/2026-11-18_y.jsonl": `${JSON.stringify({ type: "session", cwd: home })}\n`, "agents/m/state/sessions/notes.txt": "x" });
    assert.deepEqual(flagValues(r("durable").argv, "--fork"), [join(sessions, "2026-11-18_y.jsonl")]);
    assert.ok(!r("durable").argv.includes("--continue"));
    // A run working in that same folder opens it in place.
    const inHome = resolve({ agent: "m", mode: "durable", workspace: { dir: { path: home } } }, { config: NO_LIMIT, agentics: root, runDir: "/runs/x" });
    assert.deepEqual([flagValues(inHome.argv, "--session"), inHome.argv.includes("--fork")], [[join(sessions, "2026-11-18_y.jsonl")], false]);
  });
});

describe("data: lookup", () => {
  const root = writeTree(join(tmp.dir, "data"), {
    "agents/team/lab/agent.yml": "description: lab\n",
    "agents/team/lab/data/only-own.json": "own",
    "agents/team/lab/data/both.json": "own",
    "agents/team/lab/data/local/both.json": "own-local",
    "agents/team/data/team.json": "team",
    "agents/team/data/both.json": "team",
    "agents/data/top.json": "top",
    "shared/data/dispatches/d.json": "shared",
    "shared/data/local/dispatches/d.json": "shared-local",
    "shared/data/team.json": "shared",
  });
  const lab = join(root, "agents", "team", "lab");
  const c = { agentDir: lab, agentics: root };
  const at = (ref: string) => readFileSync(dataPath(ref, c).path, "utf8");
  it("own data/ first, then each folder above, then shared/data; local/ before the committed file at each level", () => {
    assert.deepEqual(dataCandidates("x.json", c), [
      join(lab, "data", "local", "x.json"),
      join(lab, "data", "x.json"),
      join(root, "agents", "team", "data", "local", "x.json"),
      join(root, "agents", "team", "data", "x.json"),
      join(root, "agents", "data", "local", "x.json"),
      join(root, "agents", "data", "x.json"),
      join(root, "shared", "data", "local", "x.json"),
      join(root, "shared", "data", "x.json"),
    ]);
    assert.equal(at("data:both.json"), "own-local");
    assert.equal(at("data:only-own.json"), "own");
    assert.equal(at("data:team.json"), "team", "the nearest level wins over shared");
    assert.equal(at("data:top.json"), "top");
    assert.equal(at("data:dispatches/d.json"), "shared-local");
  });
  it("without an agent (a workflow run), only shared/data; a path that is nowhere, or climbs out, is refused", () => {
    assert.equal(readFileSync(dataPath("data:team.json", { agentics: root }).path, "utf8"), "shared");
    assert.throws(() => dataPath("data:missing.json", c), /data:missing\.json is not in any data\/ folder the agent can see/);
    assert.throws(() => dataPath("data:../agent.yml", c), /has no \.\./);
  });
  it("the real tree: the sample dispatches are in shared/data/dispatches", () => {
    assert.equal(dataPath("data:dispatches/clients-new.json", { agentDir: SUPABASE }).path, join(SHARED, "data", "dispatches", "clients-new.json"));
  });
});

describe("area: and references", () => {
  const root = writeTree(join(tmp.dir, "areas"), {
    "agents/lab/agent.yml": "description: lab\nareas:\n  work: { path: ./work, write: true }\n  apps: { path: ~/code/apps }\n  data: { write: true }\n",
    "agents/lab/work/.keep": "",
  });
  const lab = join(root, "agents", "lab");
  it("areas resolve against the agent's directory, ~ expands, data defaults to the agent's data/; undeclared areas are refused", () => {
    const areas = resolveAreas({ work: { path: "./work", write: true }, apps: { path: "~/code/apps" }, data: { write: true } }, lab);
    assert.deepEqual(areas.work, { path: join(lab, "work"), write: true });
    assert.equal(areas.apps.path, join(process.env.HOME!, "code", "apps"));
    assert.equal(areas.apps.write, false);
    assert.deepEqual(areas.data, { path: join(lab, "data"), write: true });
    assert.equal(specPath("area:work/sub/dir", { areas }), join(lab, "work", "sub", "dir"));
    assert.throws(() => specPath("area:secrets/x", { areas, owner: "agent lab" }), /area:secrets\/x: area secrets is not declared by agent lab \(areas: work, apps, data\)/);
    assert.throws(() => specPath("area:work/../..", { areas }), /\.\. is not allowed/);
    assert.throws(() => resolveAreas({ elsewhere: {} }, lab), /area elsewhere needs a path/);
  });
  it("a run spec's workspace may name an area; an undeclared one fails the resolve", () => {
    const r = resolve({ agent: "lab", mode: "interactive", workspace: { dir: { path: "area:work" } } }, { config: NO_LIMIT, agentics: root, runDir: "/runs/a" });
    assert.deepEqual(r.workspace, { dir: { path: join(lab, "work") } });
    assert.equal(r.cwd, join(lab, "work"));
    const s = resolve({ agent: "lab", mode: "interactive", workspace: { snapshot: { from: "area:apps/invoice-lite", ref: "main", into: "area:work" } } }, { config: NO_LIMIT, agentics: root, runDir: "/runs/a" });
    assert.deepEqual(s.workspace, { snapshot: { from: join(process.env.HOME!, "code", "apps", "invoice-lite"), ref: "main", into: join(lab, "work") } });
    assert.throws(() => resolve({ agent: "lab", mode: "interactive", workspace: { dir: { path: "area:nope" } } }, { config: NO_LIMIT, agentics: root }), /area nope is not declared by agent lab/);
  });
  it("shared:, own: and builder: references, globs, and what does not resolve", () => {
    assert.deepEqual(resolveRef("shared:outcome", "extension", {}), [join(SHARED, "extensions", "outcome.ts")]);
    assert.equal(resolveRef("shared:build/*", "skill", {}).length, 6);
    assert.deepEqual(resolveRef("own:prompts/implement", "prompt", { agentDir: SUPABASE }), [join(SUPABASE, "prompts", "implement.md")]);
    assert.deepEqual(resolveRef("builder:supabase-api/builder.ts", "extension", {}), [join(AGENTICS_DIR, "builders", "supabase-api", "builder.ts")]);
    assert.throws(() => resolveRef("shared:nope", "extension", {}), /shared:nope does not resolve/);
    assert.throws(() => resolveRef("outcome", "extension", {}), /starts with shared:, own:, builder: or data:/);
  });
});

describe("E8: runs.may_start and tool ceilings", () => {
  const parent = (mayStart: string[], ceiling: string[] | null = null): RunRecord => ({
    id: "p1",
    parent: null,
    kind: "agent",
    spec: { agent: "lab" },
    state: "running",
    pid: 1,
    startedAt: "2026-11-17T00:00:00.000Z",
    resolved: { mode: "interactive", cwd: "/", workspace: "none", tools: ceiling ?? [], resources: [], argv: [], env: {}, areas: {}, mayStart },
    ceiling,
  });
  it("a child is refused unless the parent agent's runs.may_start matches it", () => {
    const p = parent(["workflow:supabase-api*", "agent:verifier"]);
    assert.doesNotThrow(() => checkMayStart(p, { workflow: "supabase-api" }));
    assert.doesNotThrow(() => checkMayStart(p, { workflow: "supabase-api-verified" }));
    assert.doesNotThrow(() => checkMayStart(p, { agent: "verifier" }));
    assert.throws(() => checkMayStart(p, { agent: "supabase-api" }), /run refused: agent lab \(run p1\) may not start agent:supabase-api \(runs\.may_start: workflow:supabase-api\*, agent:verifier\)/);
    assert.throws(() => checkMayStart(parent([]), { agent: "verifier" }), /may not start agent:verifier \(runs\.may_start: none\)/);
    assert.doesNotThrow(() => checkMayStart(parent(["*"]), { agent: "anything/at-all" }));
    assert.doesNotThrow(() => checkMayStart({ ...p, kind: "workflow" }, { agent: "supabase-api" }), "a workflow run starts its own steps");
    assert.doesNotThrow(() => checkMayStart(null, { agent: "supabase-api" }), "the CLI and the server start anything");
  });
  it("an allowed child gets at most the parent's tools", () => {
    const p = parent(["agent:supabase-api"], ["read", "grep", "done", "git"]);
    const r = resolve({ agent: "supabase-api" }, { config: NO_LIMIT, parent: p });
    assert.deepEqual(r.tools, ["read", "grep", "git", "done"]);
    assert.throws(() => resolve({ agent: "verifier" }, { config: NO_LIMIT, parent: p }), /may not start agent:verifier/);
  });
});
