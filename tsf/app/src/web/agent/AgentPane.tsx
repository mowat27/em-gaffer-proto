import { useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Square } from "lucide-react";
import { Button, Chat, ChatLog, Composer, StatusLine } from "@pw/ui/react";
import type { ChatItem } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useDraft } from "../common/drafts.ts";
import { Navbar } from "../navbar/Navbar.tsx";
import { useAgentState } from "../navbar/widgets.tsx";
import { useFactory } from "../state/store.ts";
import { Transcript } from "./Transcript.tsx";
import { useStickToBottom } from "./useStickToBottom.ts";

function stopRun(): void {
  api.chat.stop().catch(() => {
    // A failed stop leaves the run as it was; the status keeps showing the truth.
  });
}

/**
 * Header content for the right pane (Workbench `rightHeader`): the agent navbar from the UI config (its widgets, such as
 * the status and the context bar) and Stop, which is there only while the agent is busy.
 */
export function AgentHeader() {
  const { canStop } = useAgentState();
  return (
    <div className="tsf-agent-header" data-testid="agent-header">
      <Navbar id="agent" className="tsf-navbar-agent" />
      {canStop && (
        <Button variant="secondary" size="sm" icon={Square} onClick={stopRun} data-testid="chat-stop">
          Stop
        </Button>
      )}
    </div>
  );
}

/** Older items first, without any the live view already holds. */
function mergeItems(earlier: readonly ChatItem[], items: readonly ChatItem[]): readonly ChatItem[] {
  if (earlier.length === 0) return items;
  const ids = new Set(items.map((i) => i.id));
  return [...earlier.filter((i) => !ids.has(i.id)), ...items];
}

/** Right pane: the durable chat with the agent, its tool activity, and the composer. */
export function AgentPane() {
  const chat = useFactory((s) => s.chat);
  const [draft, setDraft, clearDraft] = useDraft("tsf.draft.composer");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<readonly ChatItem[]>([]);
  const [earlierHas, setEarlierHas] = useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const { wrapRef, scrollToBottom, scroller } = useStickToBottom();
  const anchor = useRef<number | null>(null);

  const liveItems = chat?.items ?? [];
  const items = mergeItems(earlier, liveItems);
  const hasEarlier = earlierHas ?? chat?.hasEarlier ?? false;

  // After older items are prepended, keep the reader on what they were reading.
  useLayoutEffect(() => {
    const el = scroller();
    if (anchor.current !== null && el) el.scrollTop = el.scrollHeight - anchor.current;
    anchor.current = null;
  }, [earlier, scroller]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setSendError(null);
    scrollToBottom();
    try {
      await api.chat.send(text);
      clearDraft();
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const loadEarlier = async (): Promise<void> => {
    const oldest = items.find((i) => i.entryId > 0);
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.chat.earlier(oldest.entryId);
      const el = scroller();
      anchor.current = el ? el.scrollHeight - el.scrollTop : null;
      setEarlier((prev) => mergeItems(page.items, prev));
      setEarlierHas(page.hasEarlier);
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setLoadingEarlier(false);
    }
  };

  return (
    <div className="tsf-agent" data-testid="agent-pane">
      <Chat>
        <div className="tsf-chat-log" data-testid="chat-log" ref={wrapRef}>
          <ChatLog autoScroll={false} label="Conversation with the agent">
            <Transcript
              items={items}
              live={chat?.live ?? null}
              hasEarlier={hasEarlier}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={() => void loadEarlier()}
              onStop={stopRun}
            />
          </ChatLog>
        </div>
        <div className="tsf-composer" data-testid="composer">
          {sendError && (
            <StatusLine tone="error" icon={CircleAlert} className="tsf-send-error">
              {sendError}
            </StatusLine>
          )}
          <Composer
            value={draft}
            onChange={(v) => {
              setDraft(v);
              if (sendError) setSendError(null);
            }}
            onSend={() => void send()}
            sending={sending}
            placeholder="Ask the agent"
            label="Message the agent"
          />
        </div>
      </Chat>
    </div>
  );
}
