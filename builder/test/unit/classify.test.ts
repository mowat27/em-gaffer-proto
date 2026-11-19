/** engine/steps/classify.ts: the kind rules in their order, the verdict, the empty slice, and the sample dispatches. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyDispatch, EMPTY_SLICE, verdictOf } from "../../engine/steps/classify.ts";
import type { Dispatch } from "../../engine/types.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";

const task = { sliceId: "s1", title: "CreateClient", context: "Invoicing", handover: false, attempt: 1 };
const el = (title: string) => ({ id: title, title });
const d = (slice: unknown, changes?: unknown): Pick<Dispatch, "slice" | "changes" | "task"> => ({ slice, task, ...(changes !== undefined ? { changes: changes as Dispatch["changes"] } : {}) });

describe("classify", () => {
  it("applies the rules in order: webhook, translation, automation, state-view, state-change", () => {
    const kind = (slice: Record<string, unknown>) => classifyDispatch(d(slice)).kind;
    // sliceType wins over the elements for webhook and translation.
    assert.equal(kind({ sliceType: "WEBHOOK", commands: [el("C")], processors: [el("P")] }), "webhook");
    assert.equal(kind({ sliceType: "TRANSLATION", readmodels: [el("R")], processors: [el("P")] }), "translation");
    // processors win over read models and sliceType STATE_VIEW.
    assert.equal(kind({ sliceType: "STATE_VIEW", readmodels: [el("R")], processors: [el("P")] }), "automation");
    assert.equal(kind({ sliceType: "AUTOMATION", processors: [el("P")], commands: [el("C")] }), "automation");
    assert.equal(kind({ sliceType: "STATE_VIEW", readmodels: [el("R")], commands: [el("C")] }), "state-view", "STATE_VIEW even with commands");
    assert.equal(kind({ readmodels: [el("R")], screens: [el("S")] }), "state-view", "read models without commands");
    assert.equal(kind({ readmodels: [el("R")], commands: [el("C")] }), "state-change", "read models with commands and no sliceType");
    assert.equal(kind({ sliceType: "STATE_CHANGE", commands: [el("C")], events: [el("E")] }), "state-change");
    assert.equal(kind({ screens: [el("S")] }), "state-change", "default");
    assert.equal(kind({ sliceType: "webhook", events: [el("E")] }), "webhook", "sliceType case does not matter");
  });

  it("fails with the reason when there is no slice or nothing to build", () => {
    for (const slice of [null, undefined, "x", [], {}, { commands: [], events: [], readmodels: [], screens: [], processors: [] }, { title: "T", specifications: [{}] }]) {
      assert.throws(() => classifyDispatch(d(slice)), { message: EMPTY_SLICE }, JSON.stringify(slice));
    }
    assert.equal(EMPTY_SLICE, "the slice has no commands, events, read models, screens or processors");
  });

  it("verdict: CHANGED from changes.verdict, else NEW; context, slice and sliceType from the dispatch", () => {
    const slice = { sliceType: "STATE_CHANGE", commands: [el("C")] };
    assert.deepEqual(classifyDispatch(d(slice, { verdict: "CHANGED" })), { kind: "state-change", verdict: "CHANGED", context: "Invoicing", slice: "CreateClient", sliceType: "STATE_CHANGE" });
    assert.equal(classifyDispatch(d(slice, { verdict: "NEW" })).verdict, "NEW");
    assert.equal(classifyDispatch(d(slice)).verdict, "NEW", "no changes");
    assert.equal(classifyDispatch(d(slice, null)).verdict, "NEW");
    assert.equal(verdictOf({ changes: { verdict: "changed" } }), "CHANGED");
    assert.equal(verdictOf({ changes: { verdict: "UNCHANGED" } }), "NEW");
    assert.equal(classifyDispatch(d({ commands: [el("C")] })).sliceType, null);
  });

  it("the sample dispatches: STATE_CHANGE slices are state-change, STATE_VIEW slices state-view, with their verdicts", () => {
    const dir = join(AGENTICS_DIR, "shared", "data", "dispatches");
    const seen: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "board.json").sort()) {
      const dispatch = JSON.parse(readFileSync(join(dir, f), "utf8")) as Dispatch;
      const c = classifyDispatch(dispatch);
      const name = f.replace(/\.json$/, "");
      assert.equal(c.kind, (dispatch.slice as { sliceType: string }).sliceType === "STATE_VIEW" ? "state-view" : "state-change", name);
      assert.equal(c.verdict, name.endsWith("-changed") ? "CHANGED" : "NEW", name);
      seen.push(name);
    }
    assert.ok(seen.length >= 10, `${seen.length} sample dispatches`);
  });
});
