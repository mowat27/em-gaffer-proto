import { afterEach, describe, expect, it } from "vitest";
import { openAppDb, type AppDb } from "../../src/core/db.ts";
import { bareId, checkCustomName, promptId, PromptStore } from "../../src/core/prompts.ts";
import { ServiceError } from "../../src/core/errors.ts";
import { gateSection, NEVER_GATED, originalSection } from "../../src/agent/prompt-sections.ts";
import type { Json } from "../../src/shared/types.ts";
import { schemaToTypeScript, toolSignature } from "../../src/agent/schema-ts.ts";

const open: AppDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
const store = (): PromptStore => {
  const db = openAppDb(":memory:");
  open.push(db);
  return new PromptStore(db.db);
};

describe("PromptStore", () => {
  it("custom prompts keep creation order, unique names and a stable id per call", () => {
    const s = store();
    const a = s.customCreate({ id: "a-1", name: "One", text: "first", enabled: true, by: "agent" });
    s.customCreate({ id: "u-2", name: "Two", text: "second", enabled: false, by: "ui" });
    expect(s.customCreate({ id: "a-1", name: "One", text: "first", enabled: true, by: "agent" })).toEqual(a);
    expect(s.customList().map((p) => p.name)).toEqual(["One", "Two"]);
    expect(() => s.customCreate({ id: "u-3", name: "One", text: "x", enabled: true, by: "ui" })).toThrow(ServiceError);
    // Only enabled prompts render.
    expect(s.customText()).toBe("## One\nfirst");
    s.customUpdate("u-2", { enabled: true });
    expect(s.customText()).toBe("## One\nfirst\n\n## Two\nsecond");
    expect(() => s.customUpdate("u-2", { name: "One" })).toThrow(/already exists/);
    expect(s.customDelete("a-1")).toBe(true);
    expect(s.customDelete("a-1")).toBe(false);
  });

  it("runtime prompts join in order and clear", () => {
    const s = store();
    expect(s.runtimeText()).toBeNull();
    s.runtimeAppend({ id: "a-1", text: " one ", by: "agent" });
    s.runtimeAppend({ id: "a-1", text: "ignored", by: "agent" });
    s.runtimeAppend({ id: "u-2", text: "two", by: "ui" });
    expect(s.runtimeText()).toBe("one\n\ntwo");
    expect(s.runtimeRemove("a-1")).toBe(true);
    expect(s.runtimeClear()).toBe(1);
    expect(s.runtimeText()).toBeNull();
  });

  it("ids come from the call id for the agent and are random for the UI", () => {
    expect(promptId({ by: "agent", callId: "c" }, "a")).toBe(promptId({ by: "agent", callId: "c" }, "a"));
    expect(promptId({ by: "ui" }, "u")).not.toBe(promptId({ by: "ui" }, "u"));
    expect(bareId("custom:x", "custom")).toBe("x");
    expect(bareId("x", "custom")).toBe("x");
    expect(() => checkCustomName("a\nb")).toThrow(ServiceError);
  });
});

describe("gateSection", () => {
  it("wraps a section but never the system prompt, and keeps the original for viewing", () => {
    const base = { key: "demo-rules", render: () => "text" };
    const gated = gateSection(base);
    expect(gated).not.toBe(base);
    expect(gated.key).toBe("demo-rules");
    expect(originalSection(gated)).toBe(base);
    expect(NEVER_GATED.has("factory_harness-system")).toBe(true);
    const system = { key: "factory_harness-system", render: () => "s" };
    expect(gateSection(system)).toBe(system);
  });
});

describe("schema-ts", () => {
  it("renders a tool signature from a JSON Schema", () => {
    const schema: Json = {
      type: "object",
      properties: { path: { type: "string", description: "Page path" }, recursive: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false,
    };
    const text = toolSignature("delete_page", schema);
    expect(text).toContain("declare function delete_page(args: {");
    expect(text).toContain("path: string;");
    expect(text).toContain("recursive?: boolean;");
    expect(schemaToTypeScript({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
  });
});
