/** The context store: write once, JSON only, and a step's output is readable only once the step has finished. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertJson, ContextStore } from "../../engine/context.ts";
import { tempDir } from "../harness/util.ts";

const tmp = tempDir("builder-context");
after(() => tmp.remove());
let n = 0;
const store = () => new ContextStore(join(tmp.dir, `store-${++n}`));

describe("context store", () => {
  it("writes job.json and outputs/<step>.json, and reads them back", () => {
    const s = store();
    s.writeJob({ jobId: "j1", dispatch: { task: { title: "T" } } });
    s.put("prepare", { appDir: "/w/app" });
    assert.deepEqual(s.job(), { jobId: "j1", dispatch: { task: { title: "T" } } });
    assert.deepEqual(s.get("prepare"), { appDir: "/w/app" });
    assert.ok(s.has("prepare"));
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, "outputs", "prepare.json"), "utf8")), { appDir: "/w/app" });
  });

  it("is write-once: a second write of a step's output, or of job.json, throws and keeps the first", () => {
    const s = store();
    s.put("clone", { n: 1 });
    assert.throws(() => s.put("clone", { n: 2 }), /already written: the context store is write-once/);
    assert.deepEqual(s.get("clone"), { n: 1 });
    s.writeJob({ a: 1 });
    assert.throws(() => s.writeJob({ a: 2 }), /write-once/);
    assert.deepEqual(s.job(), { a: 1 });
  });

  it("get before a step has finished throws", () => {
    const s = store();
    assert.equal(s.has("implement"), false);
    assert.throws(() => s.get("implement"), /step implement has not finished/);
  });

  it("stores only JSON: functions, symbols, bigints, non-finite numbers, class instances and undefined values fail", () => {
    const s = store();
    const bad: [string, unknown][] = [
      ["a function", { run: () => 1 }],
      ["a symbol", { s: Symbol("x") }],
      ["a bigint", { big: 10n }],
      ["NaN", { n: Number.NaN }],
      ["Infinity", [Number.POSITIVE_INFINITY]],
      ["a Date", { at: new Date() }],
      ["a Map", new Map()],
      ["an undefined field", { missing: undefined }],
    ];
    for (const [what, value] of bad) {
      assert.throws(() => s.put(`bad-${what.replace(/\W+/g, "-")}`, value), /is not JSON/, what);
      assert.equal(existsSync(join(s.dir, "outputs", `bad-${what.replace(/\W+/g, "-")}.json`)), false, `${what} left a file`);
    }
  });

  it("a step that returns nothing stores null", () => {
    const s = store();
    s.put("checks", undefined);
    assert.equal(s.get("checks"), null);
  });

  it("refuses step names that are not plain names", () => {
    const s = store();
    for (const name of ["../escape", "a/b", "", ".."]) assert.throws(() => s.put(name, 1), /invalid step name/);
  });

  it("assertJson accepts nested plain JSON", () => {
    assertJson({ a: [1, "two", null, true, { b: { c: [] } }], d: Object.create(null) });
  });
});
