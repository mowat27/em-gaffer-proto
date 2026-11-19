/** The step walker: order, the context between steps, the first failure ends the workflow, budgets and the deadline. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ContextStore } from "../../engine/context.ts";
import { validateBuilder } from "../../engine/load.ts";
import type { ScaffoldReport } from "../../engine/templates.ts";
import type { Builder, Job, StepContext } from "../../engine/types.ts";
import { code, defineBuilder, runWorkflow, template, workflow } from "../../engine/workflow.ts";
import type { Runtime } from "../../runtime/types.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-workflow");
after(() => tmp.remove());
let n = 0;

function setup(o: { deadlineMs?: number; signal?: AbortSignal } = {}) {
  const runDir = join(tmp.dir, `run-${++n}`);
  const store = new ContextStore(join(runDir, "context"));
  const startedAt = Date.now();
  const job: Job = {
    runId: `run-${n}`,
    jobId: `job-${n}`,
    dispatch: { requires: [], repo: { url: "/r", base: "abc1234" }, task: { sliceId: "s", title: "T", context: "C", handover: false, attempt: 1 }, slice: null, callback: "http://x/jobs/j" },
    startedAt,
    deadline: startedAt + (o.deadlineMs ?? 60_000),
  };
  const events: string[] = [];
  const opts = {
    job,
    dir: runDir,
    store,
    runtime: {} as Runtime,
    signal: o.signal ?? new AbortController().signal,
    log: () => {},
    emit: (kind: string) => void events.push(kind),
  };
  return { opts, store, events, runDir };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("runWorkflow", () => {
  it("runs the steps in order; each later step reads the earlier outputs through ctx.get", async () => {
    const order: string[] = [];
    const b = defineBuilder({
      name: "t",
      provides: [],
      steps: [
        code("one", async () => (order.push("one"), { n: 1 })),
        code("two", async (ctx) => (order.push("two"), { prev: ctx.get<{ n: number }>("one").n + 1 })),
        code("three", async (ctx) => {
          order.push("three");
          assert.throws(() => ctx.get("four"), /step four has not finished/);
          return { prev: ctx.get<{ prev: number }>("two").prev + 1 };
        }),
        code("four", async () => void order.push("four")),
      ],
    });
    const { opts, store, events } = setup();
    const steps: string[] = [];
    const result = await runWorkflow(b, { ...opts, onStep: (s) => steps.push(s) });
    assert.deepEqual(result, { outcome: "done" });
    assert.deepEqual(order, ["one", "two", "three", "four"]);
    assert.deepEqual(steps, ["one", "two", "three", "four"]);
    assert.deepEqual(store.get("three"), { prev: 3 });
    assert.equal(store.get("four"), null);
    assert.deepEqual(events.filter((e) => e.startsWith("step.")), ["step.start", "step.end", "step.start", "step.end", "step.start", "step.end", "step.start", "step.end"]);
  });

  it("the first failing step ends the workflow with its reason: later steps never run and the failed step stores nothing", async () => {
    const ran: string[] = [];
    const b = defineBuilder({
      name: "t",
      provides: [],
      steps: [
        code("ok", async () => (ran.push("ok"), { fine: true })),
        code("broken", async () => {
          ran.push("broken");
          throw new Error("target repository is not set up: tsconfig.json missing at base abc");
        }),
        code("never", async () => (ran.push("never"), {})),
      ],
    });
    const { opts, store } = setup();
    const result = await runWorkflow(b, opts);
    assert.deepEqual(result, { outcome: "failed", reason: "target repository is not set up: tsconfig.json missing at base abc" });
    assert.deepEqual(ran, ["ok", "broken"]);
    assert.ok(store.has("ok"));
    assert.equal(store.has("broken"), false);
    assert.equal(store.has("never"), false);
  });

  it("an output that is not JSON fails its step", async () => {
    const b = defineBuilder({ name: "t", provides: [], steps: [code("fn", async () => ({ run: () => 1 })), code("after", async () => ({}))] });
    const { opts, store } = setup();
    const result = await runWorkflow(b, opts);
    assert.equal(result.outcome, "failed");
    assert.match((result as { reason: string }).reason, /the output of step fn\.run is not JSON/);
    assert.equal(store.has("after"), false);
  });

  it("collects each repository's patch from the step outputs into the result", async () => {
    const b = defineBuilder({ name: "t", provides: [], steps: [code("commit", async () => ({ patches: { app: "From abc\n" }, commits: 1 }))] });
    const { opts } = setup();
    assert.deepEqual(await runWorkflow(b, opts), { outcome: "done", patches: { app: "From abc\n" } });
  });

  it("the job deadline is a hard cap: a step still running at the deadline fails the job naming the step", async () => {
    let sawAbort = false;
    const b = defineBuilder({
      name: "t",
      provides: [],
      steps: [
        code("slow", async (ctx) => {
          ctx.signal.addEventListener("abort", () => (sawAbort = true));
          await sleep(3000);
          return {};
        }),
      ],
    });
    const { opts } = setup({ deadlineMs: 300 });
    const t0 = Date.now();
    const result = await runWorkflow(b, opts);
    assert.deepEqual(result, { outcome: "failed", reason: "job exceeded 0 min during slow" });
    assert.ok(Date.now() - t0 < 2000, "the engine waited for the step");
    assert.ok(sawAbort, "the step's signal did not abort");
  });

  it("a code step's own budget aborts it", async () => {
    const b = defineBuilder({ name: "t", provides: [], steps: [code("slow", () => sleep(3000).then(() => ({})), { budgetMinutes: 0.005 })] });
    const { opts } = setup();
    assert.deepEqual(await runWorkflow(b, opts), { outcome: "failed", reason: "step slow exceeded its budget of 0.005 min" });
  });

  it("stopping the run aborts the current step and runs no more", async () => {
    const stop = new AbortController();
    const ran: string[] = [];
    const b = defineBuilder({
      name: "t",
      provides: [],
      steps: [
        code("long", async (ctx: StepContext) => {
          ran.push("long");
          setTimeout(() => stop.abort(new Error("parent ended")), 100);
          await sleep(3000);
          return ctx.dir;
        }),
        code("next", async () => (ran.push("next"), {})),
      ],
    });
    const { opts } = setup({ signal: stop.signal });
    assert.deepEqual(await runWorkflow(b, opts), { outcome: "failed", reason: "parent ended" });
    assert.deepEqual(ran, ["long"]);
  });

  it("a template step renders its set into its dir, stores the report and journals scaffold.file per file and injection", async () => {
    const set = writeTree(join(tmp.dir, `set-${++n}`, "state-change"), {
      "src/{{name}}.ts.hbs": "export const {{name}} = 1; // BUILD: more\n",
      "injections/index.hbs": "---\ntarget: 'src/index.ts'\nanchor: '// slices'\nkey: \"./{{name}}\"\n---\nexport * from './{{name}}';\n",
    });
    const b = defineBuilder({
      name: "t",
      provides: [],
      steps: [
        code("prepare", async (ctx) => (writeTree(join(ctx.dir, "app"), { "src/index.ts": "// slices\n" }), { appDir: join(ctx.dir, "app") })),
        template("scaffold", { set: () => set, data: () => ({ name: "thing" }), dir: (ctx) => ctx.get<{ appDir: string }>("prepare").appDir }),
        code("after", async (ctx) => ({ files: ctx.get<ScaffoldReport>("scaffold").files.length })),
      ],
    });
    const { opts, store, runDir } = setup();
    const journaled: { kind: string; data: Record<string, unknown> }[] = [];
    const result = await runWorkflow(b, { ...opts, journal: { append: (e) => (journaled.push(e as { kind: string; data: Record<string, unknown> }), null) } });
    assert.deepEqual(result, { outcome: "done" });
    const report = store.get<ScaffoldReport>("scaffold");
    assert.equal(report.kind, "state-change");
    assert.equal(report.verdict, "NEW");
    assert.deepEqual(report.files, [{ path: "src/thing.ts", action: "created" }]);
    assert.deepEqual(report.injections, [{ target: "src/index.ts", key: "./thing", action: "inserted" }]);
    assert.deepEqual(report.markers, [{ path: "src/thing.ts", line: 1, text: "export const thing = 1; // BUILD: more" }]);
    assert.equal(readFileSync(join(runDir, "app", "src", "index.ts"), "utf8"), "// slices\nexport * from './thing';\n");
    assert.deepEqual(store.get("after"), { files: 1 });
    const files = journaled.filter((e) => e.kind === "scaffold.file").map((e) => [e.data.path, e.data.action]);
    assert.deepEqual(files, [["src/thing.ts", "created"], ["src/index.ts", "inserted"]]);
  });

  it("a template step never fails the job: no set, a view model that throws or a render error skip it with scaffold.skipped", async () => {
    const broken = writeTree(join(tmp.dir, `set-${++n}`, "state-view"), { "x.ts.hbs": "{{nope}}\n" });
    const cases: [string, Parameters<typeof template>[1], RegExp][] = [
      ["no set", { set: () => join(tmp.dir, "no-such-set", "automation"), data: () => ({}) }, /^no template set for automation$/],
      ["view model throws", { set: () => broken, data: () => { throw new Error("no view model for state-view slices"); } }, /^the view model failed: no view model for state-view slices$/],
      ["render error", { set: () => broken, data: () => ({}) }, /^render error: x\.ts\.hbs: "nope" not defined/],
      ["set throws", { set: () => { throw new Error("step classify has not finished"); }, data: () => ({}) }, /^step classify has not finished$/],
    ];
    for (const [what, opts, reason] of cases) {
      const b = defineBuilder({ name: "t", provides: [], steps: [template("scaffold", opts), code("next", async () => ({ ran: true }))] });
      const { opts: o, store, runDir } = setup();
      const journaled: { kind: string; data: Record<string, unknown> }[] = [];
      assert.deepEqual(await runWorkflow(b, { ...o, journal: { append: (e) => (journaled.push(e as { kind: string; data: Record<string, unknown> }), null) } }), { outcome: "done" }, what);
      const report = store.get<ScaffoldReport>("scaffold");
      assert.match(report.skipped?.reason ?? "", reason, what);
      assert.deepEqual([report.files, report.injections, report.tasks, report.markers], [[], [], [], []], what);
      assert.match(String(journaled.find((e) => e.kind === "scaffold.skipped")?.data.reason), reason, what);
      assert.deepEqual(store.get("next"), { ran: true }, what);
      assert.equal(existsSync(join(runDir, "x.ts")), false, `${what}: nothing written`);
    }
  });

  it("a workflow step that names a missing builder fails with why", async () => {
    const b = defineBuilder({ name: "t", provides: [], steps: [workflow("inner", join(tmp.dir, "nope.ts"))] });
    const { opts } = setup();
    const result = await runWorkflow(b, opts);
    assert.equal(result.outcome, "failed");
    assert.match((result as { reason: string }).reason, /^no builder module at /);
  });
});

describe("validateBuilder", () => {
  const valid = (): Builder => ({ name: "b", provides: ["stack:stub"], steps: [code("a", async () => ({}))] });
  it("accepts a valid builder", () => assert.ok(validateBuilder(valid())));
  for (const [what, change, error] of [
    ["no name", (b: Record<string, unknown>) => delete b.name, /name must be a non-empty string/],
    ["provides not a string array", (b: Record<string, unknown>) => (b.provides = "stack:stub"), /provides must be a string array/],
    ["no steps", (b: Record<string, unknown>) => (b.steps = []), /steps must be a non-empty array/],
    ["an unknown step kind", (b: Record<string, unknown>) => (b.steps = [{ kind: "magic", name: "x" }]), /kind must be one of/],
    ["a step name used twice", (b: Record<string, unknown>) => (b.steps = [code("a", async () => 1), code("a", async () => 2)]), /used twice/],
    ["a code step without run", (b: Record<string, unknown>) => (b.steps = [{ kind: "code", name: "a" }]), /needs a run function/],
    ["a template step without data", (b: Record<string, unknown>) => (b.steps = [{ kind: "template", name: "s", set: () => "x" }]), /needs a data function/],
  ] as const) {
    it(`refuses ${what}`, () => {
      const b = valid() as unknown as Record<string, unknown>;
      change(b);
      assert.throws(() => validateBuilder(b), error);
    });
  }
  it("refuses something that is not an object", () => assert.throws(() => validateBuilder(undefined), /not a builder object/));
});
