import { Clock } from "lucide-react";
import { Button, Icon, Message, TypingIndicator } from "@pw/ui/react";
import type { ChatItem, ChatLive } from "../../shared/types.ts";
import { Markdown } from "../common/Markdown.tsx";
import { ToolGroup, type ToolItem } from "./ToolGroup.tsx";

type OtherItem = Exclude<ChatItem, { kind: "tool" }>;
type Block = { readonly kind: "item"; readonly item: OtherItem } | { readonly kind: "tools"; readonly id: string; readonly tools: ToolItem[] };

/** An assistant entry that only carries tool calls has nothing to show and must not split a group of tools. */
function isSilent(item: OtherItem): boolean {
  return item.kind === "assistant" && item.text.trim() === "" && !item.error && item.stopReason !== "aborted" && item.stopReason !== "error";
}

/** Tools of the current round that the view has no item for yet (the live view is ahead of the entries). */
function liveTools(live: ChatLive | null, items: readonly ChatItem[]): ToolItem[] {
  if (!live) return [];
  const known = new Set(items.filter((i): i is ToolItem => i.kind === "tool").map((i) => i.callId));
  return live.tools
    .filter((t) => !known.has(t.callId))
    .map((t) => ({
      kind: "tool" as const,
      id: `live:${t.callId}`,
      callId: t.callId,
      entryId: 0,
      name: t.name,
      args: {},
      status: t.status,
      ...(t.output !== undefined ? { output: t.output } : {}),
    }));
}

/** Consecutive tool items become one block; silent assistant entries are dropped without splitting it. */
export function buildBlocks(items: readonly ChatItem[], live: ChatLive | null): Block[] {
  const blocks: Block[] = [];
  const addTool = (tool: ToolItem): void => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "tools") last.tools.push(tool);
    else blocks.push({ kind: "tools", id: tool.id, tools: [tool] });
  };
  for (const item of items) {
    if (item.kind === "tool") addTool(item);
    else if (!isSilent(item)) blocks.push({ kind: "item", item });
  }
  for (const tool of liveTools(live, items)) addTool(tool);
  return blocks;
}

function failureText(reason: string, detail: string | undefined): string {
  if (reason === "aborted") return "Stopped. Send a message to carry on.";
  return `The run ended without an answer: ${reason}${detail ? `. ${detail}` : "."}`;
}

function ItemView({ item }: { item: OtherItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Message role="user">
          <span className="tsf-user-text">{item.text}</span>
        </Message>
      );
    case "cron":
      return (
        <Message role="system" className="tsf-cron">
          <span className="tsf-cron-name">
            <Icon of={Clock} size="sm" />
            Cron: {item.name}
          </span>
          <span className="tsf-user-text">{item.text}</span>
        </Message>
      );
    case "assistant": {
      const failed = Boolean(item.error) || item.stopReason === "error";
      return (
        <Message role="assistant" error={failed}>
          {item.text.trim() !== "" && <Markdown text={item.text} />}
          {item.error && <p className="tsf-note">{item.error}</p>}
          {item.stopReason === "aborted" && <p className="tsf-note">Stopped before the answer was complete.</p>}
        </Message>
      );
    }
    case "event":
      return <Message role="system">{item.text}</Message>;
  }
}

export interface TranscriptProps {
  readonly items: readonly ChatItem[];
  readonly live: ChatLive | null;
  readonly hasEarlier: boolean;
  readonly loadingEarlier: boolean;
  readonly onLoadEarlier: () => void;
  readonly onStop: () => void;
}

/** The chat view as pw-ui messages and activity logs. Pure rendering: the pane owns the data and the scrolling. */
export function Transcript({ items, live, hasEarlier, loadingEarlier, onLoadEarlier, onStop }: TranscriptProps) {
  const busy = live?.busy ?? false;
  const blocks = buildBlocks(items, live);
  const lastRunning = (() => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.kind === "tools") return i;
    return -1;
  })();

  const streamingText = live?.streaming?.text ?? "";
  const lastItem = items[items.length - 1];
  // The committed entry and the live message can overlap for a moment: show the committed one.
  const duplicate = lastItem?.kind === "assistant" && streamingText !== "" && lastItem.text.trim() === streamingText.trim();
  const showStreaming = busy && streamingText.trim() !== "" && !duplicate;
  const showTyping = busy && !showStreaming && live?.phase !== "tools";

  return (
    <div className="tsf-transcript">
      {hasEarlier && (
        <div className="tsf-earlier">
          <Button variant="ghost" size="sm" loading={loadingEarlier} loadingLabel="Loading" onClick={onLoadEarlier} data-testid="chat-earlier">
            Load earlier messages
          </Button>
        </div>
      )}
      {items.length === 0 && !busy && (
        <p className="tsf-chat-empty" data-testid="chat-empty">
          Nothing here yet. Tell the agent what you want to build and it will start.
        </p>
      )}
      {blocks.map((block, i) =>
        block.kind === "item" ? (
          <ItemView key={block.item.id} item={block.item} />
        ) : (
          <ToolGroup key={block.id} tools={block.tools} busy={busy} {...(busy && i === lastRunning ? { onStop } : {})} />
        ),
      )}
      {live?.inbox.map((q) => (
        <Message key={`inbox:${q.id}`} role="user" time="Queued">
          <span className="tsf-user-text">{q.cron ? `Cron: ${q.cron.name}. ${q.text}` : q.text}</span>
        </Message>
      ))}
      {showStreaming && (
        <Message role="assistant" streaming>
          <Markdown text={streamingText} />
        </Message>
      )}
      {showTyping && <TypingIndicator />}
      {live?.retry && busy && (
        <Message role="system" error>
          The model call failed and will be tried again: {live.retry.error}
        </Message>
      )}
      {live?.compactionFailure && (
        <Message role="system" error>
          Compaction failed: {live.compactionFailure.error}
        </Message>
      )}
      {live?.runFailure && !busy && (
        <Message role="system" error={live.runFailure.reason !== "aborted"}>
          {failureText(live.runFailure.reason, live.runFailure.detail)}
        </Message>
      )}
    </div>
  );
}
