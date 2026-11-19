// The runner reads a failed model call from pi's JSON lines, so a run whose last turn errored is not reported done.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { turnError } from "../../runtime/pi.ts";

const end = (message: Record<string, unknown>) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], ...message } });

describe("turnError", () => {
  it("gives the error of an assistant turn whose model call failed", () => {
    const line = end({ stopReason: "error", errorMessage: '400: {"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}' });
    assert.match(turnError(line) ?? "", /Reasoning is mandatory/);
  });

  it("gives a fallback text when the failed turn has no message", () => {
    assert.equal(turnError(end({ stopReason: "error" })), "the model call failed");
  });

  it("gives an empty string for a turn that ended normally", () => {
    assert.equal(turnError(end({ stopReason: "stop" })), "");
  });

  it("ignores other lines", () => {
    assert.equal(turnError(JSON.stringify({ type: "message_end", message: { role: "user", content: [] } })), null);
    assert.equal(turnError(JSON.stringify({ type: "tool_execution_end" })), null);
    assert.equal(turnError("not json"), null);
  });
});
