/**
 * The builder CLI, spawned as an operator runs it (`node cli/builder.ts ...`), mostly with --json: every command is a
 * tool call with the machine limit as what it may call, its exit codes, and `events -f` following the feed. HOME is a
 * temp dir and the config a --config layer, so nothing on this machine leaks in.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFeed } from "../../runtime/feed.ts";
import { createRuntime } from "../../runtime/run.ts";
import { GIT_ENV, tempDir, waitFor } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(BUILDER, "cli", "builder.ts");
const tmp = tempDir("builder-cli");
after(() => tmp.remove());
const home = join(tmp.dir, "home");
mkdirSync(home, { recursive: true });
const runsDir = join(tmp.dir, "runs");
const pi = fakePi(tmp.dir, "pi", `console.log("pi said " + process.argv[process.argv.length - 1]);\n`);
const layer = (limit = "['*']") => `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)}, port: 9876 }\n  pi: { command: ${JSON.stringify(pi)} }\n  limit: { tools: { enable: ${limit} } }\n`;
const configFile = join(tmp.dir, "machine.yml");
writeFileSync(configFile, layer());
const env = { ...process.env, ...GIT_ENV, HOME: home, NO_COLOR: "1", GAFFER_CONFIG: "", GAFFER_INSTANCE: "" };
delete (env as Record<string, string | undefined>).GAFFER_CONFIG;
delete (env as Record<string, string | undefined>).GAFFER_INSTANCE;

/** Run the CLI with --config; returns the exit code, stdout and stderr. */
function cli(args: string[], o: { config?: string } = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, "--config", o.config ?? configFile], { env, encoding: "utf8", timeout: 60_000, cwd: tmp.dir });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const json = <T = any>(r: { stdout: string; stderr: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
};
const lines = (s: string) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

const WORKFLOW = JSON.stringify(pathToFileURL(join(BUILDER, "engine", "workflow.ts")).href);
function builder(name: string, steps: string): string {
  const file = join(tmp.dir, `${name}.mts`);
  writeFileSync(file, `import { code, defineBuilder } from ${WORKFLOW};\nexport default defineBuilder({ name: ${JSON.stringify(name)}, provides: [], steps: [${steps}] });\n`);
  return file;
}
const dispatchFile = join(tmp.dir, "dispatch.json");
writeFileSync(dispatchFile, JSON.stringify({ requires: [], repo: { url: "/nowhere", base: "abc1234" }, task: { sliceId: "s1", title: "CreateThing", context: "Billing", handover: false, attempt: 1 }, slice: null, callback: "http://127.0.0.1:9/jobs/cli-job-1" }));

describe("the builder CLI", () => {
  let runId = "";

  it("run: a workflow run started and waited for through run_start and run_wait; 0 when done, 1 when it fails", () => {
    const ok = cli(["run", builder("cli-ok", `code("one", async () => ({ n: 1 }))`), "--dispatch", dispatchFile, "--json"]);
    assert.equal(ok.code, 0, ok.stderr);
    const r = json<{ runId: string; dir: string; result: { outcome: string } }>(ok);
    assert.equal(r.result.outcome, "done");
    assert.equal(r.dir, join(runsDir, r.runId));
    runId = r.runId;
    const bad = cli(["run", builder("cli-bad", `code("one", async () => { throw new Error("nope"); })`), "--dispatch", dispatchFile]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /\[builder\] run \S+ failed: nope/);
    const agent = cli(["run", "supabase-api", "--workspace", "none", "--dispatch", dispatchFile, "--message", "hi", "--json"]);
    assert.equal(agent.code, 1, "on a dispatch supabase-api must call done: the stand-in pi never calls it");
    assert.equal(json(agent).result.reason, "the agent finished without calling done");
    const plain = cli(["run", "supabase-api", "--workspace", "none", "--message", "hi", "--json"]);
    assert.equal(plain.code, 0, "without a dispatch the run is done when pi exits cleanly, done tool or not");
    assert.equal(cli(["run", "no-such-builder-or-agent", "--dispatch", dispatchFile]).code, 1, "a builder that does not load fails its run");
    assert.equal(cli(["run"]).code, 2);
  });

  it("runs, logs and events read what the run left: run_list, journal_tail and the machine feed", () => {
    const runs = json<{ runs: { id: string; state: string; target: string }[] }>(cli(["runs", "--json", "--kind", "workflow"]));
    assert.ok(runs.runs.some((x) => x.id === runId && x.state === "done"));
    const human = cli(["runs"]);
    assert.match(human.stdout, new RegExp(`${runId}\\s+workflow:.*cli-ok.mts\\s+done`));

    const tail = json<{ runId: string; journal: boolean; events: { kind: string }[] }>(cli(["logs", runId, "--json", "--limit", "50"]));
    assert.equal(tail.runId, runId);
    assert.equal(tail.journal, true);
    assert.deepEqual(tail.events.map((e) => e.kind).filter((k) => k.startsWith("step.")), ["step.start", "step.end"]);
    const followed = cli(["logs", runId, "-f"]);
    assert.equal(followed.code, 0, "following an ended run stops by itself");
    assert.match(followed.stdout, /step\.end ok \d+ms/);

    const feed = lines(cli(["events", "--json", "--run", runId]).stdout);
    assert.deepEqual(feed.map((e) => e.kind), ["run.start", "step.start", "step.end", "run.end"]);
    assert.ok(feed.every((e) => typeof e.seq === "number"));
    const since = lines(cli(["events", "--json", "--since", String(feed[1].seq), "--run", runId]).stdout);
    assert.deepEqual(since.map((e) => e.kind), ["step.end", "run.end"]);
    assert.match(cli(["events", "--kind", "run.*"]).stdout, new RegExp(`#\\d+ \\d\\d:\\d\\d:\\d\\d ${runId} run.start workflow`));
    assert.equal(cli(["events", "--since", "yesterday"]).code, 2);
  });

  it("events -f replays and then follows the feed until interrupted", async () => {
    const child = spawn(process.execPath, [CLI, "events", "-f", "--json", "--kind", "server.*", "--config", configFile], { env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    try {
      appendFeed(runsDir, { kind: "server.start", data: { pid: 1 } });
      await waitFor("the replayed event", () => (out.includes('"server.start"') ? true : undefined), 10_000, 50);
      appendFeed(runsDir, { kind: "server.state", data: { state: "draining" } });
      await waitFor("the followed event", () => (out.includes('"draining"') ? true : undefined), 10_000, 50);
    } finally {
      child.kill("SIGINT");
    }
    const code = await new Promise<number | null>((r) => child.on("close", r));
    assert.equal(code, 0);
    assert.deepEqual(lines(out).map((e) => e.kind), ["server.start", "server.state"]);
  });

  it("tool and tools: any tool by name with JSON arguments; exit codes for unknown, invalid, refused and not available", () => {
    const listed = json<{ name: string; group: string; available: boolean; allowed: boolean }[]>(cli(["tools", "--json"]));
    assert.ok(listed.some((t) => t.name === "run_list" && t.group === "runs" && t.available && t.allowed));
    assert.ok(listed.some((t) => t.name === "notify_operator" && t.group === "notify" && t.available));
    assert.match(cli(["tools", "--group", "operate"]).stdout, /control_send\s+operate/);

    const got = cli(["tool", "run_get", JSON.stringify({ run: runId }), "--json"]);
    assert.equal(got.code, 0, got.stderr);
    assert.equal(json(got).id, runId);
    const unknown = cli(["tool", "no_such_tool", "--json"]);
    assert.deepEqual([unknown.code, json(unknown).error.code], [2, "unknown"]);
    const invalid = cli(["tool", "run_list", '{"colour":"red"}', "--json"]);
    assert.deepEqual([invalid.code, json(invalid).error.code], [2, "invalid"]);
    assert.equal(cli(["tool", "run_list", "{not json"]).code, 2);
    const noTarget = cli(["tool", "run_send", "{}", "--json"]);
    assert.deepEqual([noTarget.code, json(noTarget).error.code], [2, "invalid"]);

    const narrow = join(tmp.dir, "observe-only.yml");
    writeFileSync(narrow, layer("[observe]"));
    const refused = cli(["tool", "run_list", "{}", "--json"], { config: narrow });
    assert.deepEqual([refused.code, json(refused).error], [3, { code: "refused", message: "run_list is not allowed for the CLI (the machine limit)" }]);
    assert.deepEqual(json<{ name: string }[]>(cli(["tools", "--json"], { config: narrow })).map((t) => t.name).slice(0, 2), ["instance_get", "job_get"]);
  });

  it("config, config reload and resolve: instance_get, config_reload (a broken layer exits 1) and config_resolve", () => {
    const c = json<{ layers: string[]; sources: Record<string, string>; config: { server: { port: number } } }>(cli(["config", "--json"]));
    assert.deepEqual(c.layers.slice(-1), [`--config ${configFile}`]);
    assert.equal(c.sources["server.port"], `--config ${configFile}`);
    assert.equal(c.config.server.port, 9876);
    assert.match(cli(["config"]).stdout, /layers \(lowest first\)[\s\S]*server\.port\s+9876\s+\(--config /);
    const reloaded = cli(["config", "reload", "--json"]);
    assert.equal(reloaded.code, 0, reloaded.stderr);
    assert.equal(json(reloaded).loaded, true);
    // A broken layer: the CLI refuses to start (E22), so a reload of it changes nothing and exits 1 naming the layer
    // and the key (the reload of a layer broken after a run started is in operate.test.ts).
    const broken = join(tmp.dir, "broken.yml");
    writeFileSync(broken, "builder:\n  server: { prot: 1 }\n");
    const refused = cli(["config", "reload", "--json"], { config: broken });
    assert.equal(refused.code, 1);
    assert.match(json(refused).error.message, /^config --config .*broken\.yml: unknown key builder\.server\.prot$/);

    const r = json<{ agent: { id: string }; tools: string[]; env: Record<string, string> }>(cli(["resolve", "supabase-api", "--message", "x", "--json"]));
    assert.equal(r.agent.id, "supabase-api");
    assert.ok(r.tools.includes("context_get"));
    assert.match(cli(["resolve", "supabase-api", "--message", "x"]).stdout, /^agent\s+supabase-api/m);
  });

  it("attach: follows an rpc run over its control socket and sends it what is typed", async () => {
    // pi speaking rpc: a prompt is echoed as an event; "finish" calls done and settles.
    const rpcPi = fakePi(
      tmp.dir,
      "rpc-pi",
      `import { writeFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const c = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    out({ id: c.id, type: "response", command: c.type, success: true });
    if (c.type !== "prompt") continue;
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "echo: " + c.message } });
    if (c.message === "finish") writeFileSync(process.env.BUILDER_DONE_FILE, JSON.stringify({ ok: true }));
    out({ type: "agent_settled", aborted: false });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    const agentics = writeTree(join(tmp.dir, "rpc-agentics"), { "agents/steer/agent.yml": "description: steerable\nmode: rpc\ntools: { enable: [outcome] }\n" });
    const rt = createRuntime({ runsDir, piCommand: rpcPi, agenticsDir: agentics });
    const rec = await rt.start({ agent: "steer", workspace: "none" });
    await waitFor("the control socket", () => rt.get(rec.id)?.socket, 10_000, 50);
    const child = spawn(process.execPath, [CLI, "attach", rec.id, "--json", "--config", configFile], { env, stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    await new Promise((r) => setTimeout(r, 300));
    child.stdin.write("hello there\n");
    await waitFor("the echo", () => (out.includes("echo: hello there") ? true : undefined), 10_000, 50);
    child.stdin.write("finish\n");
    assert.equal((await rt.wait(rec.id)).outcome, "done");
    assert.equal(await exited, 0, "attach ends when the run's socket closes");
    child.stdin.end();
    assert.ok(lines(out).some((l) => l.type === "response" && l.command === "prompt"));
    const ended = cli(["attach", rec.id]);
    assert.equal(ended.code, 2);
    assert.match(ended.stderr, /has no control socket to attach to: it is done/);
  });

  it("usage: no command, an unknown command, and the stubs the parallel parts fill", () => {
    const none = spawnSync(process.execPath, [CLI], { env, encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.match(none.stdout, /usage: builder <command>/);
    assert.equal(spawnSync(process.execPath, [CLI, "--help"], { env, encoding: "utf8" }).status, 0);
    const unknown = cli(["frobnicate", "--json"]);
    assert.deepEqual([unknown.code, json(unknown).error.code], [2, "usage"]);
    assert.equal(cli(["server"]).code, 2, "server needs start, stop, restart or run");
    // agent new is built (test/unit/definitions-runtime.test.ts, on a temp tree): here only its usage, which writes nothing.
    assert.equal(cli(["agent", "new"]).code, 2, "agent new needs a path");
    assert.equal(cli(["logs"]).code, 2);
    assert.match(cli(["run", "--help"]).stdout, /usage: builder run <agent:<id>\|workflow:<id>\|id> \[options\]/);
  });
});
