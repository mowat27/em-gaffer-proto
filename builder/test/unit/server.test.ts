/**
 * The server's side of a job: the workflow result as the contract's callback body (toContract), recovery after a
 * restart (E13) and a builder definition that does not load (E2).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { orphanedJobRuns, toContract } from "../../server/job.ts";
import { validate } from "../../server/validate.ts";
import { createRuntime } from "../../runtime/run.ts";
import { isFinal, type RunRecord } from "../../runtime/types.ts";
import { dispatch, newJobId } from "../harness/dispatch.ts";
import { serverCommand } from "../harness/builder.ts";
import { createFixtureRepo, FIXTURE_SETUP_COMMANDS, type FixtureRepo } from "../harness/fixture-repo.ts";
import { startGaffer, type FakeGaffer } from "../harness/gaffer.ts";
import { freePort, GIT_ENV, http, sleep, tempDir, waitFor } from "../harness/util.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUB = join(BUILDER, "test", "harness", "pi-stub.ts");

describe("toContract", () => {
  it("done: the app repository's patch is the contract's patch", () => {
    assert.deepEqual(toContract({ outcome: "done", patches: { app: "From abc\n" } }), { outcome: "done", patch: "From abc\n" });
  });
  it("done without an app patch fails, naming why", () => {
    assert.deepEqual(toContract({ outcome: "done", patches: { ui: "From abc\n" } }), { outcome: "failed", reason: "the workflow produced no patch for the app repository" });
    assert.deepEqual(toContract({ outcome: "done" }), { outcome: "failed", reason: "the workflow produced no patch for the app repository" });
  });
  it("failed: the reason verbatim, and nothing else", () => {
    assert.deepEqual(toContract({ outcome: "failed", reason: "Halted. Question: which fields?", halted: true }), { outcome: "failed", reason: "Halted. Question: which fields?" });
  });
});

describe("validate", () => {
  const body = { requires: [], repo: { url: "/r", base: "abc1234" }, task: { sliceId: "s", title: "T", context: "C" }, slice: { title: "T" }, callback: "http://x/jobs/j" };
  it("passes the contract's changes and sourceEvents through to the workflow, and leaves them out when absent or malformed", () => {
    const changes = { verdict: "CHANGED", since: { commit: "abc", recordedAt: "2026-11-16T12:00:00.000Z" } };
    const sourceEvents = [{ owner: { title: "CreateClient" }, event: { title: "ClientCreated" } }];
    const ok = validate({ ...body, changes, sourceEvents });
    assert.ok(ok.ok);
    assert.deepEqual([ok.d.changes, ok.d.sourceEvents], [changes, sourceEvents]);
    const bare = validate({ ...body, changes: "NEW", sourceEvents: {} });
    assert.ok(bare.ok);
    assert.deepEqual(Object.keys(bare.d), ["requires", "repo", "task", "slice", "callback"]);
  });
});

describe("orphanedJobRuns", () => {
  const rec = (over: Partial<RunRecord>): RunRecord => ({ id: "r", parent: null, kind: "workflow", spec: {}, state: "running", pid: null, startedAt: "2026-11-17T00:00:00.000Z", ...over });
  it("picks job runs whose callback is not made and whose server is gone", () => {
    const deadPid = 2 ** 22 + 12345; // above any pid the OS hands out
    const runs = [
      rec({ id: "orphan", job: { jobId: "a", callback: "http://x/jobs/a", server: deadPid } }),
      rec({ id: "no-server-recorded", job: { jobId: "b", callback: "http://x/jobs/b" } }),
      rec({ id: "earlier-server-same-pid", job: { jobId: "c", callback: "http://x/jobs/c", server: 4242 } }),
      rec({ id: "called-back", job: { jobId: "d", callback: "http://x/jobs/d", server: deadPid, callbackDone: true } }),
      rec({ id: "live-server", job: { jobId: "e", callback: "http://x/jobs/e", server: process.pid } }),
      rec({ id: "not-a-job" }),
      rec({ id: "agent", kind: "agent", job: { jobId: "f", callback: "http://x/jobs/f", server: deadPid } }),
    ];
    assert.deepEqual(orphanedJobRuns(runs, 4242).map((r) => r.id), ["orphan", "no-server-recorded", "earlier-server-same-pid"]);
  });
});

/** The machine config layer for `server` settings and the pi command (JSON is YAML). */
const configLayer = (server: Record<string, unknown>, piCommand: string) => JSON.stringify({ builder: { server, pi: { command: piCommand } } }, null, 2);

/** A build server on its own port, with the server settings in `config` (a $GAFFER_CONFIG layer in `dir`). */
async function spawnServer(dir: string, config: Record<string, unknown> & { piCommand: string }): Promise<{ url: string; child: ChildProcess; output(): string; kill(sig: NodeJS.Signals): Promise<void> }> {
  const port = await freePort();
  const configFile = join(dir, "builder-config.yml");
  const { piCommand, ...server } = config;
  writeFileSync(configFile, configLayer({ host: "127.0.0.1", port, ...server }, piCommand));
  let out = "";
  const child = spawn(process.execPath, serverCommand(BUILDER), { cwd: dir, env: { ...process.env, ...GIT_ENV, GAFFER_CONFIG: configFile, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const url = `http://127.0.0.1:${port}`;
  await waitFor(
    "the builder to answer /health",
    async () => {
      if (child.exitCode !== null) throw new Error(`builder exited ${child.exitCode}:\n${out}`);
      try {
        return (await http("GET", `${url}/health`)).status === 200 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    15_000,
  );
  return {
    url,
    child,
    output: () => out,
    kill: async (sig) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill(sig);
      await exited;
    },
  };
}

describe("server recovery and definitions", { concurrency: true }, () => {
  let tmp: ReturnType<typeof tempDir>;
  let repo: FixtureRepo;
  let gaffer: FakeGaffer;
  before(async () => {
    tmp = tempDir("builder-server-unit");
    repo = createFixtureRepo(tmp.dir);
    gaffer = await startGaffer();
  });
  after(async () => {
    await gaffer?.stop();
    await sleep(500);
    tmp?.remove();
  });

  it("E13: a job run left running by a server that died gets one failed callback naming the step", { timeout: 90_000 }, async () => {
    const dir = join(tmp.dir, "e13");
    const stubDir = join(dir, "pi-stub");
    for (const d of [join(stubDir, "scenarios"), join(stubDir, "records")]) mkdirSync(d, { recursive: true });
    const launcher = join(dir, "pi");
    writeFileSync(launcher, `#!/bin/sh\nPI_STUB_DIR='${stubDir}' exec '${process.execPath}' '${STUB}' "$@"\n`);
    chmodSync(launcher, 0o755);
    const builderModule = join(dir, "test-builder.mts");
    const real = pathToFileURL(join(BUILDER, "agentics", "builders", "supabase-api", "builder.ts")).href;
    writeFileSync(builderModule, `import { supabaseApi } from ${JSON.stringify(real)};\nexport default supabaseApi(${JSON.stringify({ provides: ["stack:stub"], setup: FIXTURE_SETUP_COMMANDS, setupTimeoutMinutes: 1 })});\n`);
    const runsDir = join(dir, "runs");
    const config = { runsDir, builder: builderModule, piCommand: launcher, callbackRetries: 2 };

    const first = await spawnServer(dir, config);
    let second: Awaited<ReturnType<typeof spawnServer>> | null = null;
    let third: Awaited<ReturnType<typeof spawnServer>> | null = null;
    try {
      const jobId = newJobId();
      writeFileSync(join(stubDir, "scenarios", `${jobId}.json`), JSON.stringify({ steps: [{ op: "sleep", ms: 120_000 }] }));
      const res = await http("POST", `${first.url}/slices`, dispatch(repo, gaffer, jobId));
      assert.equal(res.status, 202, res.text);
      await waitFor("the agent to start", () => (existsSync(join(stubDir, "records", `${jobId}.json`)) ? true : undefined), 30_000);
      const rt = createRuntime({ runsDir, piCommand: launcher });
      const jobRun = () => rt.list().find((r) => r.job?.jobId === jobId);
      assert.equal(jobRun()?.step, "implement");

      await first.kill("SIGKILL");
      const left = await waitFor("the job run to stop with its parent", () => (jobRun() && isFinal(jobRun()!.state) ? jobRun() : undefined), 15_000);
      assert.equal(left.state, "stopped");
      assert.equal(gaffer.calls(jobId).length, 0);

      second = await spawnServer(dir, config);
      assert.deepEqual(await gaffer.result(jobId, 20_000), { outcome: "failed", reason: "builder restarted during implement" });
      await waitFor("the callback to be marked done", () => (jobRun()?.job?.callbackDone ? true : undefined), 5000);
      await second.kill("SIGTERM");

      // Once is enough: the next start finds nothing to recover.
      third = await spawnServer(dir, config);
      await sleep(1500);
      assert.equal(gaffer.calls(jobId).length, 1);
    } catch (err) {
      if (err instanceof Error) err.message += `\n--- first ---\n${first.output()}\n--- second ---\n${second?.output() ?? ""}`;
      throw err;
    } finally {
      await first.kill("SIGKILL");
      await second?.kill("SIGTERM");
      await third?.kill("SIGTERM");
    }
  });

  it("E2: a builder definition that does not load: the job is accepted and fails with builder definition invalid", { timeout: 60_000 }, async () => {
    const dir = join(tmp.dir, "e2");
    mkdirSync(dir, { recursive: true });
    const invalid = join(dir, "invalid-builder.mts");
    writeFileSync(invalid, `export default { name: "broken", steps: [] };\n`);
    const throwing = join(dir, "throwing-builder.mts");
    writeFileSync(throwing, `throw new Error("boom at load");\n`);
    const config = { runsDir: join(dir, "runs"), builder: invalid, piCommand: "/bin/false" };
    const server = await spawnServer(dir, config);
    try {
      const a = newJobId();
      assert.equal((await http("POST", `${server.url}/slices`, dispatch(repo, gaffer, a))).status, 202);
      assert.deepEqual(await gaffer.result(a, 20_000), { outcome: "failed", reason: "builder definition invalid: provides must be a string array" });

      // The config is re-read for every job.
      const { piCommand, ...settings } = config;
      writeFileSync(join(dir, "builder-config.yml"), configLayer({ host: "127.0.0.1", port: Number(new URL(server.url).port), ...settings, builder: throwing }, piCommand));
      const b = newJobId();
      const accepted = await waitFor(
        "the builder to accept the next job",
        async () => {
          const res = await http("POST", `${server.url}/slices`, dispatch(repo, gaffer, b));
          return res.status === 503 ? undefined : res;
        },
        10_000,
        200,
      );
      assert.equal(accepted.status, 202, accepted.text);
      assert.deepEqual(await gaffer.result(b, 20_000), { outcome: "failed", reason: "builder definition invalid: boom at load" });
    } catch (err) {
      if (err instanceof Error) err.message += `\n--- builder output ---\n${server.output()}`;
      throw err;
    } finally {
      await server.kill("SIGTERM");
    }
  });
});
