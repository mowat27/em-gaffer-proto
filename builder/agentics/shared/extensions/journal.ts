// Journal: the whole story of a pi run, sent to the run's journal (runtime/journal.ts): what the agent did (every tool
// call with its input and output) and why (the system prompt, the prompts, the model's thinking and replies, and the
// tokens each response used). The journal is the source of truth for a run; pi's own session file is not read.
//
// The runner loads this extension whenever the run has a journal. It is never listed in an agent.yml, so no agent
// definition can drop it. It sees all four of pi's tool events, so blocked calls, unknown tools and invalid arguments
// are journaled too:
//
//   session_start          model.select { model, thinking }   also on model_select and thinking_level_select
//   message_end (system)   model.system { sections, content?, toolsAdded?, toolsRemoved? }   the prompt sections the
//                          model gets: the first one declares them, a later one replaces some (null removes one)
//   message_end (user)     model.prompt { text, role, images? }   a prompt, a follow-up or a custom message
//   message_end (asst.)    model.message { model, thinkingLevel?, thinking, text, toolCalls: [{ id, name }],
//                          stopReason, error? }, then model.usage { model, input, output, cacheRead, cacheWrite, cost }
//   tool_execution_start   tool.start { tool, input }   (a call's arguments: model.message names the calls only)
//   tool_call / tool_result  noted, to tell how the call ended
//   tool_execution_end     tool.end { tool, isError, ms, outcome, output }   outcome: ok | error | blocked | invalid
//   turn_end               turn.end { turn, toolCalls, stopReason }
//
// Tool results are journaled by tool.end, not again as messages. Spans: a tool call is `t-<toolCallId>` (the gate
// host's tool.gate events use the same span), its turn `u-<n>`; model.message and model.usage carry their turn's.
// journalSend redacts secrets before anything leaves the process and falls back to a file when the socket is
// unavailable or drops (E12); at session shutdown the extension waits up to 1 s for the writer to acknowledge the last
// events. Nothing here can fail a tool call or a turn (G7).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { journalFlush, journalSend } from "../../../runtime/journal-client.ts";

const toolSpan = (id: string) => `t-${id}`;
const turnSpan = (n: number) => `u-${n}`;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The text of a tool result's content parts (images are named, not copied). */
export function resultText(result: unknown): string {
  const content = rec(result).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const part = rec(p);
      if (part.type === "text") return typeof part.text === "string" ? part.text : "";
      return `[${String(part.type ?? "part")}]`;
    })
    .join("\n");
}

/** model.usage data from an assistant message, or null when it carries no usage. */
export function usageOf(message: unknown): Rec | null {
  const m = rec(message);
  if (m.role !== "assistant" || !m.usage) return null;
  const u = rec(m.usage);
  return {
    model: [m.provider, m.model].filter((x) => typeof x === "string" && x).join("/"),
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    cost: num(rec(u.cost).total),
    ...(typeof m.stopReason === "string" ? { stopReason: m.stopReason } : {}),
  };
}

/** The text of a message's content: a string, or its text parts joined (other parts are named). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const part = rec(p);
      if (part.type === "text") return typeof part.text === "string" ? part.text : "";
      return part.type === "thinking" || part.type === "toolCall" ? "" : `[${String(part.type ?? "part")}]`;
    })
    .filter(Boolean)
    .join("\n");
}

const toolNames = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.map((t) => String(rec(t).name ?? t)) : undefined);

/**
 * The journal event for a message pi has finished, or null for one the journal records elsewhere (a tool result is
 * tool.end) or not at all.
 */
export function messageEvent(message: unknown): { kind: string; data: Rec } | null {
  const m = rec(message);
  const role = typeof m.role === "string" ? m.role : "";
  if (!role || role === "toolResult") return null;
  if (role === "system") {
    const text = contentText(m.content);
    const added = toolNames(m.toolsAdded);
    const removed = toolNames(m.toolsRemoved);
    return { kind: "model.system", data: { sections: rec(m.sections), ...(text ? { content: text } : {}), ...(added ? { toolsAdded: added } : {}), ...(removed ? { toolsRemoved: removed } : {}) } };
  }
  if (role === "assistant") {
    const parts = Array.isArray(m.content) ? m.content.map(rec) : [];
    const thinking = parts.filter((p) => p.type === "thinking").map((p) => (typeof p.thinking === "string" ? p.thinking : "")).filter(Boolean).join("\n\n");
    const text = parts.filter((p) => p.type === "text").map((p) => (typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n\n");
    const toolCalls = parts.filter((p) => p.type === "toolCall").map((p) => ({ id: String(p.id ?? ""), name: String(p.name ?? "") }));
    return {
      kind: "model.message",
      data: {
        model: [m.provider, m.model].filter((x) => typeof x === "string" && x).join("/"),
        ...(typeof m.thinkingLevel === "string" ? { thinkingLevel: m.thinkingLevel } : {}),
        thinking,
        text,
        toolCalls,
        ...(typeof m.stopReason === "string" ? { stopReason: m.stopReason } : {}),
        ...(typeof m.errorMessage === "string" && m.errorMessage ? { error: m.errorMessage } : {}),
      },
    };
  }
  // user, or a custom message (a builder message, a trigger's prompt): what the model is asked.
  const images = Array.isArray(m.content) ? m.content.filter((p) => rec(p).type === "image").length : 0;
  return {
    kind: "model.prompt",
    data: { role, text: contentText(m.content), ...(images ? { images } : {}), ...(typeof m.customType === "string" ? { customType: m.customType } : {}) },
  };
}

const modelName = (model: unknown): string => {
  const m = rec(model);
  return [m.provider, m.id].filter((x) => typeof x === "string" && x).join("/");
};

export default function (pi: ExtensionAPI) {
  let turn = 0;
  /** Per tool call: when it started, whether tool_call and tool_result fired. */
  const calls = new Map<string, { t0: number; called: boolean; ran: boolean }>();

  // The model and thinking level the session starts with, and every change to either.
  let selected = { model: "", thinking: "" };
  const select = (model: string, thinking: string) => {
    if (model === selected.model && thinking === selected.thinking) return;
    selected = { model, thinking };
    journalSend({ kind: "model.select", data: { model, thinking } });
  };
  const thinkingNow = (): string => {
    try {
      return String(pi.getThinkingLevel() ?? "");
    } catch {
      return "";
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    select(modelName((ctx as { model?: unknown } | undefined)?.model), thinkingNow());
  });
  pi.on("model_select", async (event) => {
    select(modelName(event.model), thinkingNow());
  });
  pi.on("thinking_level_select", async (event) => {
    select(selected.model, String(event.level ?? ""));
  });

  pi.on("turn_start", async (event) => {
    turn = num((event as { turnIndex?: unknown }).turnIndex);
  });

  pi.on("tool_execution_start", async (event) => {
    calls.set(event.toolCallId, { t0: Date.now(), called: false, ran: false });
    journalSend({ kind: "tool.start", span: toolSpan(event.toolCallId), parent: turnSpan(turn), data: { tool: event.toolName, input: event.args ?? {} } });
  });

  pi.on("tool_call", async (event) => {
    const c = calls.get(event.toolCallId);
    if (c) c.called = true;
  });

  pi.on("tool_result", async (event) => {
    const c = calls.get(event.toolCallId);
    if (c) c.ran = true;
  });

  pi.on("tool_execution_end", async (event) => {
    const c = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    const isError = event.isError === true;
    // A call that never reached tool_call failed validation (unknown tool, bad arguments); one that reached it but not
    // tool_result was blocked (or aborted) before it ran.
    const outcome = c && !c.called ? "invalid" : c && !c.ran ? "blocked" : isError ? "error" : "ok";
    const ms = typeof event.durationMs === "number" ? event.durationMs : c ? Date.now() - c.t0 : 0;
    journalSend({ kind: "tool.end", span: toolSpan(event.toolCallId), parent: turnSpan(turn), data: { tool: event.toolName, isError, ms, outcome, output: resultText(event.result) } });
  });

  pi.on("message_end", async (event) => {
    const story = messageEvent(event.message);
    if (story) journalSend({ kind: story.kind, ...(story.kind === "model.message" ? { span: turnSpan(turn) } : {}), data: story.data });
    const usage = usageOf(event.message);
    if (usage) journalSend({ kind: "model.usage", span: turnSpan(turn), data: usage });
  });

  pi.on("turn_end", async (event) => {
    const e = event as { turnIndex?: unknown; message?: unknown; toolResults?: unknown };
    const n = num(e.turnIndex);
    const stopReason = rec(e.message).stopReason;
    journalSend({ kind: "turn.end", span: turnSpan(n), data: { turn: n, toolCalls: Array.isArray(e.toolResults) ? e.toolResults.length : 0, ...(typeof stopReason === "string" ? { stopReason } : {}) } });
  });

  // Before pi exits: let the writer acknowledge the last events, so they need not go through the fallback file.
  pi.on("session_shutdown", async () => {
    await journalFlush(1000);
  });
}
