/**
 * agents/ops and the shared authoring skills, as they are in the real tree: ops resolves durable with SYSTEM.md, the
 * authoring skills, the write-scope gate and the tool groups of design section 10 (no messaging, no outcome); its
 * agent.yml has the API and the two triggers; its file tools write the builder's code but never the agent tree
 * (definitions change only through the definitions tools) or the machine config; its state/ is gitignored. SYSTEM.md
 * and every authoring skill name only tools that exist and only paths that exist, so the playbook cannot rot silently.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { gateContext, type GateContextData } from "../../engine/gates.ts";
import writeScope from "../../agentics/shared/gates/write-scope.ts";
import { checkAgent } from "../../ops/definitions/validate.ts";
import { allTools, groups } from "../../ops/groups.ts";
import { PACKAGED_CONFIG } from "../../ops/config.ts";
import { gateHostFor, loadAgent, resolve } from "../../runtime/resolve.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "../../runtime/root.ts";

const OPS = join(AGENTICS_DIR, "agents", "ops");
const AUTHORING = join(AGENTICS_DIR, "shared", "skills", "authoring");
const SKILLS = ["writing-agents", "writing-gates", "writing-skills", "writing-templates", "writing-workflows"];
const NO_LIMIT = { limit: { enable: ["*"], disable: [] } };

const ops = resolve({ agent: "ops" }, { config: NO_LIMIT, runDir: "/runs/ops" });

/** The tool names a document puts in backticks (the first word of each span): `run_start { ... }` names run_start. */
const toolsNamed = (text: string): string[] => [...new Set([...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]))];

/** The builder paths a document puts in backticks: `engine/gates.ts`, `builder/ops/config.yml` (no placeholders or globs). */
function pathsNamed(text: string): string[] {
  const out = new Set<string>();
  for (const [, span] of text.matchAll(/`([^`\s]+)`/g)) {
    if (/[<>{}*$~]/.test(span)) continue;
    if (/^(builder\/)?(agentics|engine|runtime|ops|server|cli|test|vm|tsf)\/[\w./-]*$/.test(span)) out.add(span.replace(/^builder\//, ""));
  }
  return [...out];
}

describe("agents/ops", () => {
  it("resolves durable, with SYSTEM.md, the authoring skills, the write-scope gate and its session in its own state/", () => {
    assert.equal(ops.agent?.id, "ops");
    assert.equal(ops.mode, "durable");
    assert.deepEqual(
      ops.resources.filter((r) => r.kind === "system").map((r) => r.path),
      [join(OPS, "SYSTEM.md")],
    );
    assert.deepEqual(
      ops.resources.filter((r) => r.kind === "skill").map((r) => r.path),
      SKILLS.map((s) => join(AUTHORING, s)),
    );
    assert.deepEqual(ops.resources.filter((r) => r.kind === "gate").map((r) => r.ref), ["shared:write-scope"]);
    assert.equal(ops.message, undefined, "no first message: its turns come from the operator and its triggers");
    const sessions = ops.argv.indexOf("--session-dir");
    assert.equal(ops.argv[sessions + 1], join(OPS, "state", "sessions"));
    assert.ok(ops.argv.includes("rpc"));
  });

  it("has the tool groups of design section 10: observe, operate, process, runs, definitions, files, git, notify", () => {
    const g = groups();
    for (const group of ["observe", "operate", "process", "runs", "definitions", "files", "git", "notify"]) for (const t of g[group]) assert.ok(ops.tools.includes(t), `${group}: ${t}`);
    for (const t of [...g.messaging, ...g.outcome, ...g.verify, ...g.project]) assert.ok(!ops.tools.includes(t), `not ${t}`);
    assert.deepEqual(ops.mayStart, ["*"]);
  });

  it("serves the API on 127.0.0.1:8090 with its token from OPS_API_TOKEN, and has a job.failed and a daily trigger", () => {
    assert.deepEqual(ops.api, { host: "127.0.0.1", port: 8090, token: "env:OPS_API_TOKEN" });
    assert.deepEqual(loadAgent("ops").yml.triggers, [{ on: "job.failed" }, { cron: "daily", prompt: "review the last day's jobs" }]);
    const raw = parse(readFileSync(join(OPS, "agent.yml"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.prompt, "own:SYSTEM.md");
    assert.deepEqual(raw.uses, { skills: ["shared:authoring/*"] });
  });

  it("its file tools write the builder's code, never the agent tree or the machine config (write-scope)", async () => {
    const host = gateHostFor(ops)!;
    const data: GateContextData = { ...host.file.json.ctx, protectedPaths: [PACKAGED_CONFIG, join(homedir(), ".gaffer")] };
    const ctx = gateContext(data);
    const write = (path: string) => writeScope.check({ tool: "write", input: { path, content: "x" } }, ctx);
    for (const p of ["engine/workflow.ts", "runtime/run.ts", "ops/core/notify.ts", "server/http.ts", "cli/builder.ts", "test/unit/x.test.ts", "vm/install.sh", "tsf/layers/builder/x.ts"]) {
      assert.deepEqual(await write(join(BUILDER_ROOT, p)), { allow: true }, p);
    }
    for (const p of ["agentics/agents/ops/agent.yml", "agentics/agents/ops/MEMORY.md", "agentics/shared/skills/build/build-state-change/SKILL.md", "agentics/builders/supabase-api/builder.ts", "package.json"]) {
      const d = await write(join(BUILDER_ROOT, p));
      assert.ok("block" in d && /outside what this agent may write/.test(d.reason), `${p}: ${JSON.stringify(d)}`);
    }
    for (const p of [PACKAGED_CONFIG, join(homedir(), ".gaffer", "config.yml")]) {
      const d = await write(p);
      assert.ok("block" in d && /machine config/.test(d.reason), `${p}: ${JSON.stringify(d)}`);
    }
  });

  it("is a valid definition; state/ and pi's model cache are gitignored, its playbook and memory are not; bin/fd is the shared one", () => {
    const info = checkAgent("ops", AGENTICS_DIR);
    assert.ok(info.ok, info.error);
    const ignored = (rel: string) => spawnSync("git", ["check-ignore", "-q", rel], { cwd: OPS }).status === 0;
    assert.ok(ignored("state/sessions/x.jsonl"));
    assert.ok(ignored("models-store.json"));
    for (const f of ["agent.yml", "SYSTEM.md", "MEMORY.md", "settings.json", "models.json"]) {
      assert.ok(existsSync(join(OPS, f)), f);
      assert.ok(!ignored(f), f);
    }
    assert.equal(readlinkSync(join(OPS, "bin", "fd")), "../../supabase-api/bin/fd");
    assert.ok(existsSync(join(OPS, "bin", "fd")));
  });

  it("SYSTEM.md tells it to call only tools it has, and names only paths that exist", () => {
    const text = readFileSync(join(OPS, "SYSTEM.md"), "utf8");
    const named = toolsNamed(text);
    for (const t of ["journal_query", "context_get", "run_start", "run_wait", "git_branch", "git_commit", "git_push", "notify_operator", "notifications_list", "agent_update"]) assert.ok(named.includes(t), `the playbook uses ${t}`);
    for (const t of named) assert.ok(ops.tools.includes(t), `SYSTEM.md names ${t}, which ops does not have`);
    for (const p of pathsNamed(text)) assert.ok(existsSync(join(BUILDER_ROOT, p)), `SYSTEM.md names ${p}, which does not exist`);
    const memory = readFileSync(join(OPS, "MEMORY.md"), "utf8");
    assert.match(memory, /^# ops memory/);
  });
});

describe("shared/skills/authoring", () => {
  it("holds the five skills, each with front matter naming its folder and a description", () => {
    assert.deepEqual(readdirSync(AUTHORING).sort(), SKILLS);
    for (const s of SKILLS) {
      const text = readFileSync(join(AUTHORING, s, "SKILL.md"), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
      assert.ok(fm, `${s}: front matter`);
      const meta = parse(fm[1]) as { name?: string; description?: string };
      assert.equal(meta.name, s);
      assert.ok(meta.description && meta.description.length > 40 && meta.description.length <= 1024, `${s}: description`);
      assert.match(meta.description!, /Use (before|when)/, `${s}: the description says when to use it`);
    }
  });

  it("each points at real files and real tools", () => {
    const known = new Set(allTools());
    for (const s of SKILLS) {
      const text = readFileSync(join(AUTHORING, s, "SKILL.md"), "utf8");
      const paths = pathsNamed(text);
      assert.ok(paths.length >= 4, `${s} points at files`);
      for (const p of paths) assert.ok(existsSync(join(BUILDER_ROOT, p)), `${s} names ${p}, which does not exist`);
      // Not tools: an agent.yml key (runs.may_start) and the events a gate runs on.
      const words = new Set(["may_start", "tool_call", "tool_result"]);
      for (const t of toolsNamed(text)) assert.ok(known.has(t) || words.has(t), `${s} names ${t}, which is not a tool`);
    }
    assert.ok(existsSync(dirname(AUTHORING)));
  });
});
