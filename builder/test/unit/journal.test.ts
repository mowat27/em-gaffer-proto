/**
 * The journal: the writer (seq, ids, blobs, redaction, the size cap, continuing after the run), the client
 * (journalSend over the socket, the fallback file and its merge, E12), the readers (filters, metrics, the run tree,
 * step durations), summary.json, and the commit trailers made from it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitMessage, formatStepDurations } from "../../engine/steps/commit.ts";
import type { Job } from "../../engine/types.ts";
import { journalSend, redact, redactText, secretsOf } from "../../runtime/journal-client.ts";
import { childRuns, journalMetrics, JournalWriter, payloadOf, readJournal, socketPaths, stepDurations, treeMetrics, type JournalEvent } from "../../runtime/journal.ts";
import { JOURNAL_EXTENSION, runnerArgv } from "../../runtime/pi.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { Resolved } from "../../runtime/types.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-journal");
after(() => tmp.remove());
let n = 0;
const runDir = () => {
  const d = join(tmp.dir, "runs", `run-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const lines = (dir: string) => readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as JournalEvent);

describe("JournalWriter", () => {
  it("numbers events from 1, fills in the run, agent and step, and a later writer continues the seq", () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r1", agent: "a", step: "implement" });
    const first = w.append({ kind: "run.start", parent: "p0", data: { x: 1 } })!;
    assert.deepEqual({ ...first, ts: "" }, { seq: 1, ts: "", runId: "r1", step: "implement", agent: "a", parent: "p0", kind: "run.start", data: { x: 1 } });
    assert.equal(w.append({ kind: "step.start", step: "other", span: "s-1", data: {} })?.step, "other", "an event's own step wins");
    const later = new JournalWriter(dir, { runId: "r1" });
    assert.equal(later.append({ kind: "job.result", data: { outcome: "done" } })?.seq, 3);
    assert.deepEqual(lines(dir).map((e) => e.seq), [1, 2, 3]);
    assert.ok(!Number.isNaN(Date.parse(first.ts)));
  });

  it("moves a field over 8 KB to blobs/<sha256>, keeping a 2 KB preview; payloadOf reads it back; equal payloads share a blob", () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r" });
    const big = "abcdefghij".repeat(1000);
    const e = w.append({ kind: "tool.end", data: { tool: "read", output: big, ms: 3 } })!;
    const m = e.data.output as { blob: string; bytes: number; preview: string };
    assert.match(m.blob, /^sha256:[0-9a-f]{64}$/);
    assert.equal(m.bytes, 10_000);
    assert.equal(m.preview, `${big.slice(0, 2048)}…`);
    assert.equal(e.data.tool, "read");
    assert.equal(payloadOf(dir, m), big);
    assert.equal(payloadOf(dir, "small"), "small");
    const obj = { path: "x", content: big };
    const e2 = w.append({ kind: "tool.start", data: { input: obj } })!;
    assert.deepEqual(JSON.parse(payloadOf(dir, e2.data.input) as string), obj, "an object is stored as its JSON");
    w.append({ kind: "tool.end", data: { output: big } });
    assert.equal(readdirSync(join(dir, "blobs")).length, 2);
    assert.equal(w.append({ kind: "x", data: { output: "y".repeat(8192) } })?.data.output, "y".repeat(8192), "8 KB exactly stays inline");
  });

  it("redacts *_KEY and *_TOKEN values and Authorization headers before writing", () => {
    process.env.JTEST_SERVICE_TOKEN = "tok-abcdefgh-1234";
    process.env.JTEST_SHORT_KEY = "1";
    try {
      const dir = runDir();
      const w = new JournalWriter(dir, { runId: "r" });
      w.append({ kind: "tool.start", data: { input: { command: "curl -H 'Authorization: Bearer xyz.abc' https://x/?t=tok-abcdefgh-1234", headers: { Authorization: "Basic abc", other: "1" } } } });
      const text = readFileSync(join(dir, "journal.jsonl"), "utf8");
      assert.ok(!text.includes("tok-abcdefgh-1234"));
      assert.ok(!text.includes("xyz.abc"));
      const input = lines(dir)[0].data.input as { command: string; headers: Record<string, string> };
      assert.equal(input.command, "curl -H 'Authorization: Bearer [redacted]' https://x/?t=[redacted:JTEST_SERVICE_TOKEN]");
      assert.deepEqual(input.headers, { Authorization: "[redacted]", other: "1" }, "a short value is not a secret");
      assert.ok(!secretsOf().some((s) => s.name === "JTEST_SHORT_KEY"));
      assert.equal(redactText("authorization=Token abc123"), "authorization=Token [redacted]");
      assert.deepEqual(redact({ a: ["tok-abcdefgh-1234"] }), { a: ["[redacted:JTEST_SERVICE_TOKEN]"] });
    } finally {
      delete process.env.JTEST_SERVICE_TOKEN;
      delete process.env.JTEST_SHORT_KEY;
    }
  });

  it("past the size cap, payloads over 512 bytes go to blobs with a 256-character preview (E17)", () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r" }, { capBytes: 2000 });
    const text = "z".repeat(1000);
    assert.equal(w.append({ kind: "a", data: { output: text } })?.data.output, text);
    assert.equal(w.append({ kind: "b", data: { output: text } })?.data.output, text);
    const clipped = w.append({ kind: "c", data: { output: text } })!.data.output as { preview: string };
    assert.equal(clipped.preview.length, 257);
    w.close();
    assert.equal(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).clipped, true);
  });

  it("merges the fallback file: lines already received are dropped, broken lines skipped, journal.merged recorded (E12)", () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r", agent: "a" });
    const fb = join(dir, "journal.fallback.jsonl");
    const line = (cid: string, kind: string) => JSON.stringify({ kind, data: { cid }, ts: "2026-11-17T10:00:00.000Z", cid, span: "t-1" });
    writeFileSync(fb, [line("c1", "tool.start"), line("c2", "tool.end"), line("c1", "tool.start"), "{not json", ""].join("\n"));
    w.mergeFallback();
    const ev = lines(dir);
    assert.deepEqual(ev.map((e) => e.kind), ["tool.start", "tool.end", "journal.merged"]);
    assert.equal(ev[0].ts, "2026-11-17T10:00:00.000Z", "the client's time is kept");
    assert.equal(ev[0].agent, "a");
    assert.deepEqual(ev[2].data, { from: "journal.fallback.jsonl", events: 2, skipped: 2 });
    assert.ok(!existsSync(fb));
    w.mergeFallback();
    assert.equal(lines(dir).length, 3, "nothing to merge twice");
  });

  it("a run directory too long for a Unix socket listens in the temp dir, linked from the run", () => {
    const long = join(tmp.dir, "y".repeat(120));
    const p = socketPaths(long, "journal.sock");
    assert.equal(p.link, join(long, "journal.sock"));
    assert.ok(Buffer.byteLength(p.listen) <= 100);
    assert.deepEqual(socketPaths("/r/1", "journal.sock"), { listen: "/r/1/journal.sock" });
  });
});

describe("journalSend", () => {
  it("does nothing outside a run with a journal, and writes the fallback file when there is no socket", () => {
    const saved = { sock: process.env.BUILDER_JOURNAL_SOCK, fb: process.env.BUILDER_JOURNAL_FALLBACK };
    delete process.env.BUILDER_JOURNAL_SOCK;
    delete process.env.BUILDER_JOURNAL_FALLBACK;
    try {
      assert.doesNotThrow(() => journalSend({ kind: "x", data: {} }));
      const dir = runDir();
      process.env.BUILDER_JOURNAL_FALLBACK = join(dir, "journal.fallback.jsonl");
      journalSend({ kind: "tool.gate", span: "t-1", data: { decision: "block" } });
      const sent = JSON.parse(readFileSync(process.env.BUILDER_JOURNAL_FALLBACK, "utf8"));
      assert.equal(sent.kind, "tool.gate");
      assert.equal(sent.span, "t-1");
      assert.match(sent.cid, /^\d+-[0-9a-f]{8}-\d+$/);
      process.env.BUILDER_JOURNAL_FALLBACK = join(dir, "missing", "dir", "fallback.jsonl");
      assert.doesNotThrow(() => journalSend({ kind: "x", data: {} }), "never throws");
    } finally {
      if (saved.sock) process.env.BUILDER_JOURNAL_SOCK = saved.sock;
      if (saved.fb) process.env.BUILDER_JOURNAL_FALLBACK = saved.fb;
      else delete process.env.BUILDER_JOURNAL_FALLBACK;
    }
  });

  it("over the socket; when the socket drops, the rest goes to the fallback file and is merged, nothing lost or doubled (E12)", async () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r", agent: "a" });
    const sock = await w.listen();
    assert.ok(sock && existsSync(sock));
    const go = join(dir, "go");
    const script = join(dir, "client.mts");
    writeFileSync(
      script,
      `import { existsSync } from "node:fs";
import { journalSend } from ${JSON.stringify(pathToFileURL(join(BUILDER, "runtime", "journal-client.ts")).href)};
for (let i = 1; i <= 5; i++) journalSend({ kind: "test.event", data: { i, key: process.env.JTEST_CLIENT_KEY } });
while (!existsSync(process.env.GO)) await new Promise((r) => setTimeout(r, 20));
await new Promise((r) => setTimeout(r, 150));
for (let i = 6; i <= 10; i++) journalSend({ kind: "test.event", data: { i } });
`,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, GO: go, BUILDER_JOURNAL_SOCK: sock, BUILDER_JOURNAL_FALLBACK: w.fallbackFile, JTEST_CLIENT_KEY: "client-secret-value" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const exited = new Promise<number | null>((r) => child.on("exit", r));
    await waitFor("five events over the socket", () => (readJournal(dir, { kind: "test.event" }).length === 5 ? true : undefined), 10_000, 20);
    w.dropClients();
    assert.ok(!existsSync(sock), "the socket is gone");
    writeFileSync(go, "");
    assert.equal(await exited, 0);
    assert.equal(readJournal(dir).length, 5, "the rest went to the fallback file");
    w.mergeFallback();
    const got = readJournal(dir, { kind: "test.event" }).map((e) => e.data.i);
    assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(!readFileSync(join(dir, "journal.jsonl"), "utf8").includes("client-secret-value"), "redacted in the client");
    assert.equal(readJournal(dir, { kind: "journal.merged" })[0].data.events, 5);
    w.close();
  });

  for (const [how, graceMs] of [
    ["gracefully (read until the client half-closes)", 2000],
    ["at once (the connection destroyed with lines unread)", 0],
  ] as const) {
    it(`a drop while lines are in flight, ${how}: every line once, none lost (E12)`, async () => {
      const dir = runDir();
      const w = new JournalWriter(dir, { runId: "r" });
      const sock = await w.listen();
      assert.ok(sock);
      const script = join(dir, "burst.mts");
      writeFileSync(
        script,
        `import { journalFlush, journalSend } from ${JSON.stringify(pathToFileURL(join(BUILDER, "runtime", "journal-client.ts")).href)};
for (let i = 1; i <= 300; i++) {
  journalSend({ kind: "burst", data: { i, pad: "x".repeat(2000) } });
  if (i % 10 === 0) await new Promise((r) => setTimeout(r, 2));
}
await journalFlush(2000);
`,
      );
      const child = spawn(process.execPath, [script], { env: { ...process.env, BUILDER_JOURNAL_SOCK: sock, BUILDER_JOURNAL_FALLBACK: w.fallbackFile }, stdio: ["ignore", "inherit", "inherit"] });
      const exited = new Promise<number | null>((r) => child.on("exit", r));
      await waitFor("the first lines", () => (readJournal(dir, { kind: "burst" }).length >= 30 ? true : undefined), 10_000, 2);
      w.dropClients(graceMs);
      assert.equal(await exited, 0);
      w.mergeFallback();
      const got = readJournal(dir, { kind: "burst" }).map((e) => Number(e.data.i)).sort((a, b) => a - b);
      assert.deepEqual(got, Array.from({ length: 300 }, (_, i) => i + 1));
      assert.ok(readJournal(dir, { kind: "journal.merged" }).length === 1, "the rest came through the fallback file");
      w.close();
    });
  }

  it("drain keeps the run process alive until the last client hangs up (a top-level await never ends unsettled)", async () => {
    const dir = runDir();
    const script = join(dir, "drain.mts");
    const href = (rel: string) => JSON.stringify(pathToFileURL(join(BUILDER, rel)).href);
    // The writer's process holds nothing but the client's connection while it drains, as a run process does at its end.
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
import { JournalWriter, readJournal } from ${href("runtime/journal.ts")};
const dir = ${JSON.stringify(dir)};
const w = new JournalWriter(dir, { runId: "r" });
const sock = await w.listen();
const client = spawn(process.execPath, ["--input-type=module", "-e", \`import { journalSend } from ${href("runtime/journal-client.ts").replace(/"/g, "'")}; journalSend({ kind: "hello", data: {} }); setTimeout(() => {}, 300);\`], { env: { ...process.env, BUILDER_JOURNAL_SOCK: sock }, stdio: "ignore" });
client.unref();
while (readJournal(dir).length === 0) await new Promise((r) => setTimeout(r, 10));
await w.drain(5000);
console.log("drained");
`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 0, "exit code 13 is an unsettled top-level await");
    assert.equal(out.trim(), "drained");
  });

  it("lines the writer acknowledged never reach the fallback file", async () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r" });
    const sock = await w.listen();
    assert.ok(sock);
    const script = join(dir, "acked.mts");
    writeFileSync(
      script,
      `import { journalFlush, journalSend } from ${JSON.stringify(pathToFileURL(join(BUILDER, "runtime", "journal-client.ts")).href)};
for (let i = 1; i <= 20; i++) journalSend({ kind: "acked", data: { i } });
await journalFlush(5000);
`,
    );
    const child = spawn(process.execPath, [script], { env: { ...process.env, BUILDER_JOURNAL_SOCK: sock, BUILDER_JOURNAL_FALLBACK: w.fallbackFile }, stdio: ["ignore", "inherit", "inherit"] });
    assert.equal(await new Promise<number | null>((r) => child.on("exit", r)), 0);
    assert.equal(readJournal(dir, { kind: "acked" }).length, 20);
    assert.ok(!existsSync(w.fallbackFile), "nothing pending at exit");
    w.close();
  });
});

describe("reading the journal", () => {
  /** A journal written line by line, with given times. */
  function journal(dir: string, events: Partial<JournalEvent>[]): void {
    writeFileSync(
      join(dir, "journal.jsonl"),
      events.map((e, i) => JSON.stringify({ seq: i + 1, ts: e.ts ?? `2026-11-17T10:00:${String(i).padStart(2, "0")}.000Z`, runId: "r", data: {}, ...e })).join("\n") + "\n",
    );
  }

  it("readJournal filters by kind (or kind prefix), step, tool, text, after and limit", () => {
    const dir = runDir();
    journal(dir, [
      { kind: "run.start" },
      { kind: "tool.start", step: "implement", data: { tool: "read", input: { path: "a.ts" } } },
      { kind: "tool.end", step: "implement", data: { tool: "read", isError: false } },
      { kind: "tool.start", step: "implement", data: { tool: "write", input: { path: "B.ts" } } },
      { kind: "step.end", step: "implement", data: { status: "ok", ms: 5 } },
    ]);
    assert.equal(readJournal(dir).length, 5);
    assert.deepEqual(readJournal(dir, { kind: "tool.*" }).map((e) => e.seq), [2, 3, 4]);
    assert.deepEqual(readJournal(dir, { kind: "tool.start", tool: "write" }).map((e) => e.seq), [4]);
    assert.deepEqual(readJournal(dir, { text: "b.TS" }).map((e) => e.seq), [4]);
    assert.deepEqual(readJournal(dir, { step: "implement", after: 2, limit: 2 }).map((e) => e.seq), [3, 4]);
    assert.deepEqual(readJournal(join(dir, "nope")), []);
  });

  it("journalMetrics: turns, tool calls and errors, tokens, cost, the model and run.start to run.end; the tree adds the children", () => {
    const parent = runDir();
    const child = join(dirname(parent), "child-1");
    mkdirSync(child);
    journal(child, [
      { kind: "run.start", ts: "2026-11-17T10:00:00.000Z" },
      { kind: "agent.start", data: { model: "p/m" } },
      { kind: "model.usage", data: { model: "p/m", input: 100, output: 10, cacheRead: 50, cost: 0.5 } },
      { kind: "tool.end", data: { tool: "read", isError: false } },
      { kind: "turn.end" },
      { kind: "model.usage", data: { model: "p/m", input: 200, output: 20, cacheRead: 0, cost: 0.25 } },
      { kind: "tool.end", data: { tool: "bash", isError: true } },
      { kind: "tool.end", data: { tool: "done", isError: false } },
      { kind: "turn.end" },
      { kind: "run.end", ts: "2026-11-17T10:04:12.000Z" },
    ]);
    assert.deepEqual(journalMetrics(child), { turns: 2, toolCalls: 3, toolErrors: 1, tokens: { input: 300, output: 30, cacheRead: 50 }, cost: 0.75, model: "p/m", durationMs: 252_000 });
    journal(parent, [
      { kind: "run.start" },
      { kind: "step.start", step: "clone" },
      { kind: "step.end", step: "clone", data: { status: "ok", ms: 3000 } },
      { kind: "step.start", step: "implement", data: { childRunId: "child-1" } },
      { kind: "step.end", step: "implement", data: { status: "ok", ms: 252_000, childRunId: "child-1" } },
      { kind: "run.end" },
    ]);
    assert.deepEqual(childRuns(parent), ["child-1"]);
    const tree = treeMetrics(parent);
    assert.equal(tree.runs, 2);
    assert.equal(tree.toolCalls, 3);
    assert.equal(tree.model, "p/m");
    const steps = stepDurations(parent);
    assert.deepEqual(steps, [
      { step: "clone", status: "ok", ms: 3000 },
      { step: "implement", status: "ok", ms: 252_000, childRunId: "child-1" },
    ]);
    assert.equal(formatStepDurations(steps), "clone 3s, implement 4m 12s");
    assert.equal(formatStepDurations([]), null);
  });

  it("close writes summary.json: counts, metrics, step durations, the tree, and what listeners added", () => {
    const dir = runDir();
    const w = new JournalWriter(dir, { runId: "r" });
    w.append({ kind: "run.start", data: {} });
    w.append({ kind: "step.end", step: "clone", data: { status: "ok", ms: 1200 } });
    w.summarize("metrics", { tools: { read: { calls: 1 } } });
    w.close();
    const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    assert.equal(s.events, 2);
    assert.equal(s.lastSeq, 2);
    assert.deepEqual(s.kinds, { "run.start": 1, "step.end": 1 });
    assert.deepEqual(s.steps, [{ step: "clone", status: "ok", ms: 1200 }]);
    assert.deepEqual(s.listeners, { metrics: { tools: { read: { calls: 1 } } } });
    assert.equal(s.clipped, false);
    assert.equal(s.metrics.turns, 0);
  });
});

describe("commit trailers from the journal", () => {
  it("Builder, Builder-Version, Step-Durations and the agent's metrics", () => {
    const job: Job = {
      runId: "r",
      jobId: "job-1",
      dispatch: { requires: [], repo: { url: "/repo", base: "abc" }, task: { sliceId: "s", title: "T", context: "C", handover: false, attempt: 1 }, slice: null, callback: "http://x/jobs/job-1" },
      startedAt: Date.now() - 5000,
      deadline: Date.now() + 60_000,
      builder: { name: "supabase-api", version: "0123456789abcdef0123" },
    };
    const msg = commitMessage(
      job,
      { pi: { provider: "p", model: "m", thinking: "low" }, metrics: { turns: 4, toolCalls: 9, toolErrors: 2, tokens: { input: 12_345, output: 678, cacheRead: 1_500_000 }, cost: 0.1234, model: "p/m", durationMs: 61_000 } },
      [
        { step: "clone", ms: 3000 },
        { step: "implement", ms: 252_000 },
      ],
    );
    for (const line of ["Builder: supabase-api", "Builder-Version: 0123456789ab", "Agent-Duration: 1m 01s", "Agent-Turns: 4", "Agent-Tool-Calls: 9 (2 errors)", "Agent-Tokens: input 12k, cache read 1.5M, output 678", "Agent-Cost: $0.1234", "Step-Durations: clone 3s, implement 4m 12s"]) {
      assert.ok(msg.split("\n").includes(line), `${line}\n---\n${msg}`);
    }
  });
});

describe("who has a journal", () => {
  it("an agent run started directly has none unless its spec says journal: true; with one, pi gets shared:journal and its socket", async () => {
    const pi = fakePi(
      tmp.dir,
      "journal-pi",
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.BUILDER_RUN_DIR + "/seen.json", JSON.stringify({ argv: process.argv.slice(2), sock: process.env.BUILDER_JOURNAL_SOCK ?? null, fallback: process.env.BUILDER_JOURNAL_FALLBACK ?? null }));
writeFileSync(process.env.BUILDER_DONE_FILE, "{}");
`,
    );
    const agentics = writeTree(join(tmp.dir, "agentics-direct"), { "agents/solo/agent.yml": "description: solo\nmode: headless\ntools: { enable: [outcome] }\n" });
    const rt = createRuntime({ runsDir: join(tmp.dir, "runs-direct"), piCommand: pi, agenticsDir: agentics });
    const plain = await rt.start({ agent: "solo", input: { message: "go" } });
    assert.equal(plain.journal, false);
    assert.equal((await rt.wait(plain.id)).outcome, "done");
    assert.ok(!existsSync(join(rt.dir(plain.id), "journal.jsonl")));
    const seenPlain = JSON.parse(readFileSync(join(rt.dir(plain.id), "seen.json"), "utf8"));
    assert.deepEqual([seenPlain.sock, seenPlain.fallback, seenPlain.argv.includes(JOURNAL_EXTENSION)], [null, null, false]);

    const journaled = await rt.start({ agent: "solo", input: { message: "go" }, journal: true });
    assert.equal(journaled.journal, true);
    assert.equal((await rt.wait(journaled.id)).outcome, "done");
    const dir = rt.dir(journaled.id);
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    assert.ok(seen.argv.includes(JOURNAL_EXTENSION));
    assert.equal(seen.fallback, join(dir, "journal.fallback.jsonl"));
    assert.ok(seen.sock, "the journal's socket");
    assert.ok(!existsSync(seen.sock), "closed when the run ended");
    assert.deepEqual(readJournal(dir).map((e) => e.kind), ["run.start", "agent.start", "run.end"]);
    assert.deepEqual(readJournal(dir, { kind: "run.end" })[0].data.state, "done");
    assert.ok(existsSync(join(dir, "summary.json")));
  });
});

describe("the runner's argv", () => {
  const resolved = (mode: Resolved["mode"], argv: string[]): Resolved => ({ mode, argv, cwd: "/", workspace: "none", tools: [], resources: [], env: {}, areas: {}, mayStart: [] });
  const off = ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes"];
  it("the journal loads first, the gate host after the agent's extensions; headless runs pi --mode json -p", () => {
    const headless = [...off, "--skill", "/s", "-e", "/x.ts", "-e", "/y.ts", "--prompt-template", "/p.md", "--tools", "read", "-p", "--", "go -e -p"];
    assert.deepEqual(runnerArgv(resolved("headless", headless), ["-e", "/journal.ts"], ["-e", "/gate-host.ts"]), [
      ...off,
      "-e",
      "/journal.ts",
      "--skill",
      "/s",
      "-e",
      "/x.ts",
      "-e",
      "/y.ts",
      "-e",
      "/gate-host.ts",
      "--prompt-template",
      "/p.md",
      "--tools",
      "read",
      "--mode",
      "json",
      "-p",
      "--",
      "go -e -p",
    ]);
    assert.deepEqual(runnerArgv(resolved("rpc", [...off, "--tools", "read", "--mode", "rpc"]), ["-e", "/j.ts"], ["-e", "/g.ts"]), [...off, "-e", "/j.ts", "-e", "/g.ts", "--tools", "read", "--mode", "rpc"]);
    assert.deepEqual(runnerArgv(resolved("interactive", [...off, "--", "hello"])), [...off, "--", "hello"]);
  });
});
