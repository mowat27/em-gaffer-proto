/**
 * Messaging and subagents, with pi a stub (rpc: it answers every command and echoes prompts; headless: it waits to be
 * stopped):
 *   - run_send (runtime/messaging.ts's wire): a message to a live rpc or durable run by id or by name reaches pi as a
 *     follow-up prompt, journaled message.received by the target's relay; who takes none and why; one live run per
 *     name, one live durable run per agent; durable and named runs keep a journal;
 *   - run_subscribe: journal events after a cursor, filtered by kind prefixes, and waiting for the next one;
 *   - subagent budgets from the agent parent's remaining budget, `workspace: { dir: parent }`, and detach (E23).
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { kindMatches } from "../../ops/core/messaging.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { readJournal } from "../../runtime/journal.ts";
import { budgetOf, createRuntime, processAlive } from "../../runtime/run.ts";
import { isFinal, type RunRecord } from "../../runtime/types.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = JSON.stringify(pathToFileURL(join(BUILDER, "engine", "workflow.ts")).href);
const tmp = tempDir("builder-messaging");
after(async () => {
  // A run left live (a failed assertion) would keep this test's process alive.
  for (const r of rt.list()) if (!isFinal(r.state)) await rt.stop(r.id, "test cleanup");
  tmp.remove();
});

const pi = fakePi(
  tmp.dir,
  "msg-pi",
  `import { appendFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.on("SIGTERM", () => process.exit(0));
if (!process.argv.includes("rpc")) setInterval(() => {}, 1000);
else {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      appendFileSync(process.env.BUILDER_RUN_DIR + "/commands.jsonl", line + "\\n");
      const c = JSON.parse(line);
      if (c.message === "refuse") { out({ id: c.id, type: "response", command: c.type, success: false, error: "not now" }); continue; }
      out({ id: c.id, type: "response", command: c.type, success: true, data: { disposition: "started" } });
      if (c.type === "prompt") { out({ type: "echo", message: c.message }); out({ type: "agent_settled", aborted: false }); }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
`,
);

const runsDir = join(tmp.dir, "runs");
const agentics = writeTree(join(tmp.dir, "agentics"), {
  "agents/daemon/agent.yml": "description: long-lived\nmode: durable\ntools: { enable: [read] }\n",
  "agents/helper/agent.yml": "description: steerable\nmode: rpc\ntools: { enable: [outcome] }\n",
  "agents/quiet/agent.yml": "description: headless\nmode: headless\n",
  "agents/boss/agent.yml": "description: starts subagents\nmode: headless\nruns: { may_start: ['*'] }\ntools: { enable: [read, runs, messaging] }\n",
  "agents/worker/agent.yml": "description: works until stopped\nmode: headless\ntools: { enable: [read] }\n",
});
const rt = createRuntime({ runsDir, piCommand: pi, agenticsDir: agentics });
const layer = writeTree(join(tmp.dir, "cfg"), { "machine.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` });
const config = loadConfig({ packaged: join(tmp.dir, "absent.yml"), userConfig: join(tmp.dir, "absent.yml"), env: {}, configPath: join(layer, "machine.yml") });
const operator: ToolContext = cliContext(config, rt);
const asRun = (runId: string, agent: string): ToolContext => ({ ...operator, caller: { kind: "agent", runId, agent, allowed: new Set(["run_send", "run_subscribe"]) } });

async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    assert.ok(isToolError(err), String(err));
    return err as { code: string; message: string };
  }
  return assert.fail("the call did not fail");
}
const commands = (id: string) => readFileSync(join(runsDir, id, "commands.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const live = (id: string) => waitFor(`run ${id}'s control socket`, () => rt.get(id)?.socket, 10_000, 50);

describe("run_send and run_subscribe", () => {
  it("a message to a durable run by its name reaches pi as a follow-up prompt; the target journals message.received; run_subscribe follows it", async () => {
    const rec = await rt.start({ agent: "daemon", workspace: "none", name: "keeper" });
    assert.equal(rec.journal, true, "a durable (and named) run keeps a journal");
    await live(rec.id);
    const sent = (await callTool("run_send", { target: "keeper", message: "hello keeper" }, operator)) as Record<string, unknown>;
    assert.deepEqual({ ...sent, id: typeof sent.id }, { id: "string", runId: rec.id, name: "keeper", mode: "durable", disposition: "started" });
    assert.deepEqual(commands(rec.id).at(-1), { id: sent.id, type: "prompt", message: "hello keeper", streamingBehavior: "followUp" });
    const received = await waitFor("message.received", () => readJournal(rt.dir(rec.id), { kind: "message.received" })[0], 5000, 50);
    assert.deepEqual(received.data, { id: sent.id, via: "run_send", from: { kind: "cli" }, message: "hello keeper", accepted: true, disposition: "started" });

    const first = (await callTool("run_subscribe", { target: "keeper", events: ["message"] }, operator)) as { events: { kind: string; seq: number }[]; cursor: number; state: string; more: boolean };
    assert.deepEqual(first.events.map((e) => e.kind), ["message.received"]);
    assert.equal(first.state, "running");
    assert.ok(first.cursor >= first.events[0].seq);
    const nothing = (await callTool("run_subscribe", { target: rec.id, events: ["message"], since: first.cursor }, operator)) as typeof first;
    assert.deepEqual([nothing.events, nothing.cursor], [[], first.cursor], "nothing new: the same cursor");
    // A waiting subscriber gets the next message as it comes, sent by another run (from names it).
    const waiting = callTool("run_subscribe", { target: "keeper", events: ["message.received"], since: first.cursor, waitSeconds: 10 }, operator) as Promise<typeof first>;
    await callTool("run_send", { target: rec.id, message: "second" }, asRun("20990101-000000-000001", "boss"));
    const next = await waiting;
    assert.equal(next.events.length, 1);
    assert.deepEqual((next.events[0] as unknown as { data: { message: string; from: unknown } }).data.from, { kind: "agent", runId: "20990101-000000-000001", agent: "boss" });
    const limited = (await callTool("run_subscribe", { target: "keeper", limit: 1 }, operator)) as typeof first;
    assert.deepEqual([limited.events.length, limited.more, limited.cursor], [1, true, limited.events[0].seq], "a page ends at its last event");

    // pi refusing it fails the call, and the target still journals it.
    const refused = await failure(callTool("run_send", { target: "keeper", message: "refuse" }, operator));
    assert.equal(refused.code, "failed");
    assert.match(refused.message, new RegExp(`pi in run ${rec.id} refused the message: not now`));

    // One live run per name; one live durable run per agent.
    await assert.rejects(rt.start({ agent: "helper", workspace: "none", name: "keeper" }), new RegExp(`run refused: run ${rec.id} is live with the name keeper`));
    await assert.rejects(rt.start({ agent: "daemon", workspace: "none" }), new RegExp(`run refused: agent daemon already has a live durable run, ${rec.id}`));
    await rt.stop(rec.id, "test over");

    // Ended: by name a live target is looked for, by id the run says it has ended.
    assert.match((await failure(callTool("run_send", { target: "keeper", message: "x" }, operator))).message, new RegExp(`the run named keeper has ended \\(${rec.id}\\)`));
    assert.match((await failure(callTool("run_send", { target: rec.id, message: "x" }, operator))).message, /has ended \(stopped\)/);
    const after = (await callTool("run_subscribe", { target: "keeper", events: ["run.end"] }, operator)) as typeof first;
    assert.deepEqual([after.state, after.events.map((e) => e.kind)], ["stopped", ["run.end"]], "an ended run can still be read by its name");
    const again = await rt.start({ agent: "daemon", workspace: "none", name: "keeper" });
    await rt.stop(again.id, "test over");
  });

  it("who takes no messages: a headless run, a run in a server job, the caller's own run; a run with no journal cannot be subscribed to", async () => {
    const quiet = await rt.start({ agent: "quiet", workspace: "none", input: { message: "wait" } });
    const headless = await failure(callTool("run_send", { target: quiet.id, message: "hi" }, operator));
    assert.deepEqual([headless.code, headless.message], ["refused", `run ${quiet.id} runs headless: only rpc and durable runs take messages`]);
    assert.match((await failure(callTool("run_subscribe", { target: quiet.id }, operator))).message, /keeps no journal/);

    const job = await rt.start({ agent: "helper", workspace: "none" }, { job: { jobId: "job-msg-1", callback: "http://127.0.0.1:9/jobs/job-msg-1" } });
    await live(job.id);
    assert.equal((await failure(callTool("run_send", { target: job.id, message: "hi" }, operator))).message, `run ${job.id} belongs to server job job-msg-1: server jobs take no messages`);

    const helper = await rt.start({ agent: "helper", workspace: "none", name: "steer-me" });
    await live(helper.id);
    const self = await failure(callTool("run_send", { target: "steer-me", message: "hi" }, asRun(helper.id, "helper")));
    assert.deepEqual([self.code, self.message], ["refused", `run ${helper.id} is your own run: a run does not message itself`]);
    assert.equal((await failure(callTool("run_send", { target: "steer-me", message: "" }, operator))).code, "invalid");
    assert.match((await failure(callTool("run_send", { target: "nobody-has-this-name", message: "x" }, operator))).message, /no run nobody-has-this-name/);
    // An rpc run takes messages too (builder attach sends through run_send).
    assert.equal(((await callTool("run_send", { target: "steer-me", message: "go" }, operator)) as { disposition: string }).disposition, "started");
    await Promise.all([quiet, job, helper].map((r) => rt.stop(r.id, "test over")));
  });

  it("kind prefixes: a segment matches its kinds, * and a trailing dot or star too", () => {
    assert.equal(kindMatches("tool.start", ["tool"]), true);
    assert.equal(kindMatches("tool.start", ["tool.*"]), true);
    assert.equal(kindMatches("tool.start", ["tool."]), true);
    assert.equal(kindMatches("tool.start", ["too"]), false);
    assert.equal(kindMatches("run.end", ["run.end", "message"]), true);
    assert.equal(kindMatches("anything", ["*"]), true);
    assert.equal(kindMatches("anything", undefined), true);
  });
});

describe("subagents", () => {
  it("budgetOf: the spec's budget, within what an agent parent has left; under a minute left starts nothing", () => {
    const now = Date.parse("2026-11-18T10:00:00Z");
    const parent = (minutesLeft: number, kind: RunRecord["kind"] = "agent") => ({ id: "p", kind, parent: null, spec: { agent: "boss" }, state: "running", pid: 1, startedAt: "", deadline: new Date(now + minutesLeft * 60_000).toISOString() }) as RunRecord;
    assert.deepEqual(budgetOf({}, null, now), {});
    assert.deepEqual(budgetOf({ budgetMinutes: 5 }, null, now), { budgetMinutes: 5, deadline: "2026-11-18T10:05:00.000Z" });
    assert.deepEqual(budgetOf({}, parent(7.256), now), { budgetMinutes: 7.25, deadline: "2026-11-18T10:07:15.000Z" }, "no budget of its own: what the parent has left");
    assert.deepEqual(budgetOf({ budgetMinutes: 30 }, parent(7.256), now).budgetMinutes, 7.25);
    assert.deepEqual(budgetOf({ budgetMinutes: 2 }, parent(7), now), { budgetMinutes: 2, deadline: "2026-11-18T10:02:00.000Z" });
    assert.throws(() => budgetOf({ budgetMinutes: 2 }, parent(0.5), now), /run refused: agent boss \(run p\) has 0\.5 min left of its budget, under the 1 min a run needs/);
    assert.throws(() => budgetOf({}, parent(-3), now), /has nothing left of its budget/);
    assert.deepEqual(budgetOf({ budgetMinutes: 2 }, parent(0.5, "workflow"), now).budgetMinutes, 2, "a workflow's steps get their budgets from the engine");
  });

  it("a child gets the parent's remaining budget and, with workspace { dir: parent }, the parent's workspace; a refused start makes no run", async () => {
    const boss = await rt.start({ agent: "boss", input: { message: "lead" }, budgetMinutes: 3 });
    assert.equal(boss.budgetMinutes, 3);
    const child = await rt.start({ agent: "worker", input: { message: "help" }, budgetMinutes: 10, workspace: { dir: "parent" } }, { parent: boss.id });
    assert.ok(child.budgetMinutes! > 2.9 && child.budgetMinutes! <= 3, String(child.budgetMinutes));
    assert.ok(Date.parse(child.deadline!) <= Date.parse(boss.deadline!));
    assert.deepEqual(child.spec.workspace, { dir: "parent" }, "the spec keeps what was asked");
    assert.deepEqual(child.resolved!.workspace, { dir: { path: boss.resolved!.cwd } });
    assert.equal(child.resolved!.cwd, join(runsDir, boss.id, "workspace"));
    const fromTool = (await callTool("run_start", { agent: "worker", input: { message: "x" }, budgetMinutes: 1 }, { ...operator, caller: { kind: "agent", runId: boss.id, agent: "boss", allowed: new Set(["run_start"]) } })) as Record<string, unknown>;
    assert.deepEqual([fromTool.budgetMinutes, typeof fromTool.deadline], [1, "string"]);
    await assert.rejects(rt.start({ agent: "worker", input: { message: "x" }, workspace: { dir: "parent" } }), /only a run can start one/);
    const none = await rt.start({ agent: "boss", input: { message: "x" }, workspace: "none" });
    const before = rt.list().length;
    await assert.rejects(rt.start({ agent: "worker", input: { message: "x" }, workspace: { dir: "parent" } }, { parent: none.id }), new RegExp(`run ${none.id} has no workspace to share`));
    // The parent's budget almost spent: its deadline is moved to 30 s from now.
    rt.update(boss.id, { deadline: new Date(Date.now() + 30_000).toISOString() });
    await assert.rejects(rt.start({ agent: "worker", input: { message: "x" } }, { parent: boss.id }), /left of its budget, under the 1 min a run needs/);
    assert.equal(rt.list().length, before, "no run was made");
    await Promise.all([boss, child, none, { id: fromTool.runId as string }].map((r) => rt.stop(r.id, "test over")));
  });

  it("E23: a run stopping stops its children, except those started with detach, which keep running and stay in run_list", async () => {
    const mod = join(tmp.dir, "two-children.mts");
    writeFileSync(
      mod,
      `import { code, defineBuilder } from ${WORKFLOW};
export default defineBuilder({ name: "two-children", provides: [], steps: [code("spawn", async (ctx) => {
  await ctx.runtime.start({ agent: "worker", input: { message: "stay" }, detach: true, name: "survivor" }, { parent: ctx.job.runId });
  await ctx.runtime.start({ agent: "worker", input: { message: "go" } }, { parent: ctx.job.runId });
  await new Promise((r) => setTimeout(r, 60_000));
  return {};
})] });
`,
    );
    const dispatch = { requires: [], repo: { url: "/nowhere", base: "abc1234" }, task: { sliceId: "s1", title: "Detach", context: "Billing", handover: false, attempt: 1 }, slice: null, callback: "http://127.0.0.1:9/jobs/job-detach" };
    const wf = await rt.start({ workflow: mod, input: { dispatch } });
    const kids = await waitFor("both children running", () => {
      const k = rt.list().filter((r) => r.parent === wf.id && r.state === "running" && r.pid);
      return k.length === 2 ? k : undefined;
    }, 15_000, 50);
    const detached = kids.find((k) => k.spec.detach)!;
    const attached = kids.find((k) => !k.spec.detach)!;
    await rt.stop(wf.id, "operator stop");
    const stopped = await waitFor("the attached child to end", () => (isFinal(rt.get(attached.id)!.state) ? rt.get(attached.id)! : undefined), 10_000, 100);
    assert.deepEqual(stopped.result, { outcome: "failed", reason: "operator stop" });
    await new Promise((r) => setTimeout(r, 1200));
    const still = rt.get(detached.id)!;
    assert.equal(still.state, "running", "the detached child outlives its parent");
    assert.ok(processAlive(still.pid!));
    const listed = (await callTool("run_list", { state: "live" }, operator)) as { runs: { id: string; detach?: boolean }[] };
    assert.ok(listed.runs.some((r) => r.id === detached.id && r.detach === true));
    await rt.stop(detached.id, "test over");
    assert.equal(rt.get(detached.id)!.state, "stopped");
  });
});
