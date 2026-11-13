/**
 * pi-durable entries and documents to the web's chat shapes (shared/types.ts ChatItem, ChatLive, ChatMeta; DESIGN 6).
 * Pure functions: the feed (agent/feed.ts) decides which entries are new and when to emit.
 */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import {
  CRON_ENTRY_KIND,
  type ChatItem,
  type ChatLive,
  type ChatMeta,
  type ChatUsage,
  type EffectiveCompaction,
  type Json,
  type LivePhase,
  type ModelRef,
  type ThinkingLevel,
  type ToolStatus,
} from "../shared/types.ts";

/** Tool output kept in the view (the full text stays in the transcript). */
export const OUTPUT_CAP = 4_000;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c && c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

function firstMessage<M extends Message>(entry: EntryRecord, role: M["role"]): M | undefined {
  return entry.model?.find((m) => m.role === role) as M | undefined;
}

function cap(s: string, n = OUTPUT_CAP): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Keep the end: running output is a tail. */
function tail(s: string, n = OUTPUT_CAP): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

function usageOf(u: AssistantMessage["usage"] | undefined): ChatUsage | undefined {
  if (!u) return undefined;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.totalTokens,
    costUsd: u.cost?.total ?? 0,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The chat items one entry contributes: a tool-calling answer gives its text and one tool item per call. */
export function entryItems(entry: EntryRecord, toolLayer: (n: string) => string | undefined): ChatItem[] {
  const id = `e${entry.id}`;
  const entryId = entry.id as number;
  switch (entry.kind) {
    case "pi.user": {
      const m = firstMessage<UserMessage>(entry, "user");
      return [{ kind: "user", id, entryId, text: text(m?.content) }];
    }
    case CRON_ENTRY_KIND: {
      const m = firstMessage<UserMessage>(entry, "user");
      const d = isRecord(entry.data) ? entry.data : {};
      return [
        {
          kind: "cron",
          id,
          entryId,
          cronId: typeof d.cronId === "string" ? d.cronId : "",
          name: typeof d.name === "string" ? d.name : "",
          slot: typeof d.slot === "number" ? d.slot : 0,
          text: text(m?.content),
        },
      ];
    }
    case "pi.assistant": {
      const m = firstMessage<AssistantMessage>(entry, "assistant");
      if (!m) return [];
      const body = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      const thinking = m.content
        .filter((b) => b.type === "thinking")
        .map((b) => (b as { thinking: string }).thinking)
        .join("");
      const calls = m.content.filter((b) => b.type === "toolCall") as Extract<
        AssistantMessage["content"][number],
        { type: "toolCall" }
      >[];
      const failed = m.stopReason === "error" || m.stopReason === "aborted";
      const items: ChatItem[] = [];
      if (body !== "" || thinking !== "" || failed || calls.length === 0) {
        const usage = usageOf(m.usage);
        items.push({
          kind: "assistant",
          id,
          entryId,
          text: body,
          ...(thinking !== "" ? { thinking } : {}),
          model: `${m.provider}/${m.model}`,
          stopReason: m.stopReason,
          ...(m.errorMessage ? { error: m.errorMessage } : {}),
          ...(usage ? { usage } : {}),
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        });
      }
      for (const call of calls) {
        const layer = toolLayer(call.name);
        items.push({
          kind: "tool",
          id: `t${call.id}`,
          callId: call.id,
          entryId,
          name: call.name,
          ...(layer !== undefined ? { layer } : {}),
          args: call.arguments as Json,
          status: "pending",
        });
      }
      return items;
    }
    case "pi.compaction": {
      const reason = isRecord(entry.data) && typeof entry.data.reason === "string" ? entry.data.reason : "threshold";
      return [{ kind: "event", id, entryId, event: "compaction", text: `Context compacted (${reason}).` }];
    }
    case "pi.reset": {
      const m = firstMessage<UserMessage>(entry, "user");
      const handoff = text(m?.content);
      return [{ kind: "event", id, entryId, event: "reset", text: handoff !== "" ? handoff : "New context." }];
    }
    default:
      return [];
  }
}

/** The status of a Harness-written or tool result, from its first diagnostic code (ToolStatus doc comment). */
export function resultStatus(isError: boolean, code: string | undefined): ToolStatus {
  switch (code) {
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    case "tool_unavailable":
      return "unavailable";
    default:
      return isError ? "failed" : "done";
  }
}

/**
 * The tool items a `pi.tool-result` entry completes: the item with its call id from `items`, updated with status,
 * output, duration and diagnostic. Returns the updated items (none when the call is not in `items`).
 */
export function stitchResults(items: readonly ChatItem[], entry: EntryRecord): ChatItem[] {
  if (entry.kind !== "pi.tool-result") return [];
  const out: ChatItem[] = [];
  for (const m of entry.model ?? []) {
    if (m.role !== "toolResult") continue;
    const r = m as ToolResultMessage;
    const item = items.find((i): i is ToolItem => i.kind === "tool" && i.callId === r.toolCallId);
    if (!item) continue;
    const diagnostics = isRecord(entry.data) && Array.isArray(entry.data.diagnostics) ? entry.data.diagnostics : [];
    const first = diagnostics.find((d): d is { code: string } => isRecord(d) && typeof d.code === "string");
    // A successful result's warning (truncated) does not make it fail.
    const code = r.isError ? first?.code : undefined;
    out.push({
      ...item,
      status: resultStatus(r.isError, code),
      output: cap(text(r.content)),
      resultEntryId: entry.id as number,
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      ...(code !== undefined ? { diagnostic: code } : {}),
    });
  }
  return out;
}

/** `pi.live` + `pi.inbox` to the live strip. */
export function liveView(docs: Readonly<Record<string, JsonObject>>): ChatLive {
  const live = (docs["pi.live"] ?? {}) as Record<string, any>;
  const inbox = (docs["pi.inbox"] ?? {}) as Record<string, any>;
  const run = live.run as { taskId: number; turns: number } | undefined;
  const generation = live.generation as
    | { message?: { content?: { type: string; text?: string; thinking?: string; id?: string; name?: string }[] }; retry?: { at: number; error: string } }
    | undefined;
  const tools = (Array.isArray(live.tools) ? live.tools : []) as {
    callId: string;
    name: string;
    status: "pending" | "running" | "done";
    output?: string;
  }[];
  const compactions = (Array.isArray(live.compactions) ? live.compactions : []) as {
    trigger: "manual" | "threshold" | "overflow";
    blocking: boolean;
  }[];

  const busy = run !== undefined;
  let phase: LivePhase = "idle";
  if (busy) {
    if (compactions.some((c) => c.blocking)) phase = "compacting";
    else if (generation?.retry) phase = "retrying";
    else if (tools.some((t) => t.status !== "done")) phase = "tools";
    else if (generation?.message) phase = "streaming";
    else phase = "waiting";
  }

  let streaming: ChatLive["streaming"];
  const content = generation?.message?.content;
  if (Array.isArray(content)) {
    const thinking = content
      .filter((b) => b.type === "thinking")
      .map((b) => b.thinking ?? "")
      .join("");
    streaming = {
      text: content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
      ...(thinking !== "" ? { thinking } : {}),
      toolCalls: content
        .filter((b) => b.type === "toolCall")
        .map((b) => ({ callId: String(b.id ?? ""), name: String(b.name ?? "") })),
    };
  }

  const runFailure = live.runFailure as { reason: string; detail?: string } | undefined;
  const compactionFailure = live.compactionFailure as { error: string } | undefined;
  const items = (Array.isArray(inbox.items) ? inbox.items : []) as {
    id: number;
    mode: "steer" | "followUp" | "write";
    content?: unknown;
    entry?: { kind?: string; data?: unknown; model?: unknown };
  }[];

  return {
    busy,
    phase,
    ...(run ? { runTaskId: run.taskId as number, turns: run.turns } : {}),
    ...(streaming ? { streaming } : {}),
    tools: tools.map((t) => ({
      callId: t.callId,
      name: t.name,
      status: t.status,
      ...(typeof t.output === "string" && t.output !== "" ? { output: tail(t.output) } : {}),
    })),
    ...(generation?.retry ? { retry: { at: generation.retry.at, error: generation.retry.error } } : {}),
    compactions: compactions.map((c) => ({ trigger: c.trigger, blocking: c.blocking })),
    ...(compactionFailure ? { compactionFailure: { error: compactionFailure.error } } : {}),
    ...(runFailure
      ? { runFailure: { reason: runFailure.reason, ...(runFailure.detail ? { detail: runFailure.detail } : {}) } }
      : {}),
    inbox: items.map((item) => {
      const data = isRecord(item.entry?.data) ? item.entry!.data : undefined;
      const cron =
        item.entry?.kind === CRON_ENTRY_KIND && data
          ? { cronId: String(data.cronId ?? ""), name: String(data.name ?? "") }
          : undefined;
      const body =
        item.mode === "write"
          ? text(Array.isArray(item.entry?.model) ? (item.entry!.model as { content?: unknown }[])[0]?.content : "")
          : text(item.content);
      return { id: String(item.id), mode: item.mode, text: body, ...(cron ? { cron } : {}) };
    }),
  };
}

export interface MetaInput {
  readonly docs: Readonly<Record<string, JsonObject>>;
  /** The effective model when `pi.agent` stores none. */
  readonly defaultModel: ModelRef | null;
  readonly modelName: (ref: ModelRef) => string | null;
  /** Newest `pi.assistant` usage totalTokens. */
  readonly contextTokens: number;
  readonly contextWindow: number;
  readonly compaction: EffectiveCompaction;
  /** Resolved `Conversation.agent()`: selected extension names and offered tool names. */
  readonly extensions: readonly string[];
  readonly offeredTools: readonly string[];
}

/** `pi.agent` + `pi.usage` (and what the feed resolves) to the meta strip. */
export function metaView(input: MetaInput): ChatMeta {
  const agent = (input.docs["pi.agent"] ?? {}) as Record<string, any>;
  const stored = isRecord(agent.model) ? (agent.model as { provider?: unknown; modelId?: unknown }) : undefined;
  const model: ModelRef | null =
    stored && typeof stored.provider === "string" && typeof stored.modelId === "string"
      ? { provider: stored.provider, modelId: stored.modelId }
      : input.defaultModel;
  const usage = (input.docs["pi.usage"] ?? {}) as Record<string, any>;
  let totalTokens = 0;
  let costUsd = 0;
  for (const bucket of [usage.models, usage.tools]) {
    if (!isRecord(bucket)) continue;
    for (const u of Object.values(bucket) as { totalTokens?: number; cost?: { total?: number } }[]) {
      totalTokens += typeof u?.totalTokens === "number" ? u.totalTokens : 0;
      costUsd += typeof u?.cost?.total === "number" ? u.cost.total : 0;
    }
  }
  return {
    model,
    modelName: model ? input.modelName(model) : null,
    thinkingLevel: (typeof agent.thinkingLevel === "string" ? agent.thinkingLevel : "off") as ThinkingLevel,
    contextTokens: input.contextTokens,
    contextWindow: input.contextWindow,
    compaction: input.compaction,
    usage: { totalTokens, costUsd },
    extensions: [...input.extensions],
    offeredTools: [...input.offeredTools],
  };
}

/** The newest assistant usage's totalTokens among `entries`, or undefined when none carries usage. */
export function contextTokensOf(entries: readonly EntryRecord[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== "pi.assistant") continue;
    const m = firstMessage<AssistantMessage>(e, "assistant");
    if (m?.usage && m.stopReason !== "error" && m.stopReason !== "aborted") return m.usage.totalTokens;
  }
  return undefined;
}
