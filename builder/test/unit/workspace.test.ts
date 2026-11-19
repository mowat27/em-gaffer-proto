/**
 * Workspaces (empty, snapshot, dir, none) and a directly launched agent run end to end with a fake pi: the snapshot it
 * works in, its job.json and BUILDER_* variables, and how it ends (done, without done, an agent without done).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createRuntime } from "../../runtime/run.ts";
import { prepareWorkspace, workspaceHead } from "../../runtime/workspace.ts";
import { createFixtureRepo } from "../harness/fixture-repo.ts";
import { GIT_ENV, tempDir } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const tmp = tempDir("builder-workspace");
after(() => tmp.remove());
for (const [k, v] of Object.entries(GIT_ENV)) process.env[k] = v;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let n = 0;
const runDir = () => {
  const d = join(tmp.dir, "runs", `run-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const snapshotsDir = join(tmp.dir, "runs", ".snapshots");
const repo = createFixtureRepo(tmp.dir);

describe("workspaces", () => {
  it("empty: a new folder under the run, emptied if it was there", () => {
    const d = runDir();
    writeTree(d, { "workspace/old.txt": "x" });
    const ws = prepareWorkspace(d, "empty", { snapshotsDir });
    assert.equal(ws, join(d, "workspace"));
    assert.deepEqual(readdirSync(ws), []);
  });

  it("none: the run's own folder; dir: the folder in place, which must exist", () => {
    const d = runDir();
    assert.equal(prepareWorkspace(d, "none", { snapshotsDir }), d);
    assert.equal(prepareWorkspace(d, { dir: { path: repo.url } }, { snapshotsDir }), repo.url);
    assert.throws(() => prepareWorkspace(d, { dir: { path: join(tmp.dir, "nope") } }, { snapshotsDir }), /is not a directory/);
  });

  it("snapshot of a ref: git archive into a snapshot made once per commit, then a copy with one commit and the excludes", () => {
    writeFileSync(join(repo.url, "uncommitted.txt"), "not in the ref\n");
    const d = runDir();
    const ws = prepareWorkspace(d, { snapshot: { from: repo.url, ref: "main" } }, { snapshotsDir });
    assert.equal(ws, join(d, "workspace"));
    const snap = join(snapshotsDir, `scaffold-${repo.base.slice(0, 12)}`);
    assert.ok(existsSync(snap), "the snapshot is cached by commit");
    assert.equal(git(ws, "log", "--format=%s"), `scaffold ${repo.base}`, "one commit, not the repository's history");
    assert.ok(existsSync(join(ws, "src", "index.ts")));
    assert.ok(!existsSync(join(ws, "uncommitted.txt")), "a ref takes only committed work");
    assert.match(readFileSync(join(ws, ".git", "info", "exclude"), "utf8"), /\.slice\.json\nnode_modules\n\.scratch\//);
    assert.equal(git(ws, "status", "--porcelain"), "");
    // The second run reuses the snapshot and gets a fresh copy.
    const marker = join(snap, "marker-of-the-cached-snapshot");
    writeFileSync(marker, "x");
    git(snap, "add", "-A");
    git(snap, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "marker");
    const ws2 = prepareWorkspace(runDir(), { snapshot: { from: repo.url, ref: "main" } }, { snapshotsDir });
    assert.ok(existsSync(join(ws2, "marker-of-the-cached-snapshot")), "made once per commit, then reused");
  });

  it("snapshot into another folder refills it (emptied first) and links node_modules to the snapshot's", () => {
    const into = join(tmp.dir, "work");
    writeTree(into, { "stale.txt": "x" });
    const snap = join(snapshotsDir, `scaffold-${repo.base.slice(0, 12)}`);
    mkdirSync(join(snap, "node_modules", ".bin"), { recursive: true });
    const ws = prepareWorkspace(runDir(), { snapshot: { from: repo.url, ref: repo.base, into } }, { snapshotsDir });
    assert.equal(ws, into);
    assert.ok(!existsSync(join(into, "stale.txt")));
    assert.ok(lstatSync(join(into, "node_modules")).isSymbolicLink());
    assert.equal(git(into, "status", "--porcelain"), "", "node_modules is excluded");
  });

  it("snapshot of a folder (no ref): a copy as it is, uncommitted changes included, without its .git", () => {
    const ws = prepareWorkspace(runDir(), { snapshot: { from: repo.url } }, { snapshotsDir });
    assert.ok(existsSync(join(ws, "uncommitted.txt")));
    assert.equal(git(ws, "log", "--format=%s"), `snapshot of ${repo.url}`);
    assert.notEqual(workspaceHead(ws), repo.base);
    assert.equal(git(ws, "status", "--porcelain"), "");
  });
});

describe("a directly launched agent run (fake pi)", () => {
  // The fake pi records what it was given, then acts on its message: "done" writes the done file, "halt" the halt file.
  const pi = fakePi(
    tmp.dir,
    "fake-pi",
    `import { writeFileSync } from "node:fs";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(BUILDER_|PI_)/.test(k)));
writeFileSync(process.env.BUILDER_RUN_DIR + "/fake-pi.json", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }));
const message = process.argv[process.argv.length - 1];
if (message.includes("done")) writeFileSync(process.env.BUILDER_DONE_FILE, JSON.stringify({ ok: true }));
if (message.includes("halt")) writeFileSync(process.env.BUILDER_HALT_FILE, JSON.stringify({ reason: "cannot build it" }));
console.log("final answer: " + message);
`,
  );
  const agentics = writeTree(join(tmp.dir, "agentics"), {
    "agents/builder-like/agent.yml": "description: has done\nmode: headless\ntools: { enable: [files, outcome] }\n",
    "agents/reader/agent.yml": "description: no done\nmode: headless\ntools: { enable: [read] }\n",
    "shared/data/dispatches/thing.json": JSON.stringify({ repo: { url: "x", base: "y" }, task: { sliceId: "s-1", title: "CreateThing", context: "Billing", attempt: 2 }, slice: { title: "CreateThing" }, callback: "http://127.0.0.1:9/jobs/job-thing" }),
  });
  const rt = createRuntime({ runsDir: join(tmp.dir, "runs"), piCommand: pi, agenticsDir: agentics });
  const seen = (id: string) => JSON.parse(readFileSync(join(rt.dir(id), "fake-pi.json"), "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };

  it("in a snapshot, on a data: dispatch: job.json, the BUILDER_* variables, BUILDER_BASE = the workspace's HEAD, done when done is called", async () => {
    const rec = await rt.start({ agent: "builder-like", workspace: { snapshot: { from: repo.url, ref: "main" } }, input: { dispatch: "data:dispatches/thing.json", message: "build it, then done" } });
    assert.deepEqual(await rt.wait(rec.id), { outcome: "done", data: { done: { ok: true }, pi: rec.resolved!.settings } });
    const s = seen(rec.id);
    const ws = join(rt.dir(rec.id), "workspace");
    assert.equal(s.cwd, realpathSync(ws));
    assert.equal(s.env.BUILDER_JOB_ID, "job-thing");
    assert.equal(s.env.BUILDER_SLICE_ID, "s-1");
    assert.equal(s.env.BUILDER_SLICE_TITLE, "CreateThing");
    assert.equal(s.env.BUILDER_ATTEMPT, "2");
    assert.equal(s.env.BUILDER_BASE, workspaceHead(ws));
    assert.equal(s.env.BUILDER_RUN_DIR, rt.dir(rec.id));
    // pi's agent directory is the run's pinned copy of the agent's (runtime/pin.ts, D10), linking back to its files.
    assert.equal(s.env.PI_CODING_AGENT_DIR, join(rt.dir(rec.id), "pinned", "agent"));
    assert.equal(realpathSync(join(s.env.PI_CODING_AGENT_DIR, "agent.yml")), realpathSync(join(agentics, "agents", "builder-like", "agent.yml")));
    assert.deepEqual(s.argv.slice(-3), ["-p", "--", "build it, then done"]);
    const job = JSON.parse(readFileSync(join(rt.dir(rec.id), "context", "job.json"), "utf8"));
    assert.equal(job.runId, rec.id);
    assert.equal(job.jobId, "job-thing");
    assert.equal(job.base, workspaceHead(ws));
    assert.deepEqual(job.dispatch.slice, { title: "CreateThing" });
    const onDisk = JSON.parse(readFileSync(join(rt.dir(rec.id), "run.json"), "utf8"));
    assert.equal(onDisk.resolved.agent.id, "builder-like", "what the run resolved to is pinned in run.json");
    assert.deepEqual(onDisk.ceiling, ["read", "write", "edit", "bash", "grep", "find", "ls", "done", "halt"]);
  });

  it("a job (a run with a dispatch) whose agent has done fails as today when it finishes without calling it; a halt fails with its reason", async () => {
    const a = await rt.start({ agent: "builder-like", workspace: "none", input: { dispatch: "data:dispatches/thing.json", message: "just stop" } });
    assert.deepEqual(await rt.wait(a.id), { outcome: "failed", reason: "the agent finished without calling done" });
    const b = await rt.start({ agent: "builder-like", workspace: "none", input: { message: "halt" } });
    assert.deepEqual(await rt.wait(b.id), { outcome: "failed", reason: "cannot build it", halted: true });
  });

  it("a run without a dispatch is done when pi exits cleanly, done tool or not; done still decides when called (G3, G9)", async () => {
    // builder-like enables outcome (as slice-lab does, so its children inherit done and halt) and never calls done.
    const a = await rt.start({ agent: "builder-like", workspace: "none", input: { message: "just stop" } });
    assert.deepEqual(await rt.wait(a.id), { outcome: "done", data: { done: null, pi: a.resolved!.settings, output: "final answer: just stop" } });
    const b = await rt.start({ agent: "builder-like", workspace: "none", input: { message: "done now" } });
    assert.deepEqual(await rt.wait(b.id), { outcome: "done", data: { done: { ok: true }, pi: b.resolved!.settings, output: "final answer: done now" } });
  });

  it("an agent without the done tool is done when pi exits cleanly, with pi's final output", async () => {
    const rec = await rt.start({ agent: "reader", workspace: "none", input: { message: "report" } });
    const r = await rt.wait(rec.id);
    assert.equal(r.outcome, "done");
    assert.equal((r as { data: { output: string } }).data.output, "final answer: report");
    assert.equal(seen(rec.id).env.BUILDER_JOB_ID, undefined, "no dispatch, no job variables");
  });

  it("a run that inherits another run's job variables does not pass them on", async () => {
    process.env.BUILDER_JOB_ID = "leaked-from-a-parent";
    process.env.BUILDER_SLICE_TITLE = "Leaked";
    try {
      const rec = await rt.start({ agent: "reader", workspace: "none", input: { message: "x" } });
      await rt.wait(rec.id);
      assert.equal(seen(rec.id).env.BUILDER_JOB_ID, undefined);
      assert.equal(seen(rec.id).env.BUILDER_SLICE_TITLE, undefined);
    } finally {
      delete process.env.BUILDER_JOB_ID;
      delete process.env.BUILDER_SLICE_TITLE;
    }
  });
});
