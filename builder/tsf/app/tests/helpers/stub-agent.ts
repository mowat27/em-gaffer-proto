/**
 * A stand-in FactoryAgent for tests that exercise the server (Service, SSE hub, routes) before, or without, the real
 * agent. It answers "ping" with "pong" through the same `feed.onDelta` / `feed.view` surface the real ChatFeed has, and
 * dedupes submissions by requestId like pi-durable. Tests that need real durability use `createTestFactory` instead.
 */
import type { FactoryAgent } from "../../src/agent/harness.ts";
import type {
  ChatDelta,
  ChatItem,
  ChatLive,
  ChatMeta,
  ChatView,
  ModelInfo,
  ModelRef,
  Settings,
} from "../../src/shared/types.ts";
import { DEFAULT_COMPACTION_POINTS } from "../../src/shared/types.ts";

const IDLE: ChatLive = { busy: false, phase: "idle", tools: [], compactions: [], inbox: [] };

const MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

const META: ChatMeta = {
  model: MODEL,
  modelName: "Faux",
  thinkingLevel: "low",
  contextTokens: 0,
  contextWindow: 1_000_000,
  compaction: {
    window: 1_000_000,
    enabled: true,
    background: 300_000,
    forced: 500_000,
    reserveTokens: 500_000,
    backgroundTokens: 200_000,
    clamped: false,
  },
  usage: { totalTokens: 0, costUsd: 0 },
  extensions: [],
  offeredTools: [],
};

const SETTINGS: Settings = {
  factoryName: "stub",
  layersEnabled: [],
  toolsDisabled: [],
  model: null,
  favouriteModels: [],
  thinkingLevel: "low",
  compaction: DEFAULT_COMPACTION_POINTS,
  systemPrompt: null,
  maxTurns: 60,
};

const MODELS: ModelInfo[] = [
  {
    provider: "faux",
    id: "faux-1",
    name: "Faux",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    reasoning: true,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source: "faux",
  },
];

export interface StubAgent {
  agent: FactoryAgent;
  /** Submissions that reached `main.submit` (after requestId dedupe). */
  submitted: string[];
}

export function createStubAgent(opts: { replyDelayMs?: number } = {}): StubAgent {
  let items: ChatItem[] = [];
  let live: ChatLive = IDLE;
  let nextEntry = 1;
  let nextSubmission = 1;
  const listeners = new Set<(d: ChatDelta) => void>();
  const byRequest = new Map<string, number>();
  const submitted: string[] = [];

  const emit = (d: ChatDelta): void => {
    for (const fn of [...listeners]) fn(d);
  };
  const view = (): ChatView => ({ items, hasEarlier: false, live, meta: META });

  const answer = (text: string): string => (text.trim() === "ping" ? "pong" : `echo: ${text}`);

  const feed = {
    start: async () => undefined,
    stop: async () => undefined,
    view,
    onDelta: (fn: (d: ChatDelta) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onCommit: () => () => undefined,
    current: () => {
      throw new Error("stub feed has no commits");
    },
    loadEarlier: async () => ({ items: [], hasEarlier: false }),
    refreshMeta: () => undefined,
  };

  const main = {
    submit: async (draft: { type: string; content?: unknown; requestId?: string }) => {
      const requestId = draft.requestId ?? `anon-${nextSubmission}`;
      let id = byRequest.get(requestId);
      if (id === undefined) {
        id = nextSubmission++;
        byRequest.set(requestId, id);
        submitted.push(requestId);
        const text = String(draft.content ?? "");
        const user: ChatItem = { kind: "user", id: `e${nextEntry}`, entryId: nextEntry, text };
        nextEntry += 3;
        items = [...items, user];
        emit({ type: "chat.append", items: [user] });
        live = { ...IDLE, busy: true, phase: "streaming" };
        emit({ type: "chat.live", live });
        setTimeout(() => {
          const reply: ChatItem = { kind: "assistant", id: `e${nextEntry}`, entryId: nextEntry, text: answer(text) };
          nextEntry += 3;
          items = [...items, reply];
          emit({ type: "chat.append", items: [reply] });
          live = IDLE;
          emit({ type: "chat.live", live });
        }, opts.replyDelayMs ?? 30);
      }
      const submissionId = id;
      return { id: submissionId, status: async () => ({ status: "placed" as const }) };
    },
    abort: async () => {
      live = IDLE;
      emit({ type: "chat.live", live });
    },
  };

  const agent = {
    harness: { closed: new Promise(() => undefined) },
    main,
    catalog: {
      source: "faux" as const,
      list: () => MODELS,
      resolve: () => MODEL,
      onChange: () => () => undefined,
    },
    registry: {
      manifests: () => [],
      infos: () => [],
      toolInfos: () => [],
    },
    feed,
    settings: () => SETTINGS,
    applySettings: async () => undefined,
    resume: () => undefined,
    close: async () => undefined,
  } as unknown as FactoryAgent;

  return { agent, submitted };
}
