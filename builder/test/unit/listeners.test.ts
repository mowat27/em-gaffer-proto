/**
 * Listeners: which events a listener gets, that it runs off the step path, that one that keeps throwing is switched
 * off after three errors (E10), what its API can do, following a child run's journal, loading the shared listeners,
 * and a builder's listeners being checked when it loads.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { defineListener, ListenerHost, matches, sharedListeners, type Listener } from "../../engine/listeners.ts";
import { validateBuilder } from "../../engine/load.ts";
import { code } from "../../engine/workflow.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import { JournalWriter, readJournal, type JournalEvent } from "../../runtime/journal.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-listeners");
after(() => tmp.remove());
let n = 0;

/** A workflow run's journal with a listener host attached, as the engine wires them. */
function setup(listeners: Listener[], pollMs = 20) {
  const runDir = join(tmp.dir, "runs", `wf-${++n}`);
  mkdirSync(runDir, { recursive: true });
  const journal = new JournalWriter(runDir, { runId: `wf-${n}` });
  const logged: string[] = [];
  const host = new ListenerHost({ journal, runDir, listeners: listeners.map((listener, i) => ({ name: listener.name ?? `l${i}`, listener })), log: (t) => logged.push(t), pollMs });
  journal.onEvent = (e) => host.observe(e);
  return { runDir, journal, host, logged };
}

const event = (kind: string, data: Record<string, unknown> = {}, more: Partial<JournalEvent> = {}): JournalEvent => ({ seq: 1, ts: "2026-11-17T10:00:00.000Z", runId: "r", kind, data, ...more });

describe("listeners", () => {
  it("matches: a kind, a kind prefix or every kind, and match on the event's own fields or its data", () => {
    const l = (on: string, match?: Record<string, unknown>) => defineListener({ on, ...(match ? { match } : {}), handle: () => {} });
    assert.ok(matches(l("tool.end"), event("tool.end")));
    assert.ok(!matches(l("tool.end"), event("tool.start")));
    assert.ok(matches(l("tool.*"), event("tool.gate")));
    assert.ok(matches(l("*"), event("anything")));
    assert.ok(matches(l("tool.end", { tool: "npm", isError: true }), event("tool.end", { tool: "npm", isError: true })));
    assert.ok(!matches(l("tool.end", { tool: "npm", isError: true }), event("tool.end", { tool: "npm", isError: false })));
    assert.ok(matches(l("*", { step: "implement" }), event("turn.end", {}, { step: "implement" })));
  });

  it("never on the step path: append returns before any listener runs", async () => {
    const seen: string[] = [];
    const { journal, host } = setup([defineListener({ on: "*", handle: (e) => void seen.push(e.kind) })]);
    journal.append({ kind: "step.start", data: {} });
    assert.deepEqual(seen, [], "not handled synchronously");
    await host.finish(1000);
    assert.deepEqual(seen, ["step.start"]);
  });

  it("E10: a listener that throws is logged and journaled, and switched off after three errors; the others keep going", async () => {
    let calls = 0;
    const counted: number[] = [];
    const { journal, host, logged, runDir } = setup([
      defineListener({
        name: "boom",
        on: "tool.end",
        handle: async () => {
          calls++;
          throw new Error(`boom ${calls}`);
        },
      }),
      defineListener({ name: "fine", on: "tool.end", handle: (e) => void counted.push(Number(e.data.i)) }),
    ]);
    for (let i = 1; i <= 5; i++) journal.append({ kind: "tool.end", data: { i } });
    await host.finish(1000);
    assert.equal(calls, 3, "off after the third error");
    assert.deepEqual(counted, [1, 2, 3, 4, 5]);
    const errors = readJournal(runDir, { kind: "listener.error" });
    assert.deepEqual(errors.map((e) => [e.data.listener, e.data.error, e.data.errors]), [
      ["boom", "boom 1", 1],
      ["boom", "boom 2", 2],
      ["boom", "boom 3", 3],
    ]);
    assert.deepEqual(readJournal(runDir, { kind: "listener.off" }).map((e) => e.data), [{ listener: "boom", errors: 3 }]);
    assert.equal(logged.filter((l) => l.includes("listener boom failed")).length, 3);
  });

  it("the API: emit to the journal (never back to listeners), write an artifact, add to summary.json", async () => {
    const got: string[] = [];
    const { journal, host, runDir } = setup([
      defineListener({
        name: "helper",
        on: "tool.end",
        handle: (e, api) => {
          api.emit("hint", { text: `npm failed: ${String(e.data.output)}` });
          api.artifact("last.txt", String(e.data.output));
          api.summary({ seen: 1 });
          assert.throws(() => api.artifact("../escape", "x"), /letters, digits/);
        },
      }),
      defineListener({ name: "all", on: "*", handle: (e) => void got.push(e.kind) }),
    ]);
    journal.append({ kind: "tool.end", data: { tool: "npm", isError: true, output: "ERR!" } });
    await host.finish(1000);
    assert.deepEqual(readJournal(runDir, { kind: "hint" }).map((e) => e.data), [{ text: "npm failed: ERR!", listener: "helper" }]);
    assert.equal(readFileSync(join(runDir, "artifacts", "helper", "last.txt"), "utf8"), "ERR!");
    assert.equal(readJournal(runDir, { kind: "listener.artifact" })[0].data.name, "last.txt");
    assert.deepEqual(got, ["tool.end"], "listener events do not reach listeners");
    journal.close();
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")).listeners, { helper: { seen: 1 } });
  });

  it("follows a child run's journal from the step event that names it, and reads the rest at finish", async () => {
    const seen: string[] = [];
    const { journal, host, runDir } = setup([defineListener({ on: "tool.*", handle: (e) => void seen.push(`${e.runId}:${e.kind}:${String(e.data.tool)}`) })]);
    const childDir = join(dirname(runDir), "child-run");
    const child = new JournalWriter(childDir, { runId: "child-run", step: "implement" });
    journal.append({ kind: "step.start", step: "implement", data: { childRunId: "child-run" } });
    child.append({ kind: "tool.start", data: { tool: "ls" } });
    await waitFor("the child's first event", () => (seen.length === 1 ? true : undefined), 5000, 20);
    child.append({ kind: "tool.end", data: { tool: "ls" } });
    await host.finish(1000);
    assert.deepEqual(seen, ["child-run:tool.start:ls", "child-run:tool.end:ls"]);
  });

  it("shared listeners load from agentics/shared/listeners, named after their files; a broken one is an error", async () => {
    const real = await sharedListeners(AGENTICS_DIR);
    assert.deepEqual(real.map((l) => l.name), ["metrics"]);
    const broken = writeTree(join(tmp.dir, "agentics-broken"), { "shared/listeners/bad.ts": "export default { nope: true };\n" });
    await assert.rejects(sharedListeners(broken), /shared\/listeners\/bad\.ts: its default export is not a listener/);
    assert.deepEqual(await sharedListeners(join(tmp.dir, "nowhere")), []);
  });

  it("the metrics listener keeps totals per step and tool in summary.json", async () => {
    const [{ listener }] = await sharedListeners(AGENTICS_DIR);
    const { journal, host, runDir } = setup([listener]);
    journal.append({ kind: "tool.end", step: "implement", data: { tool: "read", isError: false, ms: 5 } });
    journal.append({ kind: "tool.end", step: "implement", data: { tool: "read", isError: true, ms: 7 } });
    journal.append({ kind: "turn.end", step: "implement", data: {} });
    journal.append({ kind: "model.usage", step: "implement", data: { input: 10, output: 2, cacheRead: 3, cost: 0.5 } });
    journal.append({ kind: "step.end", step: "implement", data: { status: "ok", ms: 1000 } });
    await host.finish(1000);
    journal.close();
    const m = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")).listeners.metrics;
    assert.deepEqual(m.steps.implement, { turns: 1, toolCalls: 2, toolErrors: 1, tokens: { input: 10, output: 2, cacheRead: 3 }, cost: 0.5, status: "ok", ms: 1000 });
    assert.deepEqual(m.tools.read, { calls: 2, errors: 1, ms: 12 });
  });

  it("a builder's listeners are checked when it loads", () => {
    const b = { name: "b", provides: [], steps: [code("a", async () => ({}))] };
    assert.ok(validateBuilder({ ...b, listeners: [defineListener({ on: "tool.end", handle: () => {} })] }));
    assert.throws(() => validateBuilder({ ...b, listeners: {} }), /listeners must be an array/);
    assert.throws(() => validateBuilder({ ...b, listeners: [{ on: "tool.end" }] }), /listeners\[0\] is not a listener/);
  });
});
