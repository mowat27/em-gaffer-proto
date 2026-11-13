import { clampThinkingLevel, createModels, getSupportedThinkingLevels, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { installFaux, readTurn, replyFor, toAssistantMessage, type FauxRule } from "../../src/agent/faux.ts";
import { BUILTIN_RULES } from "../../src/agent/faux-rules.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

const toolRule: FauxRule = {
  name: "list",
  match: (t) => t.lastUser === "list please" && t.toolResults.length === 0,
  reply: () => ({ toolCalls: [{ name: "list_pages", args: {} }], text: "Listing." }),
};

describe("faux model", () => {
  it("rules are pure: the same transcript gives the same reply", () => {
    const messages: Message[] = [user("ping")];
    const a = toAssistantMessage(replyFor(BUILTIN_RULES, readTurn(messages)), messages);
    const b = toAssistantMessage(replyFor(BUILTIN_RULES, readTurn(messages)), messages);
    expect(a.content).toEqual(b.content);
    expect(a.content).toEqual([{ type: "text", text: "pong" }]);

    const calls: Message[] = [user("list please")];
    const c = toAssistantMessage(replyFor([toolRule], readTurn(calls)), calls);
    const d = toAssistantMessage(replyFor([toolRule], readTurn(calls)), calls);
    expect(c.content).toEqual(d.content);
  });

  it("tool-call replies stop with toolUse", () => {
    const messages: Message[] = [user("list please")];
    const m = toAssistantMessage(replyFor([toolRule], readTurn(messages)), messages);
    expect(m.stopReason).toBe("toolUse");
    expect(m.content.filter((b) => b.type === "toolCall")).toHaveLength(1);
  });

  it("the turn sees tool results since the last user message and the offered tools", () => {
    const messages: Message[] = [
      { role: "system", content: "", toolsAdded: [{ name: "a", description: "", parameters: {} }, { name: "b", description: "", parameters: {} }], timestamp: 0 },
      { role: "system", content: "", toolsRemoved: [{ name: "a" }], timestamp: 0 },
      user("old"),
      user("list please"),
      {
        role: "toolResult",
        toolCallId: "x",
        toolName: "list_pages",
        content: [{ type: "text", text: "[]" }],
        isError: false,
        timestamp: 2,
      },
    ];
    const turn = readTurn(messages);
    expect(turn).toEqual({
      lastUser: "list please",
      toolResults: [{ name: "list_pages", isError: false, text: "[]" }],
      offeredTools: ["b"],
    });
  });

  it("the fallback echoes and long turn is about 2 000 tokens", () => {
    expect(replyFor(BUILTIN_RULES, readTurn([user("hello")]))).toEqual({ text: "Echo: hello" });
    const long = replyFor(BUILTIN_RULES, readTurn([user("long turn")]));
    const text = long.text ?? "";
    expect(text.startsWith("Long turn")).toBe(true);
    expect(Math.ceil(text.length / 4)).toBeGreaterThanOrEqual(2_000);
  });

  it("supports all seven thinking levels and does not clamp max", () => {
    const models = createModels();
    const handle = installFaux(models, { rules: BUILTIN_RULES });
    const model = models.getModel("faux", "faux-1");
    expect(model).toBeDefined();
    expect(model).toBe(handle.models[0]);
    expect(getSupportedThinkingLevels(model!)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(clampThinkingLevel(model!, "max")).toBe("max");
    expect(model!.contextWindow).toBe(1_000_000);
  });
});
