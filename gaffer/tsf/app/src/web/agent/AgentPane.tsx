import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, CircleAlert, Square, X } from "lucide-react";
import { Button, Chat, ChatLog, Composer, IconButton, SearchInput, StatusLine, useToast } from "@pw/ui/react";
import { buildFindIndex, findItems, findSummary, firstLine } from "../../shared/chat-display.ts";
import { historyHint, parseHistory, pushHistory, walkHistory, type HistoryWalk } from "../../shared/composer-history.ts";
import type { ChatItem, ChatLive } from "../../shared/types.ts";
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

/** Header content for the right pane (Workbench `rightHeader`): the agent navbar from the UI config (its widgets). */
export function AgentHeader() {
  return (
    <div className="tsf-agent-header" data-testid="agent-header">
      <Navbar id="agent" className="tsf-navbar-agent" />
    </div>
  );
}

/** Older items first, without any the live view already holds. */
function mergeItems(earlier: readonly ChatItem[], items: readonly ChatItem[]): readonly ChatItem[] {
  if (earlier.length === 0) return items;
  const ids = new Set(items.map((i) => i.id));
  return [...earlier.filter((i) => !ids.has(i.id)), ...items];
}

/** Messages (not tool steps) after the item the reader left behind. An id no longer in the list counts nothing. */
function arrivedSince(items: readonly ChatItem[], id: string | null): number {
  if (id === null) return 0;
  const at = items.findIndex((i) => i.id === id);
  if (at < 0) return 0;
  return items.slice(at + 1).filter((i) => i.kind !== "tool" && !(i.kind === "assistant" && i.text.trim() === "")).length;
}

type Queued = ChatLive["inbox"][number];

function queuedLabel(m: Queued): string {
  if (m.cron) return `Cron: ${m.cron.name}`;
  return m.mode === "steer" ? "Steering" : "Queued";
}

/**
 * Messages the agent has not picked up yet, above the composer: the first line of each (the whole text on hover) and a
 * button that takes that one back. Stop in the header drops them all with the run.
 */
function QueuedMessages({ inbox }: { inbox: readonly Queued[] }) {
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState<string | null>(null);
  if (inbox.length === 0) return null;
  const cancel = (id: string): void => {
    setCancelling(id);
    api.chat
      .cancel(id)
      .then((r) => {
        if (r.cancelled) return;
        const why = r.status === "already_placed" ? "The agent had already picked it up." : "It is no longer waiting.";
        toast({ tone: "error", title: "The message was not taken back", description: why });
      })
      .catch((err: unknown) => toast({ tone: "error", title: "The message was not taken back", description: errorMessage(err) }))
      .finally(() => setCancelling(null));
  };
  return (
    <div className="tsf-queued" data-testid="chat-queued" role="region" aria-label="Queued messages">
      {inbox.map((m) => (
        <div className="tsf-queued-row" key={m.id} data-testid="queued-item" data-id={m.id}>
          <span className="tsf-queued-what">{queuedLabel(m)}</span>
          <span className="tsf-queued-text" title={m.text}>
            {firstLine(m.text, 120)}
          </span>
          <IconButton
            label="Take this message back"
            icon={X}
            size="sm"
            loading={cancelling === m.id}
            data-testid="queued-cancel"
            onClick={() => cancel(m.id)}
          />
        </div>
      ))}
      <p className="tsf-queued-note" data-testid="queued-note">
        {inbox.length === 1 ? "Waits for the agent to finish its turn." : `${inbox.length} messages wait for the agent to finish its turn.`}
      </p>
    </div>
  );
}

/** Right pane: the durable chat with the agent, its tool activity, and the composer. */
export function AgentPane() {
  const chat = useFactory((s) => s.chat);
  const { canStop } = useAgentState();
  const [draft, setDraft, clearDraft] = useDraft("tsf.draft.composer");
  const [historyJson, setHistoryJson] = useDraft("tsf.history.composer");
  const history = useMemo(() => parseHistory(historyJson), [historyJson]);
  const [walk, setWalk] = useState<HistoryWalk | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<readonly ChatItem[]>([]);
  const [earlierHas, setEarlierHas] = useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const { wrapRef, scrollToBottom, scroller, stuck } = useStickToBottom();
  const anchor = useRef<number | null>(null);
  const [leftAt, setLeftAt] = useState<string | null>(null);
  const [find, setFind] = useState("");

  const liveItems = chat?.items ?? [];
  const items = mergeItems(earlier, liveItems);
  const hasEarlier = earlierHas ?? chat?.hasEarlier ?? false;
  const finding = find.trim() !== "";
  // The index is built only while a query is up, so an empty box costs nothing.
  const findIndex = useMemo(() => (finding ? buildFindIndex(items) : null), [items, finding]);
  const shown = useMemo(() => (findIndex === null ? items : findItems(items, findIndex, find)), [items, findIndex, find]);
  const fresh = arrivedSince(items, leftAt);

  // After older items are prepended, keep the reader on what they were reading.
  useLayoutEffect(() => {
    const el = scroller();
    if (anchor.current !== null && el) el.scrollTop = el.scrollHeight - anchor.current;
    anchor.current = null;
  }, [earlier, scroller]);

  // Remember the newest item when the reader leaves the end, and forget it once the end is in view again.
  const newestId = items.at(-1)?.id ?? null;
  useEffect(() => {
    if (stuck) setLeftAt(null);
    else setLeftAt((prev) => prev ?? newestId);
  }, [stuck, newestId]);

  // A recalled message leaves the caret at its end, so the next arrow press carries on from there.
  useEffect(() => {
    if (walk === null) return;
    const el = composerRef.current?.querySelector("textarea");
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, [walk]);

  const onComposerKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      // Leave the box so the hotkeys work again; the draft stays.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    const step = walkHistory({
      history,
      walk,
      direction: e.key === "ArrowUp" ? -1 : 1,
      value: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    });
    if (step === null) return;
    e.preventDefault();
    setWalk(step.walk);
    setDraft(step.value);
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setSendError(null);
    scrollToBottom();
    try {
      await api.chat.send(text);
      setHistoryJson(JSON.stringify(pushHistory(history, text)));
      setWalk(null);
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

  const hint = historyHint(history, walk, draft);

  return (
    <div className="tsf-agent" data-testid="agent-pane">
      {/* Its own row above the log: the glass log paints into the space above it and would cover a count line inside. */}
      <div
        className="tsf-chat-find"
        data-testid="chat-find"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          setFind("");
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }}
      >
        <SearchInput id="tsf-chat-find" value={find} onChange={setFind} label="Find in the conversation" placeholder="Find in the conversation" />
        {finding && (
          <p className="tsf-chat-find-count" data-testid="chat-find-count" role="status">
            {findSummary(find, shown.length, items.length, hasEarlier)}
          </p>
        )}
      </div>
      <Chat>
        <div className="tsf-chat-log" data-testid="chat-log" ref={wrapRef}>
          <ChatLog autoScroll={false} label="Conversation with the agent">
            <Transcript
              items={shown}
              /* While the box narrows the transcript the live round stays out; the status chip still shows the work. */
              live={finding ? null : (chat?.live ?? null)}
              hasEarlier={hasEarlier}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={() => void loadEarlier()}
              onStop={stopRun}
              filtering={finding}
            />
          </ChatLog>
          {!stuck && !finding && (
            <Button
              variant="secondary"
              size="sm"
              icon={ArrowDown}
              className="tsf-jump"
              title="Scroll to the newest message and follow the agent again"
              data-testid="chat-jump"
              onClick={scrollToBottom}
            >
              {fresh > 0 ? `Jump to latest · ${fresh} new` : "Jump to latest"}
            </Button>
          )}
        </div>
        <div className="tsf-composer" data-testid="composer" ref={composerRef} onKeyDown={onComposerKey}>
          <QueuedMessages inbox={chat?.live.inbox ?? []} />
          {sendError && (
            <StatusLine tone="error" icon={CircleAlert} className="tsf-send-error">
              {sendError}
            </StatusLine>
          )}
          {/* While there is something to stop, Stop takes the Send button's place (agent.css hides Send). Enter still
              sends, so a message typed during a run is queued. */}
          <Composer
            className={canStop ? "tsf-composer-running" : undefined}
            tools={
              canStop ? (
                <IconButton type="button" variant="secondary" size="sm" label="Stop the agent" icon={Square} onClick={stopRun} data-testid="chat-stop" />
              ) : undefined
            }
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setWalk(null);
              if (sendError) setSendError(null);
            }}
            onSend={() => void send()}
            sending={sending}
            placeholder="Ask the agent"
            label="Message the agent"
          />
          {hint !== null && (
            <p className="tsf-composer-hint" data-testid="composer-history">
              {hint}
            </p>
          )}
        </div>
      </Chat>
    </div>
  );
}
