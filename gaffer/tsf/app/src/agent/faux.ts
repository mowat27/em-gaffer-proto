/**
 * The faux model (D1, DESIGN 7 "Faux model"): pi-ai `fauxProvider` with one reasoning model, answered by rules. A rule
 * matches on the turn (last user text, tool results since it, offered tools) and returns text or tool calls. Rules are
 * pure functions of the transcript, so a request regenerated after a crash answers the same; tool call ids are derived
 * from the transcript too.
 */
import { createHash } from "node:crypto";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type JsonObject,
  type Message,
  type MutableModels,
} from "@earendil-works/pi-ai";

export interface FauxTurn {
  /** Text of the newest user message, trimmed. */
  lastUser: string;
  /** Tool results since that message, oldest first. */
  toolResults: { name: string; isError: boolean; text: string }[];
  /** Tool names offered to the model in this request. */
  offeredTools: string[];
}

export type FauxReply = { text: string } | { toolCalls: { name: string; args: Record<string, unknown> }[]; text?: string };

export interface FauxRule {
  name: string;
  match(turn: FauxTurn): boolean;
  reply(turn: FauxTurn): FauxReply;
}

export const FAUX_MODEL_ID = "faux-1";
export const FAUX_WINDOW = 1_000_000;
/** Copies of the response factory kept queued, so concurrent requests (a summary during a run) never find it empty. */
const QUEUED_FACTORIES = 4;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c && c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/** The turn a request answers, read from its messages. */
export function readTurn(messages: readonly Message[]): FauxTurn {
  const offered: string[] = [];
  let lastUserIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUserIndex = i;
    if (m.role !== "system") return;
    for (const removed of m.toolsRemoved ?? []) {
      const at = offered.indexOf(removed.name);
      if (at >= 0) offered.splice(at, 1);
    }
    for (const added of m.toolsAdded ?? []) {
      if (!offered.includes(added.name)) offered.push(added.name);
    }
  });
  const since = messages.slice(lastUserIndex + 1);
  return {
    lastUser: lastUserIndex >= 0 ? textOf(messages[lastUserIndex]!.content).trim() : "",
    toolResults: since.flatMap((m) =>
      m.role === "toolResult" ? [{ name: m.toolName, isError: m.isError, text: textOf(m.content) }] : [],
    ),
    offeredTools: offered,
  };
}

/** The reply of the first matching rule; the last resort echoes the user. */
export function replyFor(rules: readonly FauxRule[], turn: FauxTurn): FauxReply {
  for (const rule of rules) if (rule.match(turn)) return rule.reply(turn);
  return { text: `Echo: ${turn.lastUser}` };
}

/** A stable id per transcript position: the same transcript gives the same ids. */
function transcriptKey(messages: readonly Message[]): string {
  const h = createHash("sha256");
  for (const m of messages) {
    h.update(m.role);
    h.update("\u0000");
    if (m.role === "assistant") {
      for (const b of m.content) h.update(b.type === "toolCall" ? `call:${b.id}` : b.type === "text" ? b.text : "");
    } else if (m.role === "toolResult") {
      h.update(m.toolCallId);
    } else if (m.role === "user") {
      h.update(textOf(m.content));
    }
    h.update("\u0001");
  }
  return h.digest("hex").slice(0, 16);
}

/** The assistant message for a reply. Tool calls stop with `toolUse`. */
export function toAssistantMessage(reply: FauxReply, messages: readonly Message[]): AssistantMessage {
  if ("toolCalls" in reply) {
    const key = transcriptKey(messages);
    const calls = reply.toolCalls.map((c, i) =>
      fauxToolCall(c.name, c.args as JsonObject, { id: `faux_${key}_${i}` }),
    );
    return fauxAssistantMessage([...(reply.text ? [fauxText(reply.text)] : []), ...calls], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(fauxText(reply.text));
}

/**
 * Register the faux provider on `models`. Its one model reasons and supports all seven thinking levels: `reasoning:
 * true` gives off..high, and a `thinkingLevelMap` with `xhigh` and `max` adds those two (set before `setProvider`).
 */
export function installFaux(
  models: MutableModels,
  opts: { rules: readonly FauxRule[]; tokensPerSecond?: number },
): FauxProviderHandle {
  const envTps = Number(process.env.TSF_FAUX_TPS);
  const tokensPerSecond = opts.tokensPerSecond ?? (Number.isFinite(envTps) && envTps > 0 ? envTps : 200);
  const handle = fauxProvider({
    provider: "faux",
    models: [{ id: FAUX_MODEL_ID, name: "Faux", reasoning: true, contextWindow: FAUX_WINDOW, maxTokens: 64_000 }],
    tokensPerSecond,
  });
  handle.models[0].thinkingLevelMap = { xhigh: "xhigh", max: "max" };
  const respond: FauxResponseFactory = (context) => {
    handle.appendResponses([respond]);
    return toAssistantMessage(replyFor(opts.rules, readTurn(context.messages)), context.messages);
  };
  handle.setResponses(Array.from({ length: QUEUED_FACTORIES }, () => respond));
  models.setProvider(handle.provider);
  return handle;
}
