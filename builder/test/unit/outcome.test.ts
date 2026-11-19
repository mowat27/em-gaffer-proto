/**
 * The settle nudge (E18) in shared:outcome, without a model: what its agent_before_settle handler answers. In a run with a dispatch it sends the
 * agent back at most twice when neither done nor halt has handed the work over, never in the TUI, and never once
 * done or halt has.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import outcome, { MAX_NUDGES, NUDGE, shouldNudge } from "../../agentics/shared/extensions/outcome.ts";
import { tempDir } from "../harness/util.ts";

const tmp = tempDir("builder-outcome");
after(() => tmp.remove());

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface Tool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ isError?: boolean; terminate?: boolean }>;
}

/** Load the extension into a stand-in for pi's ExtensionAPI and return its handlers and tools. */
function load(): { settle(mode: string): Promise<unknown>; tools: Map<string, Tool> } {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const api = { on: (event: string, h: Handler) => handlers.set(event, h), registerTool: (t: Tool) => tools.set(t.name, t) };
  outcome(api as never);
  const before = handlers.get("agent_before_settle");
  assert.ok(before, "outcome.ts handles agent_before_settle");
  return { settle: (mode) => before({ entries: [{ type: "custom", customType: "earlier" }] }, { mode }), tools };
}

let n = 0;
beforeEach(() => {
  n++;
  process.env.BUILDER_DONE_FILE = join(tmp.dir, `done-${n}.json`);
  process.env.BUILDER_HALT_FILE = join(tmp.dir, `halt-${n}.json`);
  // A job: the run has a dispatch (runtime/resolve.ts sets BUILDER_JOB_ID from it).
  process.env.BUILDER_JOB_ID = `job-${n}`;
});
after(() => {
  delete process.env.BUILDER_DONE_FILE;
  delete process.env.BUILDER_HALT_FILE;
  delete process.env.BUILDER_JOB_ID;
});

describe("settle nudge", () => {
  it("shouldNudge: only in a run with a dispatch, not in the TUI, not after done or halt, at most twice", () => {
    const s = { mode: "print", done: false, halted: false, nudges: 0, dispatch: true };
    assert.equal(shouldNudge(s), true);
    assert.equal(shouldNudge({ ...s, dispatch: false }), false);
    assert.equal(shouldNudge({ ...s, mode: "rpc" }), true);
    assert.equal(shouldNudge({ ...s, mode: "json" }), true);
    assert.equal(shouldNudge({ ...s, mode: "tui" }), false);
    assert.equal(shouldNudge({ ...s, done: true }), false);
    assert.equal(shouldNudge({ ...s, halted: true }), false);
    assert.equal(shouldNudge({ ...s, nudges: 1 }), true);
    assert.equal(shouldNudge({ ...s, nudges: MAX_NUDGES }), false);
    assert.equal(MAX_NUDGES, 2);
  });

  it("sends the agent back twice with the message, keeping earlier entries, then lets pi settle", async () => {
    const ext = load();
    const nudge = { entries: [{ type: "custom", customType: "earlier" }, { type: "custom_message", customType: "outcome-nudge", content: NUDGE, display: true }], continue: true };
    assert.equal(NUDGE, "Call done to hand over the work, or halt with a reason.");
    assert.deepEqual(await ext.settle("print"), nudge);
    assert.deepEqual(await ext.settle("print"), nudge);
    assert.equal(await ext.settle("print"), undefined, "after two nudges the run ends, and fails without done");
  });

  it("never nudges a run without a dispatch: it is done when pi exits cleanly, done tool or not", async () => {
    delete process.env.BUILDER_JOB_ID;
    const ext = load();
    assert.equal(await ext.settle("print"), undefined);
    assert.equal(await ext.settle("rpc"), undefined);
  });

  it("never nudges in an interactive session", async () => {
    const ext = load();
    assert.equal(await ext.settle("tui"), undefined);
    assert.equal(await ext.settle("tui"), undefined);
  });

  it("no nudge once done has handed the work over (its file exists)", async () => {
    const ext = load();
    writeFileSync(process.env.BUILDER_DONE_FILE!, JSON.stringify({ ok: true }));
    assert.equal(await ext.settle("rpc"), undefined);
  });

  it("no nudge after halt", async () => {
    const ext = load();
    const r = await ext.tools.get("halt")!.execute("call-1", { reason: "The slice has no fields.", question: "Which fields should CreateThing take?" });
    assert.equal(r.isError, undefined);
    assert.equal(r.terminate, true);
    assert.ok(existsSync(process.env.BUILDER_HALT_FILE!));
    assert.equal(await ext.settle("print"), undefined);
  });

  it("a refused done (failed checks) is not a handover: the agent is still nudged", async () => {
    const ext = load();
    const r = await ext.tools.get("done")!.execute("call-1", {}, undefined, undefined, { cwd: join(tmp.dir, "not-a-repo") });
    assert.equal(r.isError, true);
    assert.ok(!existsSync(process.env.BUILDER_DONE_FILE!));
    assert.equal(((await ext.settle("print")) as { continue: boolean }).continue, true);
  });
});
