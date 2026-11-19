/**
 * The process tools and the server as a run (design section 10, D13, E19). Never the real systemctl: PATH starts with
 * a folder holding a stand-in. Without the builder-server unit, server_start detaches `builder server run`; with it
 * (a stand-in systemctl that runs the unit's command in the background), the tools go through systemctl, and through
 * `sudo -n` when systemctl refuses. Restart and stop drain first: the running job finishes, or with force is cancelled
 * and the gaffer is told cancelled by operator. HOME is a temp dir, so this machine's ~/.gaffer never leaks in.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { serverEnv } from "../../ops/process.ts";
import { readFeed } from "../../runtime/feed.ts";
import { createRuntime, processAlive, readRecord, runProcessAlive } from "../../runtime/run.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { liveServerRuns, serverRuns } from "../../server/run.ts";
import { startBuilder, type RunningBuilder } from "../harness/builder.ts";
import { dispatch, newJobId, SLICE } from "../harness/dispatch.ts";
import { createFixtureRepo, type FixtureRepo } from "../harness/fixture-repo.ts";
import { startGaffer, type FakeGaffer } from "../harness/gaffer.ts";
import { scenario } from "../harness/scenario.ts";
import { freePort, GIT_ENV, http, tempDir, waitFor } from "../harness/util.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(BUILDER, "cli", "builder.ts");
const tmp = tempDir("builder-process");
const home = join(tmp.dir, "home");
const bin = join(tmp.dir, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });
const none = join(tmp.dir, "absent.yml");

// Everything this file starts (detached servers, the stand-in systemctl's unit) sees the same isolated environment.
Object.assign(process.env, GIT_ENV, { HOME: home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });
delete process.env.GAFFER_CONFIG;
delete process.env.GAFFER_INSTANCE;

/** The stand-in systemctl: without FAKE_SYSTEMD there is no builder-server unit on this machine. */
writeFileSync(
  join(bin, "systemctl"),
  `#!/bin/bash
# systemctl for tests: the builder-server unit runs "node <cli> server run --config <file>" in the background.
d="$FAKE_SYSTEMD"
if [ -z "$d" ]; then [ "$1" = show ] && { echo LoadState=not-found; echo ActiveState=inactive; echo MainPID=0; exit 0; }; echo "Unit builder-server.service not found." >&2; exit 5; fi
echo "$*" >> "$d/calls"
args=("$@"); [ "\${args[0]}" = "--no-ask-password" ] && args=("\${args[@]:1}")
verb="\${args[0]}"
if [ -n "$FAKE_NEEDS_SUDO" ] && [ -z "$SUDO_UID" ] && [ "$verb" != show ]; then echo "Interactive authentication required." >&2; exit 1; fi
pid=$(cat "$d/pid" 2>/dev/null || true)
alive() { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }
case "$verb" in
  show) echo LoadState=loaded; if alive; then echo ActiveState=active; echo "MainPID=$pid"; else echo ActiveState=inactive; echo MainPID=0; fi ;;
  start) alive && exit 0; nohup "${process.execPath}" "${CLI}" server run --config "$FAKE_CONFIG" < /dev/null >> "$d/journal" 2>&1 & echo $! > "$d/pid" ;;
  stop) if alive; then kill -TERM "$pid"; for i in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; fi; rm -f "$d/pid" ;;
  *) echo "fake systemctl: $verb" >&2; exit 1 ;;
esac
`,
);
writeFileSync(join(bin, "sudo"), `#!/bin/bash\n[ "$1" = -n ] && shift\necho "sudo $*" >> "$FAKE_SYSTEMD/calls"\nSUDO_UID=0 exec "$@"\n`);
chmodSync(join(bin, "systemctl"), 0o755);
chmodSync(join(bin, "sudo"), 0o755);

let n = 0;
/** A --config layer with its own runs directory and port, and a CLI context on it. */
async function machine(extra = ""): Promise<{ runsDir: string; file: string; port: number; ctx: ToolContext }> {
  const root = join(tmp.dir, `m-${++n}`);
  const runsDir = join(root, "runs");
  const port = await freePort();
  mkdirSync(root, { recursive: true });
  const file = join(root, "machine.yml");
  writeFileSync(file, `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)}, host: 127.0.0.1, port: ${port} }\n  pi: { command: /bin/false }\n  limit: { tools: { enable: ['*'] } }\n${extra}`);
  return { runsDir, file, port, ctx: operator(file) };
}

/** The operator's context on a --config layer (as `builder --config <file>` has). */
function operator(file: string): ToolContext {
  const config = { ...loadConfig({ packaged: none, userConfig: none, env: {}, configPath: file }), limit: { enable: ["*"], disable: [] } };
  return cliContext(config,createRuntime({ runsDir: config.server.runsDir, piCommand: "/bin/false", limit: config.limit }));
}

const call = async <T = any>(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<T> => (await callTool(name, args, ctx)) as T;
const health = async (port: number) => (await http("GET", `http://127.0.0.1:${port}/health`)).status;
/** Stop whatever server still runs on a runs directory (a test that failed half-way). */
async function cleanup(ctx: ToolContext): Promise<void> {
  try {
    await call("server_stop", { force: true, timeoutSeconds: 5 }, ctx);
  } catch {
    for (const r of liveServerRuns(ctx.runtime.options.runsDir)) if (r.pid) process.kill(r.pid, "SIGKILL");
  }
}

after(() => tmp.remove());

describe("the server as a run, without systemd", { concurrency: true }, () => {
  it("server_start detaches builder server run: a server run with its id on its command line; a second start finds it", { timeout: 60_000 }, async () => {
    const m = await machine();
    try {
      const s = await call("server_start", {}, m.ctx);
      assert.equal(s.via, "run");
      assert.equal(s.url, `http://127.0.0.1:${m.port}`);
      assert.equal(await health(m.port), 200);
      const rec = readRecord(m.runsDir, s.runId)!;
      assert.deepEqual([rec.kind, rec.state, rec.parent, rec.spec], ["server", "running", null, { detach: true }]);
      assert.equal(rec.pid, s.pid);
      assert.ok(runProcessAlive(rec), "alive, with the run id on its command line");
      assert.equal(s.log, join(m.runsDir, s.runId, "log"));
      assert.match(readFileSync(s.log, "utf8"), /build server listening on http:\/\/127\.0\.0\.1:\d+/);

      const again = await call("server_start", {}, m.ctx);
      assert.deepEqual([again.already, again.runId], [true, s.runId]);
      // Another server on the same runs directory refuses to start (the CLI's "refused"), and leaves no run behind.
      const second = spawnSync(process.execPath, [CLI, "server", "run", "--config", m.file], { encoding: "utf8", timeout: 30_000 });
      assert.equal(second.status, 3, second.stderr);
      assert.match(second.stderr, new RegExp(`a build server already runs on .*: run ${s.runId}`));
      assert.deepEqual(serverRuns(m.runsDir).map((r) => r.id), [s.runId]);

      const settings = await call("server_settings_get", {}, m.ctx);
      assert.equal(settings.server.port, m.port);
      assert.equal(settings.sources["server.port"], `--config ${m.file}`);
      assert.equal(settings.unit, null);

      const stopped = await call("server_stop", {}, m.ctx);
      assert.deepEqual([stopped.wasRunning, stopped.stopped, stopped.via], [true, [s.runId], "run"]);
      assert.deepEqual(stopped.drained, { answered: true }, "drained first, with no job running");
      const end = readRecord(m.runsDir, s.runId)!;
      assert.deepEqual([end.state, end.result], ["stopped", { outcome: "done", data: { signal: "SIGTERM" } }]);
      assert.ok(!runProcessAlive(end), "its process has ended");
      assert.deepEqual(await call("server_stop", {}, m.ctx), { stopped: [], wasRunning: false, via: "run" });
      const kinds = readFeed(m.runsDir, { kind: "server.*" }).map((e) => `${e.kind} ${String(e.data.state ?? "")}`.trim());
      assert.deepEqual(kinds, ["server.start", "server.state idle", "server.state draining", "server.stop"]);
    } finally {
      await cleanup(m.ctx);
    }
  });

  it("server_restart starts a server that is not running, else replaces it; the CLI's server start, restart and stop", { timeout: 60_000 }, async () => {
    const m = await machine();
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, "server", ...args, "--json", "--config", m.file], { encoding: "utf8", timeout: 60_000, env: serverEnv() });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as Record<string, any>;
    };
    try {
      const first = await call("server_restart", {}, m.ctx);
      assert.deepEqual([first.restarted, first.wasRunning, first.via], [false, false, "run"]);
      const second = cli("restart");
      assert.equal(second.restarted, true);
      assert.notEqual(second.runId, first.runId);
      assert.deepEqual(second.stopped, [first.runId]);
      assert.equal(readRecord(m.runsDir, first.runId)?.state, "stopped");
      assert.equal(await health(m.port), 200);
      assert.equal(cli("start").already, true);
      assert.deepEqual(cli("stop").stopped, [second.runId]);
      assert.equal(spawnSync(process.execPath, [CLI, "server", "frobnicate", "--config", m.file]).status, 2);
    } finally {
      await cleanup(m.ctx);
    }
  });

  it("a server run whose process vanished is marked failed by the next start; one that cannot listen fails with the reason", { timeout: 60_000 }, async () => {
    const m = await machine();
    try {
      const s = await call("server_start", {}, m.ctx);
      process.kill(s.pid, "SIGKILL");
      await waitFor("the server to be gone", () => (processAlive(s.pid) ? undefined : true), 10_000);
      assert.equal(readRecord(m.runsDir, s.runId)?.state, "running", "nothing recorded its end");
      const next = await call("server_start", {}, m.ctx);
      assert.notEqual(next.runId, s.runId);
      const gone = readRecord(m.runsDir, s.runId)!;
      assert.equal(gone.state, "failed");
      assert.match((gone.result as { reason: string }).reason, /ended without recording how/);
      // The port is taken (by the running server) for a server on another runs directory.
      const other = await machine();
      writeFileSync(other.file, readFileSync(other.file, "utf8").replace(`port: ${other.port}`, `port: ${m.port}`));
      const busy = await callTool("server_start", { timeoutSeconds: 20 }, operator(other.file)).catch((e: unknown) => e);
      assert.ok(isToolError(busy) && busy.code === "failed", String(busy));
      assert.match(busy.message, /failed: the server could not listen: listen EADDRINUSE/);
      assert.equal(liveServerRuns(other.runsDir).length, 0);
    } finally {
      await cleanup(m.ctx);
    }
  });

  it("serverEnv drops the BUILDER_* variables of the run that starts a server", () => {
    assert.deepEqual(serverEnv({ PATH: "/bin", BUILDER_RUN_DIR: "/x", BUILDER_JOB_ID: "j", GAFFER_CONFIG: "/c.yml" }), { PATH: "/bin", GAFFER_CONFIG: "/c.yml" });
  });
});

describe("with the builder-server unit (a stand-in systemctl)", () => {
  it("server_start, server_restart and server_stop go through systemctl, and through sudo -n when systemctl refuses", { timeout: 90_000 }, async () => {
    const m = await machine();
    const unit = join(tmp.dir, "systemd");
    mkdirSync(unit, { recursive: true });
    Object.assign(process.env, { FAKE_SYSTEMD: unit, FAKE_CONFIG: m.file });
    const calls = () => (existsSync(join(unit, "calls")) ? readFileSync(join(unit, "calls"), "utf8").trim().split("\n") : []);
    try {
      const s = await call("server_start", {}, m.ctx);
      assert.equal(s.via, "systemd");
      assert.equal(s.pid, Number(readFileSync(join(unit, "pid"), "utf8")), "the unit's MainPID is the server run's pid: the id was put on its command line in place");
      const rec = readRecord(m.runsDir, s.runId)!;
      assert.deepEqual([rec.kind, rec.state, rec.spec], ["server", "running", {}]);
      assert.ok(runProcessAlive(rec));
      assert.ok(calls().includes("--no-ask-password start builder-server.service"), calls().join("\n"));
      assert.equal((await call("server_start", {}, m.ctx)).already, true);
      assert.equal((await call("server_settings_get", {}, m.ctx)).unit, "builder-server.service");

      const r = await call("server_restart", {}, m.ctx);
      assert.deepEqual([r.restarted, r.via, r.stopped], [true, "systemd", [s.runId]]);
      assert.notEqual(r.runId, s.runId);
      assert.equal(readRecord(m.runsDir, s.runId)?.state, "stopped");

      process.env.FAKE_NEEDS_SUDO = "1";
      const stopped = await call("server_stop", {}, m.ctx);
      assert.deepEqual([stopped.via, stopped.stopped], ["systemd", [r.runId]]);
      assert.ok(calls().includes("sudo systemctl stop builder-server.service"), calls().join("\n"));
      assert.equal(liveServerRuns(m.runsDir).length, 0);
    } finally {
      delete process.env.FAKE_NEEDS_SUDO;
      await cleanup(m.ctx);
      spawnSync(join(bin, "systemctl"), ["stop", "builder-server.service"]);
      delete process.env.FAKE_SYSTEMD;
      delete process.env.FAKE_CONFIG;
    }
  });
});

describe("E19: stop and restart drain first", { concurrency: true }, () => {
  const SLICE_DIR = `src/slices/${SLICE.contextName}/${SLICE.title}`;
  let repo: FixtureRepo;
  let gaffer: FakeGaffer;
  before(async () => {
    repo = createFixtureRepo(tmp.dir);
    gaffer = await startGaffer();
  });
  after(async () => {
    await gaffer?.stop();
  });

  /** A build server (the contract harness's) and the operator's context on its config. */
  async function withBuilder(test: (b: RunningBuilder, ctx: ToolContext) => Promise<void>): Promise<void> {
    const b = await startBuilder();
    const ctx = operator(b.configFile);
    try {
      await test(b, ctx);
    } catch (err) {
      if (err instanceof Error) err.message += `\n--- builder output ---\n${b.output()}`;
      throw err;
    } finally {
      await cleanup(ctx);
      await b.stop();
    }
  }
  const serverRun = (b: RunningBuilder): RunRecord => liveServerRuns(b.runsDir)[0];

  it("restart: the running job finishes and is called back, then the server restarts", { timeout: 120_000 }, async () => {
    await withBuilder(async (b, ctx) => {
      const before = serverRun(b);
      assert.ok(before, "the harness's server is a server run");
      const j = newJobId();
      b.setScenario(j, scenario({ op: "sleep", ms: 2500 }, { op: "write", path: `${SLICE_DIR}/a.ts`, content: "export const a = 1;\n" }, { op: "done" }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, j))).status, 202);
      await waitFor("the agent to start", () => (b.stubRecord(j) ? true : undefined), 30_000);
      const r = await call("server_restart", {}, ctx);
      assert.deepEqual([r.restarted, r.drained], [true, { answered: true, jobId: j }]);
      assert.equal(gaffer.calls(j).length, 1, "the callback was made before the restart");
      assert.equal(((await gaffer.result(j, 1000)) as { outcome: string }).outcome, "done");
      assert.notEqual(r.runId, before.id);
      assert.equal(readRecord(b.runsDir, before.id)?.state, "stopped");
      assert.equal((await http("GET", `${b.url}/health`)).status, 200);
      const states = readFeed(b.runsDir, { kind: "server.state" }).map((e) => `${String(e.data.state)}${e.data.jobId ? " job" : ""}`);
      assert.ok(states.indexOf("draining job") < states.lastIndexOf("draining"), states.join(", "));
    });
  });

  it("restart with force: the job is cancelled and called back with cancelled by operator first", { timeout: 120_000 }, async () => {
    await withBuilder(async (b, ctx) => {
      const j = newJobId();
      b.setScenario(j, scenario({ op: "sleep", ms: 120_000 }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, j))).status, 202);
      await waitFor("the agent to start", () => (b.stubRecord(j) ? true : undefined), 30_000);
      const t0 = Date.now();
      const r = await call("server_restart", { force: true }, ctx);
      assert.deepEqual(r.drained, { answered: true, jobId: j, cancelled: true });
      assert.ok(Date.now() - t0 < 60_000);
      assert.deepEqual(gaffer.calls(j).map((c) => c.body), [{ outcome: "failed", reason: "cancelled by operator" }]);
      assert.equal((await http("GET", `${b.url}/health`)).status, 200);
    });
  });

  it("stop: a job that does not finish in time is left running and the server resumed", { timeout: 120_000 }, async () => {
    await withBuilder(async (b, ctx) => {
      const j = newJobId();
      b.setScenario(j, scenario({ op: "sleep", ms: 120_000 }));
      assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, j))).status, 202);
      await waitFor("the agent to start", () => (b.stubRecord(j) ? true : undefined), 30_000);
      const err = await callTool("server_stop", { timeoutSeconds: 1 }, ctx).catch((e: unknown) => e);
      assert.ok(isToolError(err));
      assert.match(err.message, new RegExp(`^job ${j} did not finish within 1 s, so the build server was resumed and not stopped`));
      assert.ok(serverRun(b), "still running");
      const applied = readFeed(b.runsDir, { kind: "control.applied" }).map((e) => e.data.action);
      assert.deepEqual(applied, ["drain", "resume"]);
      assert.equal(gaffer.calls(j).length, 0, "the job is still running");
      await call("control_send", { action: "cancel", jobId: j, waitSeconds: 20 }, ctx);
    });
  });
});
