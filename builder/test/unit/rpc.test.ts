/**
 * rpc and durable runs: pi's JSON lines relayed over runs/<id>/control.sock (client lines to pi's stdin, pi's lines to
 * every client), the first message sent as a prompt, and when the run ends. pi is a stub speaking the rpc protocol.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { controlSocketPaths } from "../../runtime/pi.ts";
import { createRuntime } from "../../runtime/run.ts";
import { isFinal } from "../../runtime/types.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const tmp = tempDir("builder-rpc");
after(() => tmp.remove());

// The stub: every stdin command is recorded and answered with a response; a prompt is echoed as an event, and its
// message decides what follows: "finish" calls done then settles, "settle" settles without done.
const pi = fakePi(
  tmp.dir,
  "rpc-pi",
  `import { appendFileSync, writeFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const seen = process.env.BUILDER_RUN_DIR + "/commands.jsonl";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    appendFileSync(seen, line + "\\n");
    const c = JSON.parse(line);
    out({ id: c.id, type: "response", command: c.type, success: true });
    if (c.type !== "prompt") continue;
    out({ type: "agent_start" });
    out({ type: "echo", message: c.message, unicode: "line\\u2028separator" });
    if (c.message === "finish") { writeFileSync(process.env.BUILDER_DONE_FILE, JSON.stringify({ ok: true })); out({ type: "agent_settled", aborted: false }); }
    if (c.message === "settle") out({ type: "agent_settled", aborted: false });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);
const agentics = writeTree(join(tmp.dir, "agentics"), {
  "agents/steer/agent.yml": "description: steerable\nmode: rpc\nprompt: own:prompts/go.md\ntools: { enable: [outcome] }\n",
  "agents/steer/prompts/go.md": "Go $1\n",
  "agents/daemon/agent.yml": "description: long-lived\nmode: durable\ntools: { enable: [read] }\n",
});
const rt = createRuntime({ runsDir: join(tmp.dir, "runs"), piCommand: pi, agenticsDir: agentics });

/** A client on the run's control socket that collects every line. */
async function client(id: string): Promise<{ sock: Socket; lines: unknown[]; send(o: unknown): void; next(match: (l: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> }> {
  const socket = await waitFor("the control socket", () => rt.get(id)?.socket, 10_000, 50);
  const sock = connect(socket);
  await new Promise<void>((r, j) => sock.once("connect", () => r()).once("error", j));
  const lines: unknown[] = [];
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  return {
    sock,
    lines,
    send: (o) => sock.write(JSON.stringify(o) + "\n"),
    next: (match) => waitFor("a line from pi", () => lines.find((l) => match(l as Record<string, unknown>)) as Record<string, unknown> | undefined, 10_000, 20),
  };
}

describe("rpc runs", { concurrency: true }, () => {
  it("relays clients to pi and pi to every client; the template message starts it; it ends when pi settles after done", async () => {
    const rec = await rt.start({ agent: "steer", input: { args: ["now"] } });
    assert.equal(rec.resolved?.mode, "rpc");
    const a = await client(rec.id);
    const b = await client(rec.id);
    assert.equal(rt.get(rec.id)?.socket, controlSocketPaths(rt.dir(rec.id)).listen);
    a.send({ id: "q1", type: "get_state" });
    assert.deepEqual(await b.next((l) => l.id === "q1"), { id: "q1", type: "response", command: "get_state", success: true }, "a response reaches every client");
    a.send({ type: "prompt", message: "ping" });
    const echo = await b.next((l) => l.type === "echo" && l.message === "ping");
    assert.equal(echo.unicode, "line separator", "lines split on LF only");
    assert.equal(rt.get(rec.id)?.state, "running", "a settle-free turn keeps the run going");
    b.send({ type: "prompt", message: "finish" });
    const result = await rt.wait(rec.id);
    assert.deepEqual(result, { outcome: "done", data: { done: { ok: true }, pi: rec.resolved!.settings } });
    const commands = readFileSync(join(rt.dir(rec.id), "commands.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(commands[0], { id: "builder-start", type: "prompt", message: '/go "now"' }, "the first message is sent as a prompt");
    assert.deepEqual(commands.slice(1).map((c) => c.type), ["get_state", "prompt", "prompt"]);
    assert.match(readFileSync(join(rt.dir(rec.id), "log"), "utf8"), /"type":"echo","message":"ping"/, "pi's lines are in the run log");
    assert.ok(!existsSync(join(rt.dir(rec.id), "control.sock")), "the socket is gone when the run ends");
    a.sock.destroy();
    b.sock.destroy();
  });

  it("pi settling without done with no client connected ends the run: a job fails as today (the agent finished without calling done), a run without a dispatch is done", async () => {
    const dispatch = { repo: { url: "x", base: "y" }, task: { sliceId: "s-1", title: "Steer", context: "Billing", attempt: 1 }, slice: {}, callback: "http://127.0.0.1:9/jobs/job-steer" };
    const job = await rt.start({ agent: "steer", input: { dispatch, message: "settle" } });
    assert.deepEqual(await rt.wait(job.id), { outcome: "failed", reason: "the agent finished without calling done" });
    const plain = await rt.start({ agent: "steer", input: { message: "settle" } });
    assert.deepEqual(await rt.wait(plain.id), { outcome: "done", data: { done: null, pi: plain.resolved!.settings } });
  });

  it("pi settling without done while a client is connected keeps the run for that client", async () => {
    const rec = await rt.start({ agent: "steer" });
    const c = await client(rec.id);
    c.send({ type: "prompt", message: "settle" });
    await c.next((l) => l.type === "agent_settled");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(rt.get(rec.id)?.state, "running");
    c.send({ type: "prompt", message: "finish" });
    assert.equal((await rt.wait(rec.id)).outcome, "done");
    c.sock.destroy();
  });

  it("durable: does not end when pi settles; its session is the agent's state/sessions; it ends when stopped", async () => {
    const rec = await rt.start({ agent: "daemon", input: { message: "settle" } });
    assert.ok(rec.resolved!.argv.includes(join(agentics, "agents", "daemon", "state", "sessions")));
    const c = await client(rec.id);
    c.send({ type: "prompt", message: "settle" });
    await c.next((l) => l.type === "agent_settled");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(rt.get(rec.id)?.state, "running");
    c.sock.destroy();
    await rt.stop(rec.id, "operator stop");
    const after = rt.get(rec.id)!;
    assert.ok(isFinal(after.state));
    assert.deepEqual(after.result, { outcome: "failed", reason: "operator stop" });
  });

  it("a socket path too long for a Unix socket listens in the temp dir and is linked from the run", () => {
    const long = join(tmp.dir, "x".repeat(120));
    const p = controlSocketPaths(long);
    assert.equal(p.link, join(long, "control.sock"));
    assert.ok(Buffer.byteLength(p.listen) <= 100);
    assert.deepEqual(controlSocketPaths("/r/1"), { listen: "/r/1/control.sock" });
  });
});
