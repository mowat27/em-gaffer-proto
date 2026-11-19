import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, generateId, type UIMessage } from 'ai';
import { ChevronRight, History, Maximize2, MessageSquarePlus, Minimize2, RotateCcw, Square, Star, X } from 'lucide-react';
import {
  ActivityLog,
  ActivityStep,
  Alert,
  Button,
  ChatLog,
  Composer,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  List,
  ListRow,
  LoadingState,
  Message,
  Select,
  TypingIndicator,
  type ActivityStatus,
} from '@pw/ui/react';
import type { ChatProviderId, ChatProviderInfo, ChatSummary } from '../../shared/types.ts';
import { api } from '../api/client.ts';
import { ResizeHandle } from '../lib/resize.tsx';
import { Markdown } from '../lib/ui.tsx';
import { formatTime } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';
import { useUi } from '../state/ui.tsx';
import type { Page } from '../state/url.ts';

interface ToolLike {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const isTool = (p: { type: string }): p is ToolLike => p.type.startsWith('tool-') || p.type === 'dynamic-tool';

function toolName(p: ToolLike): string {
  return p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice('tool-'.length);
}

function summarise(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'object') return String(input).slice(0, 100);
  const o = input as Record<string, unknown>;
  if (Array.isArray(o.ops)) return `${o.ops.length} edit${o.ops.length === 1 ? '' : 's'}: ${o.ops.map((x) => (x as { op?: string }).op).filter(Boolean).join(', ')}`.slice(0, 100);
  for (const k of ['id', 'path', 'pattern', 'name', 'title', 'dir', 'message']) if (typeof o[k] === 'string') return `${k}: ${o[k] as string}`.slice(0, 100);
  const json = JSON.stringify(input);
  return json.length > 100 ? `${json.slice(0, 97)}...` : json;
}

function toolStatus(p: ToolLike): ActivityStatus {
  if (p.state === 'output-available') return 'done';
  if (p.state === 'output-error' || p.state === 'output-denied') return 'failed';
  return 'running';
}

function ToolGroup({ parts }: { parts: ToolLike[] }) {
  const statuses = parts.map(toolStatus);
  const status: ActivityStatus = statuses.includes('running') ? 'running' : statuses.includes('failed') ? 'failed' : 'done';
  return (
    <ActivityLog status={status} title={`Tool activity (${parts.length})`}>
      {parts.map((p, i) => {
        const out = p.state === 'output-available' ? JSON.stringify(p.output, null, 2) : undefined;
        return (
          <ActivityStep
            key={i}
            status={statuses[i]!}
            name={toolName(p)}
            tool={toolName(p)}
            note={p.state === 'output-error' ? p.errorText : summarise(p.input)}
            detail={out ? <pre className="c4-pre c4-pre-sm">{out.length > 2000 ? `${out.slice(0, 2000)}\n...` : out}</pre> : undefined}
            detailLabel="Result"
          />
        );
      })}
    </ActivityLog>
  );
}

function MessageParts({ message }: { message: UIMessage }) {
  const out: ReactNode[] = [];
  let group: ToolLike[] = [];
  const flush = (key: string) => {
    if (group.length) out.push(<ToolGroup key={key} parts={group} />);
    group = [];
  };
  message.parts.forEach((part, i) => {
    if (isTool(part as { type: string })) group.push(part as unknown as ToolLike);
    else if (part.type === 'text') {
      flush(`g${i}`);
      if (part.text.trim()) out.push(<Markdown key={i}>{part.text}</Markdown>);
    }
  });
  flush('gend');
  return <>{out}</>;
}

// The chat open for each model, per browser. A chat nobody has sent a prompt in is not saved yet, so
// it opens empty: "New chat" and then a reload shows the new chat, not the one before it.
const OPEN_CHATS_KEY = 'c4studio.openChats';
function readOpenChats(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_CHATS_KEY) ?? 'null') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function rememberOpenChat(model: string, id: string): void {
  try {
    localStorage.setItem(OPEN_CHATS_KEY, JSON.stringify({ ...readOpenChats(), [model]: id }));
  } catch {
    /* storage unavailable */
  }
}

function ChatList({ chats, current, onOpen }: { chats: ChatSummary[] | null; current: string; onOpen: (id: string) => void }) {
  return (
    <section className="c4-chat-list" aria-labelledby="c4-chat-list-title">
      <h3 id="c4-chat-list-title">Chats on this model</h3>
      {!chats && <LoadingState text="Loading chats" />}
      {chats?.length === 0 && (
        <EmptyState compact title="No chats yet">
          A chat is kept here once you send it a prompt.
        </EmptyState>
      )}
      {!!chats?.length && (
        <List compact>
          {chats.map((c) => {
            const open = c.id === current;
            return (
              <ListRow key={c.id} title={c.title} current={open} asChild>
                <button type="button" onClick={() => onOpen(c.id)}>
                  <span className="pw-list-main">
                    <span className="pw-list-title">
                      {c.title}
                      {open && <span className="pw-list-open">Open</span>}
                    </span>
                    <span className="pw-list-meta">
                      {formatTime(c.updatedAt)}. {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <Icon of={ChevronRight} className="pw-chev" />
                </button>
              </ListRow>
            );
          })}
        </List>
      )}
    </section>
  );
}

export function ChatPanel() {
  const s = useStudio();
  const ui = useUi();
  const [providers, setProviders] = useState<ChatProviderInfo[]>([]);
  const [provider, setProvider] = useState<ChatProviderId | ''>('');
  const [modelId, setModelId] = useState('');
  // Models chosen per provider in this page, so switching providers back and forth keeps each choice.
  const [picked, setPicked] = useState<Partial<Record<string, string>>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Remember the choice locally and save it to config.json as the default (debounced for typing). */
  const choose = (p: string, m: string, delayMs = 0) => {
    setPicked((prev) => ({ ...prev, [p]: m }));
    clearTimeout(saveTimer.current);
    if (!p || !m.trim()) return;
    saveTimer.current = setTimeout(() => void api.saveChatSettings(p, m).catch(() => undefined), delayMs);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  const [text, setText] = useState('');

  const cfg = useRef({ model: '', branch: '', provider: '' as string, modelId: '' });
  cfg.current = { model: s.model?.slug ?? '', branch: s.branchName ?? '', provider, modelId };

  // Chats belong to the model, not the branch: a prompt goes to whichever branch is open when it is sent.
  // A model opens on the chat last open for it in this browser, or else its newest chat.
  const modelSlug = s.model?.slug ?? '';
  const [opened, setOpened] = useState({ model: '', id: '' });
  const chatId = opened.model === modelSlug ? opened.id : '';
  const [chats, setChats] = useState<{ model: string; list: ChatSummary[] } | null>(null);
  const [showList, setShowList] = useState(false);
  const openChat = (model: string, id: string) => {
    setOpened({ model, id });
    rememberOpenChat(model, id);
  };
  const refreshChats = () => {
    const model = modelSlug;
    if (model) api.chats(model).then((list) => setChats({ model, list }), () => undefined);
  };
  useEffect(() => {
    if (!modelSlug) return;
    const remembered = readOpenChats()[modelSlug];
    if (remembered) setOpened({ model: modelSlug, id: remembered });
    let live = true;
    api.chats(modelSlug).then(
      (list) => {
        if (!live) return;
        setChats({ model: modelSlug, list });
        if (!remembered) openChat(modelSlug, list[0]?.id ?? generateId());
      },
      () => live && !remembered && openChat(modelSlug, generateId()),
    );
    return () => {
      live = false;
    };
  }, [modelSlug]);

  // Refetch when the panel opens, so keys added to c4-studio/.env while the server runs show up.
  useEffect(() => {
    if (!ui.chatOpen) return;
    api.chatProviders().then(setProviders).catch(() => setProviders([]));
  }, [ui.chatOpen]);

  // Live model list for the chosen provider (falls back to a short built-in list).
  const [models, setModels] = useState<{ provider: string; list: string[]; note?: string }>({ provider: '', list: [] });
  const [custom, setCustom] = useState(false);
  const available = providers.find((p) => p.id === provider)?.available;
  useEffect(() => {
    if (!provider || !ui.chatOpen) return;
    let live = true;
    api
      .chatModels(provider)
      .then((r) => live && setModels({ provider, list: r.models, note: r.source === 'fallback' && r.error ? `Showing suggested models: ${r.error}` : undefined }))
      .catch(() => live && setModels({ provider, list: providers.find((p) => p.id === provider)?.suggestedModels ?? [] }));
    return () => {
      live = false;
    };
  }, [provider, available, ui.chatOpen, providers]);
  // Favourite models per provider, saved to c4-studio/config.json.
  const [favs, setFavs] = useState<Partial<Record<string, string[]>> | null>(null);
  const favMap: Partial<Record<string, string[]>> = favs ?? s.status?.config.chat.favourites ?? {};
  const favourites: string[] = (provider && favMap[provider]) || [];
  const isFav = !!modelId && favourites.includes(modelId);
  const toggleFav = () => {
    if (!provider || !modelId || !s.status) return;
    const next = isFav ? favourites.filter((m) => m !== modelId) : [...favourites, modelId];
    setFavs((prev) => ({ ...(prev ?? s.status?.config.chat.favourites ?? {}), [provider]: next }));
    api.setFavourites(provider, next).catch(() => setFavs((prev) => ({ ...(prev ?? {}), [provider]: favourites })));
  };

  const modelList = models.provider === provider ? models.list : [];
  const options = modelId && !modelList.includes(modelId) && !favourites.includes(modelId) ? [modelId, ...modelList] : modelList;
  const groups = useMemo(() => {
    const out = new Map<string, string[]>();
    if (favourites.length) out.set('Favourites', favourites);
    for (const m of options) {
      if (favourites.includes(m)) continue;
      const g = provider === 'openrouter' && m.includes('/') ? m.split('/')[0]! : '';
      out.set(g, [...(out.get(g) ?? []), m]);
    }
    return [...out.entries()];
  }, [options, provider, favourites]);

  // Pick the saved provider and model (or the first available provider) once both the provider list
  // and the saved config have loaded; picking earlier would fall back to defaults and lose the choice.
  useEffect(() => {
    if (provider || providers.length === 0 || !s.status) return;
    const wanted = s.status?.config.chat.provider;
    const pick = providers.find((p) => p.id === wanted && p.available) ?? providers.find((p) => p.available) ?? providers[0]!;
    setProvider(pick.id);
    setModelId(s.status?.config.chat.models[pick.id] ?? pick.defaultModel);
  }, [providers, provider, s.status]);

  const current = providers.find((p) => p.id === provider);

  // The server holds the chat, so only the new prompt is sent: on a retry, the prompt being sent again.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ id, messages: all }) => ({
          body: { chatId: id, message: all.at(-1), model: cfg.current.model, branch: cfg.current.branch, provider: cfg.current.provider, modelId: cfg.current.modelId },
        }),
      }),
    [],
  );
  // The server saves the chat as each prompt and answer arrives; it is loaded here when another chat
  // or model is opened, so it survives refreshes and restarts. Opening another chat stops an answer.
  const chatKey = modelSlug && chatId ? `${modelSlug}/${chatId}` : '';
  const { messages, sendMessage, regenerate, status, stop, error, setMessages, clearError } = useChat({ id: chatId || undefined, transport });

  // open_page tool results move the studio to the page the assistant wants to show, once per tool call.
  const handled = useRef(new Set<string>());

  // The log follows new content only while it is scrolled to the end, so reading earlier messages,
  // typing or changing the model leaves the position alone. Sending a prompt or opening a
  // conversation goes to the end. The design system's ChatLog would scroll to the end on every render.
  const logBox = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const savedTop = useRef(0);
  const known = useRef({ height: 0, view: 0 });
  const sizes = useRef<ResizeObserver | null>(null);
  const logEl = () => logBox.current?.querySelector<HTMLElement>('.pw-chat-log') ?? null;
  const note = (el: HTMLElement) => {
    known.current = { height: el.scrollHeight, view: el.clientHeight };
    savedTop.current = el.scrollTop;
  };
  // Instant: the log scrolls smoothly by default, and mid-animation it would not count as at the end.
  const toEnd = () => {
    const el = logEl();
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    note(el);
  };
  useLayoutEffect(() => {
    const el = logEl();
    if (!el) return;
    let hidden = !el.clientHeight;
    // Only the reader scrolling up leaves the end. A reflow (the panel resized, text rewrapped) also
    // moves the scroll offset, but it changes the log's size in the same frame, which a scroll does not.
    const onScroll = () => {
      if (!el.clientHeight) return; // the panel is closed
      const reflowed = el.scrollHeight !== known.current.height || el.clientHeight !== known.current.view;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) atEnd.current = true;
      else if (!reflowed && el.scrollTop < savedTop.current) atEnd.current = false;
      note(el);
    };
    // Sizes change when the message box grows, the panel opens or is maximised, and when messages
    // reflow (fonts loading, a tool's details opening). A closed panel loses its scroll position.
    const resized = new ResizeObserver(() => {
      if (!el.clientHeight) {
        hidden = true;
        return;
      }
      if (atEnd.current) toEnd();
      else if (hidden) el.scrollTo({ top: savedTop.current, behavior: 'instant' });
      note(el);
      hidden = false;
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    resized.observe(el);
    sizes.current = resized;
    return () => {
      el.removeEventListener('scroll', onScroll);
      resized.disconnect();
      sizes.current = null;
    };
  }, []);

  const [loading, setLoading] = useState(false);
  useEffect(() => {
    atEnd.current = true;
    if (!modelSlug || !chatId) return;
    let live = true;
    setLoading(true);
    api
      .chat(modelSlug, chatId)
      .then((c) => {
        if (!live) return;
        // Tool calls in saved messages already ran; do not navigate again for them.
        for (const m of c.messages as UIMessage[]) for (const part of m.parts as { toolCallId?: string }[]) if (part.toolCallId) handled.current.add(part.toolCallId);
        setMessages((cur) => (cur.length ? cur : (c.messages as UIMessage[])));
      })
      .catch(() => undefined) // not saved yet: a new chat
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // setMessages changes with the chat id, which chatKey already covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey]);
  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts as unknown as (ToolLike & { toolCallId?: string })[]) {
        if (part.type !== 'tool-open_page' || part.state !== 'output-available' || !part.toolCallId || handled.current.has(part.toolCallId)) continue;
        handled.current.add(part.toolCallId);
        const nav = (part.output as { ok?: boolean; navigate?: { model: string; branch: string; page: Page; view?: string; element?: string; rel?: string; adr?: string } } | undefined)?.navigate;
        if (nav) s.navigate({ model: nav.model, branch: nav.branch, page: nav.page, view: nav.view, element: nav.element, rel: nav.rel, adr: nav.adr });
      }
    }
    // s.navigate is stable; only new message parts matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);
  const busy = status === 'submitted' || status === 'streaming';
  useLayoutEffect(() => {
    const el = logEl();
    if (el && sizes.current) for (const child of el.children) sizes.current.observe(child);
    if (atEnd.current) toEnd();
  }, [messages, status, loading]);

  // Up and Down in the message box step through the prompts sent in this conversation, as in a
  // shell: Up on the first line goes back, Down on the last line goes forward and then to the draft.
  const prompts = useMemo(
    () =>
      messages
        .filter((m) => m.role === 'user')
        .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
        .filter((t, i, all) => t.trim() && t !== all[i - 1]),
    [messages],
  );
  const recall = useRef<{ index: number; draft: string } | null>(null);
  useEffect(() => {
    recall.current = null;
  }, [chatKey]);
  const editText = (t: string) => {
    recall.current = null;
    setText(t);
  };
  const onComposerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const box = e.target as HTMLTextAreaElement;
    if (box.tagName !== 'TEXTAREA' || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing || box.selectionStart !== box.selectionEnd) return;
    const r = recall.current;
    let value: string;
    if (e.key === 'ArrowUp') {
      if (box.value.slice(0, box.selectionStart).includes('\n') || prompts.length === 0 || r?.index === 0) return;
      const index = r ? r.index - 1 : prompts.length - 1;
      recall.current = { index, draft: r ? r.draft : text };
      value = prompts[index]!;
    } else {
      if (!r || box.value.slice(box.selectionEnd).includes('\n')) return;
      const index = r.index + 1;
      recall.current = index < prompts.length ? { ...r, index } : null;
      value = index < prompts.length ? prompts[index]! : r.draft;
    }
    e.preventDefault();
    setText(value);
    requestAnimationFrame(() => box.setSelectionRange(value.length, value.length));
  };

  const send = () => {
    const t = text.trim();
    if (!t || busy || !current?.available) return;
    atEnd.current = true;
    void sendMessage({ text: t });
    recall.current = null;
    setText('');
  };

  // Send the last prompt again; a partial answer from the failed attempt is dropped first.
  const retry = () => {
    atEnd.current = true;
    clearError();
    void regenerate();
  };

  // The chat being left stays in the list.
  const newChat = () => {
    if (modelSlug) openChat(modelSlug, generateId());
    setShowList(false);
  };
  const toggleList = () => {
    if (!showList) refreshChats();
    setShowList(!showList);
  };
  const openFromList = (id: string) => {
    if (id !== chatId) openChat(modelSlug, id);
    setShowList(false);
  };

  // Maximised, the same panel becomes a modal overlay, so the conversation, scroll position and draft
  // carry over. Escape closes the chat list first, then puts the panel back.
  const max = ui.chatOpen && ui.chatMax;
  const panel = useRef<HTMLDivElement>(null);
  const panelWidth = useCallback(() => panel.current?.getBoundingClientRect().width ?? 0, []);
  const panelMax = useCallback(() => window.innerWidth * 0.7, []);
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || (!showList && !max)) return;
    e.preventDefault();
    if (showList) setShowList(false);
    else ui.setChatMax(false);
  };

  return (
    <>
      {/* Maximised: a floating panel over the page, which shows through blurred and dimmed. */}
      {max && <div className="pw-backdrop" data-state="open" aria-hidden="true" onClick={() => ui.setChatMax(false)} />}
      <div
        ref={panel}
        className={max ? 'c4-chat is-max' : 'c4-chat'}
        hidden={!ui.chatOpen}
        role={max ? 'dialog' : 'complementary'}
        aria-modal={max || undefined}
        aria-label="Chat"
        onKeyDown={onPanelKey}
      >
        {!max && <ResizeHandle panel="chat" label="Resize the chat panel" grows="left" min={320} max={panelMax} measure={panelWidth} className="c4-resize-chat" />}
        <div className="c4-chat-head">
          <h2>Chat</h2>
          <span className="c4-spacer" />
          {busy && <IconButton label="Stop the response" icon={Square} variant="ghost" size="sm" onClick={() => void stop()} />}
          <IconButton label="Start a new chat" icon={MessageSquarePlus} variant="ghost" size="sm" onClick={newChat} disabled={messages.length === 0 || !modelSlug} />
          <IconButton label="Earlier chats" icon={History} variant="ghost" size="sm" aria-pressed={showList} onClick={toggleList} disabled={!modelSlug} />
          <IconButton label={max ? 'Restore the chat panel' : 'Maximise the chat'} icon={max ? Minimize2 : Maximize2} variant="ghost" size="sm" onClick={() => ui.setChatMax(!max)} />
          {/* Closing the expanded chat goes back to the side panel, not out of the chat. */}
          <IconButton
            label={max ? 'Close the expanded chat' : 'Close chat'}
            icon={X}
            variant="ghost"
            size="sm"
            onClick={() => (max ? ui.setChatMax(false) : ui.setChatOpen(false))}
          />
        </div>
        <div className="c4-chat-settings">
          <Field label="Provider" help={current && !current.available ? current.reason : undefined}>
            <Select
              value={provider}
              onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value);
                setProvider(e.target.value as ChatProviderId);
                setCustom(false);
                if (p) {
                  const m = picked[p.id] ?? s.status?.config.chat.models[p.id] ?? p.defaultModel;
                  setModelId(m);
                  choose(p.id, m);
                }
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {p.available ? '' : ` (unavailable${p.reason ? `: ${p.reason}` : ''})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" help={models.provider === provider ? models.note : undefined}>
            {(control) => (
              <div className="c4-model-pick">
                <Select
                  {...control}
                  value={custom ? '__custom__' : modelId}
                  disabled={!current?.available}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') setCustom(true);
                    else {
                      setCustom(false);
                      setModelId(e.target.value);
                      choose(provider, e.target.value);
                    }
                  }}
                >
                  {groups.map(([g, ms]) =>
                    g ? (
                      <optgroup key={g} label={g}>
                        {ms.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </optgroup>
                    ) : (
                      ms.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    ),
                  )}
                  <option value="__custom__">Other model id…</option>
                </Select>
                <IconButton
                  label={isFav ? 'Remove from favourites' : 'Add to favourites'}
                  icon={Star}
                  variant="ghost"
                  aria-pressed={isFav}
                  className={isFav ? 'c4-fav is-on' : 'c4-fav'}
                  onClick={toggleFav}
                  disabled={!modelId || custom || !s.status}
                />
              </div>
            )}
          </Field>
          {custom && (
            <Field label="Model id">
              <Input
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  choose(provider, e.target.value, 600);
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
        </div>
        {showList && <ChatList chats={chats?.model === modelSlug ? chats.list : null} current={chatId} onOpen={openFromList} />}
        <div className="c4-contents" hidden={showList}>
          {error && (
            <Alert
              tone="error"
              title="The chat request failed"
              onDismiss={clearError}
              actions={
                messages.length > 0 && (
                  <Button variant="secondary" size="sm" icon={RotateCcw} onClick={retry} disabled={busy || !current?.available}>
                    Retry
                  </Button>
                )
              }
            >
              {error.message}
            </Alert>
          )}
          <div className="c4-contents" ref={logBox}>
            <ChatLog label="Chat with the modelling assistant" autoScroll={false}>
              {messages.length === 0 && loading && <TypingIndicator />}
              {messages.length === 0 && !loading && <p className="c4-muted c4-chat-empty">Ask about the model, or ask for a change. Edits appear on the diagram as they are made.</p>}
              {messages.map((m, i) => (
                <Message key={m.id} role={m.role === 'user' ? 'user' : 'assistant'} name={m.role === 'user' ? undefined : 'C4 assistant'} streaming={busy && i === messages.length - 1 && m.role === 'assistant'}>
                  {m.role === 'user' ? m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') : <MessageParts message={m} />}
                </Message>
              ))}
              {status === 'submitted' && <TypingIndicator />}
            </ChatLog>
          </div>
          <div className="c4-contents" onKeyDown={onComposerKey}>
            <Composer
              value={text}
              onChange={editText}
              onSend={send}
              sending={busy}
              disabled={!current?.available || !modelId || !chatId}
              label="Message"
              placeholder={current?.available === false ? (current.reason ?? 'This provider is unavailable') : 'Ask about this model'}
            />
          </div>
        </div>
      </div>
    </>
  );
}
