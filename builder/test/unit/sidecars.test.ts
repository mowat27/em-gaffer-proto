/**
 * Sidecars (engine/sidecars.ts) in process, on a fake runtime: the rule and its validation in a builder, the batch as
 * the sidecar's input, one run every `every` matching events, coalescing while a run is live, job end (no new batch,
 * the grace, then a stop), a failing sidecar logged and switched off after 3 failures in a row, and the definitions
 * check that a sidecar's agent exists. Real pi on the fake LLM is in sidecars-e2e.test.ts.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateBuilder } from "../../engine/load.ts";
import type { ListenerApi } from "../../engine/listeners.ts";
import { batchItem, batchText, preview, rangeOf, sidecar, SidecarHost, type Sidecar } from "../../engine/sidecars.ts";
import { affectsOf, checkBuilder, inspectTree } from "../../ops/definitions/validate.ts";
import type { JournalEvent } from "../../runtime/journal.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import type { RunRecord, RunResult, RunSpec } from "../../runtime/types.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-sidecars");
after(() => tmp.remove());

let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}, extra: Partial<JournalEvent> = {}): JournalEvent => ({ seq: ++seq, ts: new Date().toISOString(), runId: "child-1", step: "implement", kind, data, ...extra });
const toolEnd = (tool: string, extra: Record<string, unknown> = {}, span?: string) => ev("tool.end", { tool, isError: false, outcome: "ok", output: `${tool} output`, ...extra }, span ? { span } : {});

/** A runtime whose runs end when the test says so. */
function fakeRuntime() {
  const started: { id: string; spec: RunSpec; parent?: string; end: (r: RunResult) => void; result: Promise<RunResult> }[] = [];
  const stopped: string[] = [];
  let n = 0;
  return {
    started,
    stopped,
    failStart: null as string | null,
    async start(spec: RunSpec, opts: { parent?: string } = {}): Promise<RunRecord> {
      if (this.failStart) throw new Error(this.failStart);
      const id = `sc-${++n}`;
      let end!: (r: RunResult) => void;
      const result = new Promise<RunResult>((r) => (end = r));
      started.push({ id, spec, ...(opts.parent ? { parent: opts.parent } : {}), end, result });
      return { id, parent: opts.parent ?? null, kind: "agent", spec, state: "running", pid: 1, startedAt: new Date().toISOString() };
    },
    wait(id: string): Promise<RunResult> {
      return started.find((s) => s.id === id)!.result;
    },
    async stop(id: string, reason = "stopped"): Promise<void> {
      stopped.push(id);
      started.find((s) => s.id === id)?.end({ outcome: "failed", reason });
    },
  };
}

/** A listener api that records what the sidecar journals, writes and sums up. */
function recordingApi() {
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const artifacts: Record<string, string> = {};
  const summaries: Record<string, unknown>[] = [];
  const api: ListenerApi = {
    emit: (kind, data) => void events.push({ kind, data }),
    artifact: (name, content) => void (artifacts[name] = content),
    summary: (data) => void summaries.push(data),
  };
  return { api, events, artifacts, summaries, kinds: () => events.map((e) => e.kind) };
}

function host(rules: Sidecar[]) {
  const rt = fakeRuntime();
  const log: string[] = [];
  const h = new SidecarHost({ runtime: rt, runId: "wf-1", sidecars: rules, log: (t) => void log.push(t) });
  const [l] = h.listeners();
  const rec = recordingApi();
  const feed = (e: JournalEvent) => l.listener.handle(e, rec.api);
  return { rt, log, h, l, rec, feed };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("sidecar rules", () => {
  it("sidecar() is plain data with defaults; bad rules throw; a builder validates them", () => {
    const s = sidecar("tool-summariser", { on: "tool.end", every: 10 });
    assert.deepEqual(s, { agent: "tool-summariser", name: "sidecar-tool-summariser", on: "tool.end", every: 10, budgetMinutes: 2 });
    assert.equal(sidecar("dev/notes", { on: "*", every: 1 }).name, "sidecar-dev-notes");
    assert.throws(() => sidecar("x", { on: "tool.end", every: 0 }), /every must be a whole number/);
    assert.throws(() => sidecar("", { on: "tool.end", every: 1 }), /agent id is required/);
    assert.throws(() => sidecar("x", { on: "", every: 1 }), /on is required/);
    assert.throws(() => sidecar("x", { on: "tool.end", every: 1, name: "a b" }), /letters, digits/);
    const base = { name: "b", provides: [], steps: [{ kind: "code", name: "s", run: async () => null }] };
    assert.equal(validateBuilder({ ...base, sidecars: [s] }).sidecars?.length, 1);
    assert.throws(() => validateBuilder({ ...base, sidecars: "x" }), /sidecars must be an array/);
    assert.throws(() => validateBuilder({ ...base, sidecars: [{ agent: "x" }] }), /sidecars\[0\] is not a sidecar/);
    assert.throws(() => validateBuilder({ ...base, sidecars: [s, s] }), /used twice/);
  });

  it("the batch: previews only (a blob marker's preview), one line per call with its input, the oldest left out past the cap", () => {
    assert.equal(preview({ blob: "sha256:ab", bytes: 9000, preview: "the start of it" }), "the start of it");
    assert.equal(preview("a\n  b"), "a b");
    assert.equal(preview("x".repeat(300)).length, 200);
    const items = [batchItem(toolEnd("npm", { output: "1 failing" }, "t-1"), '{"args":["test"]}'), batchItem(ev("hint", { text: "look at it" }))];
    const text = batchText(items);
    assert.match(text, /^2 event\(s\) from run child-1 \(step implement\), oldest first:\n/);
    assert.match(text, /#\d+ npm \{"args":\["test"\]\} -> ok: 1 failing\n/);
    assert.match(text, /#\d+ hint \{"text":"look at it"\}$/);
    const many = Array.from({ length: 50 }, (_, i) => batchItem(toolEnd(`t${i}`, { output: "y".repeat(150) })));
    const capped = batchText(many, 2000);
    assert.ok(capped.length <= 2000);
    assert.match(capped, /\(\d+ earlier event\(s\) left out\)/);
    assert.match(capped, /#\d+ t49 /, "the newest are kept");
    const r = rangeOf(items);
    assert.deepEqual(r.range?.from, { runId: "child-1", seq: items[0].seq, span: "t-1" });
    assert.deepEqual(r.spans, ["t-1"]);
  });
});

describe("the sidecar host", () => {
  it("starts a run every `every` matching events with the batch, headless in no workspace under the workflow run, and journals its output", async () => {
    const { rt, rec, feed, h } = host([sidecar("tool-summariser", { on: "tool.end", every: 3 })]);
    feed(ev("tool.start", { tool: "read", input: { path: "src/a.ts" } }, { span: "t-1" }));
    feed(toolEnd("read", {}, "t-1"));
    feed(ev("turn.end", { turn: 1 }));
    feed(toolEnd("write"));
    assert.equal(rt.started.length, 0, "two matching events: no run yet");
    feed(toolEnd("npm", { isError: true, outcome: "error", output: "tsc failed" }));
    assert.equal(rt.started.length, 1);
    const run = rt.started[0];
    assert.equal(run.parent, "wf-1");
    assert.deepEqual({ ...run.spec, input: undefined }, { agent: "tool-summariser", mode: "headless", workspace: "none", input: undefined, budgetMinutes: 2 });
    const batch = String(run.spec.input?.args?.[0]);
    assert.match(batch, /^3 event\(s\)/);
    assert.match(batch, /read \{"path":"src\/a\.ts"\} -> ok: read output/, "a tool.end carries its call's input");
    assert.match(batch, /npm -> error: tsc failed/);
    assert.doesNotMatch(batch, /turn\.end/);
    await tick();
    assert.deepEqual(rec.kinds(), ["sidecar.start"]);
    assert.equal(rec.events[0].data.sidecarRunId, run.id, "named sidecarRunId: never followed as a child");
    run.end({ outcome: "done", data: { output: "Read a.ts, wrote a file.\nnpm test failed in tsc." } });
    await waitFor("sidecar.end", () => (rec.kinds().includes("sidecar.end") ? true : undefined), 2000, 5);
    assert.deepEqual(rec.kinds(), ["sidecar.start", "sidecar.output", "sidecar.end"]);
    const out = rec.events[1].data;
    assert.equal(out.text, "Read a.ts, wrote a file.\nnpm test failed in tsc.");
    assert.equal(out.events, 3);
    assert.deepEqual(out.spans, ["t-1"]);
    assert.ok(out.range && typeof out.range === "object");
    assert.match(rec.artifacts["batch-1.md"], /^# sidecar-tool-summariser, batch 1\n/);
    assert.match(rec.artifacts["batch-1.md"], /npm test failed in tsc\./);
    assert.equal(rec.events[2].data.status, "done");
    await h.finish(0);
    assert.deepEqual(rec.summaries.at(-1), { agent: "tool-summariser", batches: 1, done: 1, failed: 0, stopped: 0, outputs: 1, events: 3, pending: 0 });
  });

  it("one instance: events arriving while it runs are coalesced into the next batch, which starts when it ends", async () => {
    const { rt, feed, h } = host([sidecar("s", { on: "tool.end", every: 2 })]);
    feed(toolEnd("a"));
    feed(toolEnd("b"));
    assert.equal(rt.started.length, 1);
    for (const t of ["c", "d", "e"]) feed(toolEnd(t));
    assert.equal(rt.started.length, 1, "still one instance");
    rt.started[0].end({ outcome: "done", data: { output: "ok" } });
    await waitFor("the next batch", () => (rt.started.length === 2 ? true : undefined), 2000, 5);
    const second = String(rt.started[1].spec.input?.args?.[0]);
    assert.match(second, /^3 event\(s\)/, "c, d and e in one batch");
    rt.started[1].end({ outcome: "done", data: { output: "ok" } });
    feed(toolEnd("f"));
    await tick();
    assert.equal(rt.started.length, 2, "one event short of a batch");
    await h.finish(0);
  });

  it("job end: no batch starts after close; a running sidecar gets its grace, then it is stopped (E7)", async () => {
    const { rt, rec, feed, h } = host([sidecar("s", { on: "tool.end", every: 1 })]);
    feed(toolEnd("a"));
    assert.equal(rt.started.length, 1);
    feed(toolEnd("b"));
    h.close();
    const t0 = Date.now();
    await h.finish(300);
    const ms = Date.now() - t0;
    assert.ok(ms >= 250 && ms < 3000, `waited about the grace (${ms} ms)`);
    assert.deepEqual(rt.stopped, ["sc-1"]);
    assert.equal(rt.started.length, 1, "the pending event started no batch after the job ended");
    const end = rec.events.find((e) => e.kind === "sidecar.end")!;
    assert.equal(end.data.status, "stopped");
    assert.match(String(end.data.reason), /job ended: sidecar-s stopped after its 0 s grace/);
    assert.deepEqual(rec.summaries.at(-1), { agent: "s", batches: 1, done: 0, failed: 0, stopped: 1, outputs: 0, events: 1, pending: 1 });
    // A sidecar that finishes within its grace is not stopped.
    const b = host([sidecar("s", { on: "tool.end", every: 1 })]);
    b.feed(toolEnd("a"));
    setTimeout(() => b.rt.started[0].end({ outcome: "done", data: { output: "fine" } }), 50);
    await b.h.finish(5000);
    assert.deepEqual(b.rt.stopped, []);
    assert.deepEqual(b.rec.kinds(), ["sidecar.start", "sidecar.output", "sidecar.end"]);
  });

  it("a failing sidecar is logged and ignored, and switched off after 3 failures in a row", async () => {
    const { rt, rec, feed, log, h } = host([sidecar("s", { on: "tool.end", every: 1 })]);
    rt.failStart = "no agent s";
    for (let i = 0; i < 2; i++) {
      feed(toolEnd(`a${i}`));
      await waitFor(`failure ${i + 1}`, () => (rec.kinds().filter((k) => k === "sidecar.end").length === i + 1 ? true : undefined), 2000, 5);
    }
    assert.equal(rec.events[0].data.status, "failed");
    assert.match(String(rec.events[0].data.reason), /could not start: no agent s/);
    rt.failStart = null;
    feed(toolEnd("b"));
    await waitFor("a run", () => (rt.started.length === 1 ? true : undefined), 2000, 5);
    rt.started[0].end({ outcome: "failed", reason: "pi exited 1" });
    await waitFor("off", () => (rec.kinds().includes("sidecar.off") ? true : undefined), 2000, 5);
    assert.ok(log.some((l) => /sidecar-s is off for this job after 3 failures in a row/.test(l)));
    feed(toolEnd("c"));
    await tick();
    assert.equal(rt.started.length, 1, "an off sidecar starts nothing");
    await h.finish(0);
    assert.equal((rec.summaries.at(-1) as { off?: boolean }).off, true);
  });

  it("match narrows what is counted, as a listener's does", async () => {
    const { rt, feed, h } = host([sidecar("s", { on: "tool.end", every: 2, match: { tool: "npm" } })]);
    feed(toolEnd("read"));
    feed(toolEnd("npm"));
    feed(toolEnd("write"));
    assert.equal(rt.started.length, 0);
    feed(toolEnd("npm"));
    assert.equal(rt.started.length, 1);
    await h.finish(0);
  });
});

describe("definitions: a builder's sidecars", () => {
  it("supabase-api's sidecar names tool-summariser, which resolves; a change to that agent affects the builder; a missing agent is an error", async () => {
    const tree = { builderRoot: BUILDER, agentics: AGENTICS_DIR };
    const b = await checkBuilder("supabase-api", tree);
    assert.equal(b.ok, true, b.error);
    assert.deepEqual(b.sidecars, [{ name: "sidecar-tool-summariser", agent: "tool-summariser" }]);
    const info = await inspectTree(tree);
    assert.equal(info.agents.get("tool-summariser")?.ok, true, info.agents.get("tool-summariser")?.error);
    const affects = affectsOf({ kind: "agent", id: "tool-summariser", path: join(AGENTICS_DIR, "agents", "tool-summariser"), single: false, agentics: AGENTICS_DIR }, info);
    assert.ok(affects.builders.includes("supabase-api"), JSON.stringify(affects));

    const agentics = join(tmp.dir, "agentics");
    writeTree(agentics, { "builders/odd/builder.ts": "" });
    writeFileSync(
      join(agentics, "builders", "odd", "builder.ts"),
      `import { code, defineBuilder } from ${JSON.stringify(pathToFileURL(join(BUILDER, "engine", "workflow.ts")).href)};
import { sidecar } from ${JSON.stringify(pathToFileURL(join(BUILDER, "engine", "sidecars.ts")).href)};
export default defineBuilder({ name: "odd", provides: [], steps: [code("s", async () => null)], sidecars: [sidecar("nobody", { on: "tool.end", every: 5 })] });
`,
    );
    const odd = await checkBuilder("odd", { builderRoot: BUILDER, agentics });
    assert.equal(odd.ok, false);
    assert.match(odd.error ?? "", /sidecar sidecar-nobody names agent nobody, which does not exist/);
  });
});
