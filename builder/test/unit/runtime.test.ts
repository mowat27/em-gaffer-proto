/**
 * The runtime: a run's life in runs/<id>/run.json (starting, running with its pid and step, then done, failed or
 * stopped with its result), stopping a run, and a child run stopping when its parent dies.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntime, processAlive } from "../../runtime/run.ts";
import { isFinal, type RunRecord } from "../../runtime/types.ts";
import { tempDir, waitFor } from "../harness/util.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = JSON.stringify(pathToFileURL(join(BUILDER, "engine", "workflow.ts")).href);

const tmp = tempDir("builder-runtime");
after(() => tmp.remove());
const runsDir = join(tmp.dir, "runs");

const dispatch = {
  requires: [],
  repo: { url: "/nowhere", base: "abc1234" },
  task: { sliceId: "s1", title: "CreateThing", context: "Billing", handover: false, attempt: 1 },
  slice: null,
  callback: "http://127.0.0.1:9/jobs/job-runtime-1",
};

/** A builder module in the temp dir; `steps` is JavaScript using code() and agent(). */
function builderModule(name: string, steps: string): string {
  const file = join(tmp.dir, `${name}.mts`);
  writeFileSync(
    file,
    `import { agent, code, defineBuilder } from ${WORKFLOW};\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nexport default defineBuilder({ name: ${JSON.stringify(name)}, provides: [], steps: [${steps}] });\n`,
  );
  return file;
}

const onDisk = (id: string) => JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8")) as RunRecord;

describe("runtime", { concurrency: true }, () => {
  it("run.json lifecycle: starting, running with the process's pid and the current step, then done with the result", async () => {
    const rt = createRuntime({ runsDir, piCommand: "/bin/false" });
    const mod = builderModule("lifecycle", `code("first", async () => { await sleep(800); return { n: 1 }; }), code("second", async (ctx) => ({ got: ctx.get("first").n }))`);
    const rec = await rt.start({ workflow: mod, input: { dispatch } });
    assert.equal(rec.kind, "workflow");
    assert.equal(rec.state, "starting");
    assert.equal(rec.parent, null);
    assert.equal(typeof rec.pid, "number");
    assert.ok(["starting", "running"].includes(onDisk(rec.id).state));

    const running = await waitFor("the run to be running a step", () => (onDisk(rec.id).state === "running" && onDisk(rec.id).step ? onDisk(rec.id) : undefined), 10_000, 50);
    assert.equal(running.pid, rec.pid);
    assert.equal(running.step, "first");

    assert.deepEqual(await rt.wait(rec.id), { outcome: "done" });
    const final = onDisk(rec.id);
    assert.equal(final.state, "done");
    assert.deepEqual(final.result, { outcome: "done" });
    assert.equal(final.step, "second");
    assert.ok(final.endedAt && Date.parse(final.endedAt) >= Date.parse(final.startedAt));
    assert.deepEqual(JSON.parse(readFileSync(join(runsDir, rec.id, "context", "outputs", "second.json"), "utf8")), { got: 1 });
    const job = JSON.parse(readFileSync(join(runsDir, rec.id, "context", "job.json"), "utf8"));
    assert.equal(job.jobId, "job-runtime-1");
    assert.equal(job.runId, rec.id);
    assert.match(readFileSync(join(runsDir, rec.id, "log"), "utf8"), /^job [a-z]+-[a-z]+ \(job-runtime-1\): Billing\/CreateThing attempt 1, base abc1234\n/);
    assert.ok(existsSync(join(runsDir, rec.id, "workspace")));
    assert.ok(rt.list().some((r) => r.id === rec.id));
    await waitFor("the run process to exit", () => (processAlive(rec.pid!) ? undefined : true), 5000);
  });

  it("a failing step ends the run failed with the step's reason", async () => {
    const rt = createRuntime({ runsDir, piCommand: "/bin/false" });
    const mod = builderModule("failing", `code("boom", async () => { throw new Error("the agent produced no changes"); }), code("never", async () => ({}))`);
    const rec = await rt.start({ workflow: mod, input: { dispatch } });
    assert.deepEqual(await rt.wait(rec.id), { outcome: "failed", reason: "the agent produced no changes" });
    assert.equal(onDisk(rec.id).state, "failed");
    assert.equal(existsSync(join(runsDir, rec.id, "context", "outputs", "never.json")), false);
  });

  it("E2 at the run: a builder that does not load fails the run with builder definition invalid", async () => {
    const rt = createRuntime({ runsDir, piCommand: "/bin/false" });
    const missing = join(tmp.dir, "missing-builder.ts");
    const rec = await rt.start({ workflow: missing, input: { dispatch } });
    assert.deepEqual(await rt.wait(rec.id), { outcome: "failed", reason: `builder definition invalid: no builder module at ${missing}` });
  });

  it("stop: the run ends stopped with the reason, and its process is gone", async () => {
    const rt = createRuntime({ runsDir, piCommand: "/bin/false" });
    const mod = builderModule("long", `code("long", async (ctx) => { await sleep(60_000); return {}; })`);
    const rec = await rt.start({ workflow: mod, input: { dispatch } });
    await waitFor("the run to be running", () => (onDisk(rec.id).state === "running" ? true : undefined), 10_000, 50);
    const t0 = Date.now();
    await rt.stop(rec.id, "cancelled by test");
    assert.ok(Date.now() - t0 < 6000, "stop took longer than its 5 s");
    const final = onDisk(rec.id);
    assert.equal(final.state, "stopped");
    assert.deepEqual(final.result, { outcome: "failed", reason: "cancelled by test" });
    await waitFor("the run process to exit", () => (processAlive(rec.pid!) ? undefined : true), 5000);
  });

  it("a child run stops when its parent dies: the agent run ends stopped and its pi process is killed", async () => {
    const piPidFile = join(tmp.dir, "fake-pi.pid");
    const fakePi = join(tmp.dir, "fake-pi");
    writeFileSync(fakePi, `#!/bin/sh\necho $$ > '${piPidFile}'\nexec sleep 300\n`);
    chmodSync(fakePi, 0o755);
    // A one-agent tree of its own: agents/worker/agent.yml.
    const agentics = join(tmp.dir, "agentics");
    mkdirSync(join(agentics, "agents", "worker"), { recursive: true });
    writeFileSync(join(agentics, "agents", "worker", "agent.yml"), "description: works until stopped\nmode: headless\n");
    const rt = createRuntime({ runsDir, piCommand: fakePi, agenticsDir: agentics });
    const mod = builderModule("parent-dies", `agent("work", { agent: "worker", prompt: "go", budgetMinutes: 5 })`);
    const wf = await rt.start({ workflow: mod, input: { dispatch } });
    const child = await waitFor("the agent run", () => rt.list().find((r) => r.parent === wf.id && r.state === "running"), 10_000, 50);
    assert.equal(child.kind, "agent");
    assert.deepEqual(child.spec.workspace, { dir: { path: join(runsDir, wf.id, "workspace") } });
    const piPid = await waitFor("pi to start", () => (existsSync(piPidFile) && readFileSync(piPidFile, "utf8").trim() ? Number(readFileSync(piPidFile, "utf8")) : undefined), 10_000, 50);
    assert.ok(processAlive(piPid));

    process.kill(onDisk(wf.id).pid!, "SIGKILL");

    const stopped = await waitFor("the agent run to end", () => (isFinal(onDisk(child.id).state) ? onDisk(child.id) : undefined), 10_000, 100);
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(stopped.result, { outcome: "failed", reason: "parent ended" });
    await waitFor("pi to be killed", () => (processAlive(piPid) ? undefined : true), 6000);
    // The killed parent wrote no result: waiting on it notes how it ended.
    const r = await rt.wait(wf.id);
    assert.equal(r.outcome, "failed");
    assert.match((r as { reason: string }).reason, /ended without a result \(signal SIGKILL\)$/);
  });

  it("a run spec names exactly one of workflow and agent, a workflow run is headless, and an unknown agent starts nothing", async () => {
    const rt = createRuntime({ runsDir, piCommand: "/bin/false" });
    await assert.rejects(rt.start({}), /exactly one of workflow and agent/);
    await assert.rejects(rt.start({ workflow: "x", agent: "y" }), /exactly one of workflow and agent/);
    await assert.rejects(rt.start({ workflow: "x", mode: "rpc" }), /a workflow run is headless/);
    await assert.rejects(rt.start({ workflow: "x", steps: { implement: { mode: "interactive" } } }), /runs headless or rpc/);
    const before = rt.list().length;
    await assert.rejects(rt.start({ agent: "no-such-agent" }), /no agent no-such-agent/);
    assert.equal(rt.list().length, before);
  });
});
