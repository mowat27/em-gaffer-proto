/**
 * The verify group and the verified workflow: verify() runs the verifier agent's run.ts in a fresh process (the real
 * one for the rules and a build with no changes, a stand-in for verdicts), the `verify` tool resolves the caller's
 * paths (area:, data:, relative to its run), the verify step stores verify.json and fails the run on a fail verdict
 * with the summary as the reason, a StepFailure keeps its output, and supabase-api-verified is the build plus verify.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ContextStore } from "../../engine/context.ts";
import { loadBuilder } from "../../engine/load.ts";
import { verdictReason, verifyStep } from "../../engine/steps/verify.ts";
import type { Job } from "../../engine/types.ts";
import { code, defineBuilder, runWorkflow, StepFailure } from "../../engine/workflow.ts";
import { DEFAULTS } from "../../agentics/builders/supabase-api/builder.ts";
import { VERIFY_BUDGET_MINUTES } from "../../agentics/builders/supabase-api-verified/builder.ts";
import { verdictOf } from "../../agentics/agents/verifier/extensions/verifier.ts";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { verifierRules, verify, verifierRun, type VerifyResult } from "../../ops/core/verify.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { RunRecord, Runtime } from "../../runtime/types.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-verify");
after(() => tmp.remove());

/**
 * A stand-in verifier: run.ts prints what `<workspace>/verdict.json` says, with the arguments it got; `crash` in the
 * workspace makes it exit 3, `garbage` print no JSON, `slow` sleep. `--list` prints one rule.
 */
const agentics = writeTree(join(tmp.dir, "agentics"), {
  "package.json": '{ "type": "module" }\n',
  "agents/verifier/agent.yml": "description: a stand-in verifier\nmode: headless\n",
  "agents/verifier/run.ts": `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--list") { console.log(JSON.stringify([{ id: "fake", kind: "code", rule: "a stand-in rule" }])); process.exit(0); }
const ws = args[args.indexOf("--workspace") + 1];
if (existsSync(join(ws, "crash"))) { console.error("checks.ts exploded"); process.exit(3); }
if (existsSync(join(ws, "garbage"))) { console.log("not json"); process.exit(0); }
if (existsSync(join(ws, "slow"))) await new Promise((r) => setTimeout(r, 60_000));
const v = JSON.parse(readFileSync(join(ws, "verdict.json"), "utf8"));
console.log(JSON.stringify({ ...v, args }));
`,
  "agents/lab/agent.yml": "description: a lab\nmode: headless\ntools: { enable: [verify] }\nareas: { apps: { path: ../../apps } }\n",
  "agents/lab/data/slices/one.json": '{ "title": "One" }\n',
  "apps/app-a/verdict.json": JSON.stringify({ verdict: "pass", summary: "3 checks, 0 failed, 0 unsure", findings: [] }),
  "apps/app-a/.slice.json": '{ "title": "A" }\n',
});

const PASS = { verdict: "pass", summary: "3 checks, 0 failed, 0 unsure", findings: [{ id: "tests.count", kind: "code", status: "pass", detail: "2 it() for 2 specs" }] };
const FAIL = {
  verdict: "fail",
  summary: "4 checks, 1 failed, 1 unsure",
  findings: [
    { id: "endpoint.route", kind: "code", status: "fail", detail: "no POST /api/create-client/:clientId" },
    { id: "scope", kind: "jev", status: "check", detail: "unsure" },
    { id: "tests.count", kind: "code", status: "pass", detail: "ok" },
  ],
};

let n = 0;
/** A workspace with a verdict for the stand-in and a .slice.json (unless `slice` is false). */
function workspace(verdict: object | null, o: { slice?: boolean; marker?: string } = {}): string {
  const dir = join(tmp.dir, "ws", `w-${++n}`);
  mkdirSync(dir, { recursive: true });
  if (verdict) writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict));
  if (o.slice !== false) writeFileSync(join(dir, ".slice.json"), '{ "title": "T" }\n');
  if (o.marker) writeFileSync(join(dir, o.marker), "");
  return dir;
}

const argsOf = (r: VerifyResult) => (r as VerifyResult & { args: string[] }).args;

describe("verify(): the verifier's run.ts in a fresh process", { concurrency: true }, () => {
  it("passes the workspace, the slice (default its .slice.json) and the base (default HEAD), and returns the verdict with the build", async () => {
    const ws = workspace(PASS);
    const r = await verify(ws, undefined, undefined, { agentics });
    assert.equal(r.verdict, "pass");
    assert.equal(r.summary, PASS.summary);
    assert.deepEqual(r.findings, PASS.findings);
    assert.deepEqual([r.workspace, r.slice, r.base], [ws, join(ws, ".slice.json"), "HEAD"]);
    assert.deepEqual(argsOf(r), ["--workspace", ws, "--slice", join(ws, ".slice.json"), "--base", "HEAD"]);
    assert.equal(typeof r.ms, "number");
    const other = join(tmp.dir, "slice-other.json");
    writeFileSync(other, "{}");
    const r2 = await verify(workspace(FAIL), other, "abc1234", { agentics });
    assert.equal(r2.verdict, "fail");
    assert.deepEqual(argsOf(r2).slice(2), ["--slice", other, "--base", "abc1234"]);
  });

  it("says what is wrong: no workspace, no slice, a crash, no JSON, no verdict, no verifier", async () => {
    await assert.rejects(verify(join(tmp.dir, "nowhere"), undefined, undefined, { agentics }), /workspace .*nowhere is not a directory/);
    await assert.rejects(verify(workspace(PASS, { slice: false }), undefined, undefined, { agentics }), /no slice to verify against: .*\.slice\.json does not exist/);
    await assert.rejects(verify(workspace(PASS, { marker: "crash" }), undefined, undefined, { agentics }), /the verifier failed: checks\.ts exploded/);
    await assert.rejects(verify(workspace(PASS, { marker: "garbage" }), undefined, undefined, { agentics }), /the verifier printed no JSON: not json/);
    await assert.rejects(verify(workspace({ verdict: "maybe", findings: [] }), undefined, undefined, { agentics }), /the verifier returned no verdict/);
    assert.throws(() => verifierRun(join(tmp.dir, "empty-tree")), /no agent verifier/);
  });

  it("a signal stops the verifier process", async () => {
    const ctl = new AbortController();
    const p = verify(workspace(PASS, { marker: "slow" }), undefined, undefined, { agentics, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 200);
    const t0 = Date.now();
    await assert.rejects(p, /the verifier failed: stopped/);
    assert.ok(Date.now() - t0 < 10_000);
  });

  it("the real verifier: its rules, and a build that changed nothing fails without asking Jev", async () => {
    const rules = await verifierRules();
    assert.ok(rules.some((r) => r.id === "endpoint.route" && r.kind === "code"));
    assert.ok(rules.some((r) => r.id === "scope" && r.kind === "jev"));
    const repo = join(tmp.dir, "unchanged");
    writeTree(repo, { "src/index.ts": "export const x = 1;\n", ".slice.json": '{ "title": "T", "sliceType": "STATE_CHANGE", "context": "C" }\n' });
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["add", "src"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const r = await verify(repo);
    assert.equal(r.verdict, "fail");
    assert.equal(r.summary, "the build changed no files");
    assert.deepEqual(r.findings.map((f) => [f.id, f.status]), [["changes", "fail"]]);
  });
});

describe("the verify tool", { concurrency: true }, () => {
  const runsDir = join(tmp.dir, "runs");
  const none = join(tmp.dir, "absent.yml");
  const configFile = join(writeTree(join(tmp.dir, "config"), { "c.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` }), "c.yml");
  const config = loadConfig({ packaged: none, userConfig: none, env: {}, configPath: configFile });
  const runtime = createRuntime({ runsDir, piCommand: "/bin/false", agenticsDir: agentics, limit: config.limit });
  const cli = cliContext(config, runtime);

  /** A lab agent's run, as its resolve would have pinned it: its areas, its directory and its working directory. */
  function labRun(id: string, cwd: string): ToolContext {
    const rec: RunRecord = {
      id,
      parent: null,
      kind: "agent",
      spec: { agent: "lab" },
      state: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      resolved: {
        agent: { id: "lab", dir: join(agentics, "agents", "lab"), ymlHash: "", defaults: [] },
        mode: "headless",
        cwd,
        workspace: "none",
        tools: ["verify"],
        resources: [],
        argv: [],
        env: {},
        areas: { apps: { path: join(agentics, "apps"), write: false } },
        mayStart: [],
      },
    };
    mkdirSync(join(runsDir, id), { recursive: true });
    writeFileSync(join(runsDir, id, "run.json"), JSON.stringify(rec));
    return { ...cli, caller: { kind: "agent", runId: id, agent: "lab", allowed: new Set(["verify"]) } };
  }

  it("is a built core tool in the verify group; the CLI calls it with absolute paths", async () => {
    const ws = workspace(PASS);
    const r = (await callTool("verify", { workspace: ws, base: "main" }, cli)) as VerifyResult;
    assert.equal(r.verdict, "pass");
    assert.deepEqual([r.workspace, r.base], [ws, "main"]);
  });

  it("an agent names paths as its run does: area:, data: and relative to its working directory", async () => {
    const ctx = labRun("20261118-120000-0000a1", join(agentics, "apps"));
    const byArea = (await callTool("verify", { workspace: "area:apps/app-a", slice: "data:slices/one.json" }, ctx)) as VerifyResult;
    assert.equal(byArea.workspace, join(agentics, "apps", "app-a"));
    assert.equal(byArea.slice, join(agentics, "agents", "lab", "data", "slices", "one.json"));
    const relative = (await callTool("verify", { workspace: "app-a" }, ctx)) as VerifyResult;
    assert.equal(relative.workspace, join(agentics, "apps", "app-a"));
    assert.equal(relative.slice, join(agentics, "apps", "app-a", ".slice.json"));
  });

  it("an undeclared area is invalid; a verifier failure comes back as failed; workspace is required", async () => {
    const ctx = labRun("20261118-120000-0000a2", tmp.dir);
    await assert.rejects(callTool("verify", { workspace: "area:work/x" }, ctx), (e) => isToolError(e) && e.code === "invalid" && /area work is not declared by agent lab/.test(e.message));
    await assert.rejects(callTool("verify", { workspace: "area:apps/x" }, cli), (e) => isToolError(e) && e.code === "invalid" && /not declared by the CLI/.test(e.message));
    await assert.rejects(callTool("verify", { workspace: workspace(PASS, { marker: "crash" }) }, cli), (e) => isToolError(e) && e.code === "failed" && /checks\.ts exploded/.test(e.message));
    await assert.rejects(callTool("verify", {}, cli), (e) => isToolError(e) && e.code === "invalid");
  });

  it("the verifier extension reads the tool's result back (the last build and its screen)", () => {
    const v = { workspace: "/w", slice: "/w/.slice.json", base: "HEAD", ms: 5, ...PASS };
    assert.deepEqual(verdictOf({ content: [{ type: "text", text: JSON.stringify(v) }] }), v);
    assert.equal(verdictOf({ content: [{ type: "text", text: "refused: verify is not allowed" }] }), null);
    assert.equal(verdictOf(undefined), null);
  });
});

describe("the verify step and supabase-api-verified", { concurrency: true }, () => {
  const runtimeIn = (runDir: string): Runtime => ({ options: { agenticsDir: agentics }, dir: () => runDir }) as unknown as Runtime;

  function job(runId: string): Job {
    const startedAt = Date.now();
    return {
      runId,
      jobId: `job-${runId}`,
      dispatch: { requires: [], repo: { url: "/r", base: "abc1234" }, task: { sliceId: "s", title: "T", context: "C", handover: false, attempt: 1 }, slice: { title: "From the dispatch" }, callback: "http://x/jobs/j" },
      startedAt,
      deadline: startedAt + 60_000,
    };
  }

  async function runVerified(verdict: object, o: { prepare?: boolean } = {}) {
    const runDir = join(tmp.dir, "step-runs", `r-${++n}`);
    const ws = workspace(verdict, { slice: o.prepare !== false });
    const store = new ContextStore(join(runDir, "context"));
    const events: { kind: string; data?: Record<string, unknown> }[] = [];
    const b = defineBuilder({
      name: "verified-test",
      provides: [],
      steps: [...(o.prepare === false ? [] : [code("prepare", async () => ({ appDir: ws }))]), code("verify", verifyStep)],
    });
    const result = await runWorkflow(b, {
      job: job(`r-${n}`),
      dir: ws,
      store,
      runtime: runtimeIn(runDir),
      signal: new AbortController().signal,
      log: () => {},
      emit: (kind, _msg, data) => void events.push({ kind, ...(data ? { data } : {}) }),
    });
    return { result, store, ws, runDir, events };
  }

  it("a pass is the step's output (verify.json in the context store), judged from the job's base against prepare's app directory", async () => {
    const { result, store, ws, events } = await runVerified(PASS);
    assert.deepEqual(result, { outcome: "done" });
    const v = store.get<VerifyResult & { args: string[] }>("verify");
    assert.equal(v.verdict, "pass");
    assert.deepEqual(v.args, ["--workspace", ws, "--slice", join(ws, ".slice.json"), "--base", "abc1234"]);
    assert.ok(existsSync(join(store.dir, "outputs", "verify.json")));
    assert.deepEqual(events.find((e) => e.kind === "verify.verdict")?.data, { verdict: "pass", summary: PASS.summary });
  });

  it("a fail fails the run with the verdict's summary (and the failed and unsure ids) as the reason, and verify.json is still stored", async () => {
    const { result, store } = await runVerified(FAIL);
    assert.deepEqual(result, { outcome: "failed", reason: "FAIL: 4 checks, 1 failed, 1 unsure: endpoint.route, scope (unsure)" });
    const v = store.get<VerifyResult>("verify");
    assert.equal(v.verdict, "fail");
    assert.deepEqual(v.findings, FAIL.findings);
    assert.equal(verdictReason({ summary: "1 checks, 0 failed, 0 unsure", findings: [] }), "FAIL: 1 checks, 0 failed, 0 unsure");
  });

  it("without a prepare step it verifies the workspace root, against the dispatch's slice written in the run's folder", async () => {
    const { result, store, ws, runDir } = await runVerified(PASS, { prepare: false });
    assert.deepEqual(result, { outcome: "done" });
    const v = store.get<VerifyResult & { args: string[] }>("verify");
    assert.equal(v.workspace, ws);
    assert.equal(v.slice, join(runDir, "verify-slice.json"));
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, "verify-slice.json"), "utf8")), { title: "From the dispatch" });
  });

  it("a StepFailure stores its output and fails with its message; the steps after it never run", async () => {
    const runDir = join(tmp.dir, "step-runs", `r-${++n}`);
    const store = new ContextStore(join(runDir, "context"));
    const ran: string[] = [];
    const b = defineBuilder({
      name: "t",
      provides: [],
      steps: [
        code("judge", async () => {
          throw new StepFailure("judged wrong", { why: "a reason" });
        }),
        code("after", async () => void ran.push("after")),
      ],
    });
    const result = await runWorkflow(b, { job: job("sf"), dir: runDir, store, runtime: runtimeIn(runDir), signal: new AbortController().signal, log: () => {}, emit: () => {} });
    assert.deepEqual(result, { outcome: "failed", reason: "judged wrong" });
    assert.deepEqual(store.get("judge"), { why: "a reason" });
    assert.deepEqual(ran, []);
  });

  it("supabase-api-verified: the supabase-api build inline, then verify; it provides what supabase-api provides", async () => {
    const b = await loadBuilder("supabase-api-verified");
    assert.equal(b.name, "supabase-api-verified");
    assert.deepEqual(b.provides, DEFAULTS.provides);
    assert.equal(b.budgetMinutes, DEFAULTS.budgetMinutes + VERIFY_BUDGET_MINUTES);
    assert.deepEqual(
      b.steps.map((s) => [s.name, s.kind]),
      [
        ["build", "workflow"],
        ["verify", "code"],
      ],
    );
    assert.equal((b.steps[0] as { builder: string }).builder, "supabase-api");
    assert.equal((b.steps[1] as { budgetMinutes?: number }).budgetMinutes, VERIFY_BUDGET_MINUTES);
  });
});
