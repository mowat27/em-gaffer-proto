import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { entryItems, liveView, metaView, stitchResults } from "../../src/agent/chat-view.ts";
import { effectiveCompaction } from "../../src/agent/compaction.ts";
import { CRON_ENTRY_KIND, DEFAULT_COMPACTION_POINTS, type ChatItem, type CronEntryData } from "../../src/shared/types.ts";

const entry = (e: Record<string, unknown>): EntryRecord => ({ conversationId: 1, ...e }) as unknown as EntryRecord;
const layerOf = (n: string) => (n === "list_pages" ? "page_harness" : undefined);
const usage = {
  input: 10,
  output: 5,
  cacheRead: 1,
  cacheWrite: 2,
  totalTokens: 18,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

const userEntry = entry({ id: 3, kind: "pi.user", model: [{ role: "user", content: "hello", timestamp: 1 }] });
const assistantWithCalls = entry({
  id: 7,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Working." },
        { type: "toolCall", id: "c1", name: "list_pages", arguments: {} },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
      ],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
      durationMs: 40,
    },
  ],
});
const result = (id: number, callId: string, name: string, isError: boolean, text: string, codes: string[] = []) =>
  entry({
    id,
    kind: "pi.tool-result",
    model: [
      { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError, timestamp: 3, durationMs: 12 },
    ],
    data: { diagnostics: codes.map((code) => ({ severity: isError ? "error" : "warn", message: code, code })) },
  });

describe("entryItems", () => {
  it("a user entry", () => {
    expect(entryItems(userEntry, layerOf)).toEqual([{ kind: "user", id: "e3", entryId: 3, text: "hello" }]);
  });

  it("an assistant entry with tool calls gives its text and one pending tool item per call", () => {
    const items = entryItems(assistantWithCalls, layerOf);
    expect(items).toEqual([
      {
        kind: "assistant",
        id: "e7",
        entryId: 7,
        text: "Working.",
        model: "faux/faux-1",
        stopReason: "toolUse",
        usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, costUsd: 0.25 },
        durationMs: 40,
      },
      { kind: "tool", id: "tc1", callId: "c1", entryId: 7, name: "list_pages", layer: "page_harness", args: {}, status: "pending" },
      { kind: "tool", id: "tc2", callId: "c2", entryId: 7, name: "bash", args: { command: "ls" }, status: "pending" },
    ]);
  });

  it("a cron entry becomes a cron item (DESIGN 4.1)", () => {
    const data: CronEntryData = { cronId: "cr1", name: "Nightly", slot: 1_700_000_000_000, catchUp: false, manual: false };
    const e = entry({ id: 12, kind: CRON_ENTRY_KIND, model: [{ role: "user", content: "add a page", timestamp: 1 }], data });
    expect(entryItems(e, layerOf)).toEqual([
      { kind: "cron", id: "e12", entryId: 12, cronId: "cr1", name: "Nightly", slot: 1_700_000_000_000, text: "add a page" },
    ]);
  });

  it("system and tool-result entries give no items of their own", () => {
    expect(entryItems(entry({ id: 2, kind: "pi.system", model: [] }), layerOf)).toEqual([]);
    expect(entryItems(result(9, "c1", "list_pages", false, "[]"), layerOf)).toEqual([]);
  });
});

describe("stitchResults", () => {
  const items: ChatItem[] = entryItems(assistantWithCalls, layerOf);

  it("a result completes its tool item", () => {
    const [done] = stitchResults(items, result(9, "c1", "list_pages", false, "[]"));
    expect(done).toMatchObject({ id: "tc1", status: "done", output: "[]", resultEntryId: 9, durationMs: 12 });
    expect(done).not.toHaveProperty("diagnostic");
  });

  it("diagnostics map to status", () => {
    const status = (isError: boolean, codes: string[]) => stitchResults(items, result(9, "c2", "bash", isError, "x", codes))[0];
    expect(status(true, ["blocked"])).toMatchObject({ status: "blocked", diagnostic: "blocked" });
    expect(status(true, ["interrupted"])).toMatchObject({ status: "interrupted", diagnostic: "interrupted" });
    expect(status(true, ["tool_unavailable"])).toMatchObject({ status: "unavailable", diagnostic: "tool_unavailable" });
    expect(status(true, ["aborted"])).toMatchObject({ status: "failed", diagnostic: "aborted" });
    expect(status(true, ["invalid_arguments"])).toMatchObject({ status: "failed", diagnostic: "invalid_arguments" });
    expect(status(true, [])).toMatchObject({ status: "failed" });
    expect(status(false, ["truncated"])).toMatchObject({ status: "done" });
  });

  it("output is capped at 4 000 chars and an unknown call gives nothing", () => {
    const [long] = stitchResults(items, result(9, "c1", "list_pages", false, "y".repeat(5_000)));
    expect((long as { output: string }).output).toHaveLength(4_000);
    expect(stitchResults(items, result(9, "zz", "list_pages", false, "[]"))).toEqual([]);
  });
});

describe("liveView", () => {
  it("idle without a run", () => {
    expect(liveView({})).toEqual({ busy: false, phase: "idle", tools: [], compactions: [], inbox: [] });
  });

  it("streaming, tools, retry, failure", () => {
    const streaming = liveView({
      "pi.live": {
        run: { taskId: 5, inputs: [1], turns: 0 },
        generation: { attempt: 1, message: { content: [{ type: "text", text: "po" }, { type: "toolCall", id: "c9", name: "x" }] } },
      },
    });
    expect(streaming).toMatchObject({
      busy: true,
      phase: "streaming",
      runTaskId: 5,
      turns: 0,
      streaming: { text: "po", toolCalls: [{ callId: "c9", name: "x" }] },
    });
    const tools = liveView({
      "pi.live": { run: { taskId: 5, inputs: [1], turns: 1 }, tools: [{ callId: "c1", name: "bash", status: "running", output: "z".repeat(5_000) }] },
    });
    expect(tools.phase).toBe("tools");
    expect(tools.tools[0]!.output).toHaveLength(4_000);
    expect(liveView({ "pi.live": { run: { taskId: 5, inputs: [], turns: 0 }, generation: { attempt: 2, retry: { at: 9, error: "e" } } } }).phase).toBe("retrying");
    expect(liveView({ "pi.live": { runFailure: { taskId: 5, inputs: [], reason: "interrupted", detail: "twice" } } }).runFailure).toEqual({
      reason: "interrupted",
      detail: "twice",
    });
  });

  it("an inbox item with a cron entry gets cron", () => {
    const live = liveView({
      "pi.inbox": {
        items: [
          { id: 4, mode: "followUp", content: "hi" },
          { id: 5, mode: "followUp", content: "add a page", entry: { kind: CRON_ENTRY_KIND, data: { cronId: "cr1", name: "Nightly", slot: 1, catchUp: false, manual: false } } },
        ],
      },
    });
    expect(live.inbox).toEqual([
      { id: "4", mode: "followUp", text: "hi" },
      { id: "5", mode: "followUp", text: "add a page", cron: { cronId: "cr1", name: "Nightly" } },
    ]);
  });
});

describe("metaView", () => {
  it("model from pi.agent, usage summed", () => {
    const meta = metaView({
      docs: {
        "pi.agent": { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high" },
        "pi.usage": { models: { "faux/faux-1": usage }, tools: { bash: { ...usage, totalTokens: 2, cost: { ...usage.cost, total: 0.5 } } } },
      },
      defaultModel: null,
      modelName: () => "Faux",
      contextTokens: 18,
      contextWindow: 1_000_000,
      compaction: effectiveCompaction(1_000_000, DEFAULT_COMPACTION_POINTS),
      extensions: ["factory_harness"],
      offeredTools: [],
    });
    expect(meta).toMatchObject({
      model: { provider: "faux", modelId: "faux-1" },
      modelName: "Faux",
      thinkingLevel: "high",
      contextTokens: 18,
      usage: { totalTokens: 20, costUsd: 0.75 },
      extensions: ["factory_harness"],
    });
  });
});
