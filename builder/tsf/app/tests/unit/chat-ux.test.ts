/** The pure rules behind the agent pane's chat features (src/shared/agent-activity, chat-display, composer-history). */
import { describe, expect, it } from "vitest";
import { agentActivity, APP_TITLE, documentTitle, pageLabel } from "../../src/shared/agent-activity.ts";
import {
  answerMeta,
  copyableArgs,
  buildFindIndex,
  findItems,
  findSummary,
  firstLine,
  formatDuration,
  toolArgNote,
  withoutCd,
} from "../../src/shared/chat-display.ts";
import { historyHint, parseHistory, pushHistory, walkHistory, HISTORY_MAX } from "../../src/shared/composer-history.ts";
import type { ChatItem, ChatLive } from "../../src/shared/types.ts";

function live(over: Partial<ChatLive> = {}): ChatLive {
  return { busy: true, phase: "waiting", tools: [], compactions: [], inbox: [], ...over };
}

describe("agentActivity", () => {
  it("is idle with nothing to stop when there is no live view or no run", () => {
    expect(agentActivity(null)).toMatchObject({ state: "idle", busy: false, canStop: false, short: "Idle", doing: null });
    expect(agentActivity(live({ busy: false, phase: "idle" }))).toMatchObject({ state: "idle", canStop: false });
  });

  it("can stop an idle agent that still has queued messages", () => {
    const a = agentActivity(live({ busy: false, phase: "idle", inbox: [{ id: "4", mode: "followUp", text: "x" }] }));
    expect(a).toMatchObject({ state: "idle", canStop: true, short: "Idle" });
  });

  it("names waiting, thinking, writing and tools", () => {
    expect(agentActivity(live({ phase: "waiting" })).short).toBe("Working · waiting");
    expect(agentActivity(live({ phase: "streaming", streaming: { text: "  ", toolCalls: [] } })).short).toBe("Working · thinking");
    expect(agentActivity(live({ phase: "streaming" })).doing).toBe("thinking");
    expect(agentActivity(live({ phase: "streaming", streaming: { text: "Hello", toolCalls: [] } })).short).toBe("Working · writing");
    const tools = agentActivity(live({ phase: "tools", tools: ["a", "b", "c", "d"].map((n) => ({ callId: n, name: n, status: "running" as const })) }));
    expect(tools.short).toBe("Working · tools");
    expect(tools.detail).toBe("The agent is running tools (a, b, c, …)");
  });

  it("says retrying with the error and compacting", () => {
    const r = agentActivity(live({ phase: "retrying", retry: { at: 1, error: "HTTP 529 overloaded" } }));
    expect(r).toMatchObject({ state: "retrying", short: "Retrying", doing: null, canStop: true });
    expect(r.detail).toContain("HTTP 529 overloaded");
    expect(agentActivity(live({ phase: "compacting" })).short).toBe("Compacting");
  });
});

describe("documentTitle", () => {
  it("names the page and the factory, with the agent's words first while it works", () => {
    expect(documentTitle({ page: "Notes/Plan", factory: "demo", agent: null })).toBe("Notes/Plan · demo");
    expect(documentTitle({ page: "Notes/Plan", factory: "demo", agent: "Working · tools" })).toBe("Working · tools — Notes/Plan · demo");
    expect(documentTitle({ page: null, factory: "demo", agent: null })).toBe("demo");
    expect(documentTitle({ page: null, factory: null, agent: null })).toBe(APP_TITLE);
    expect(documentTitle({ page: null, factory: null, agent: "Retrying" })).toBe(`Retrying — ${APP_TITLE}`);
  });

  it("drops .md from a page path", () => {
    expect(pageLabel("Notes/Plan.md")).toBe("Notes/Plan");
    expect(pageLabel(null)).toBeNull();
    expect(pageLabel(".md")).toBeNull();
  });
});

const items: ChatItem[] = [
  { kind: "user", id: "e1", entryId: 1, text: "Build the Login page" },
  { kind: "assistant", id: "e2", entryId: 2, text: "Done." },
  { kind: "tool", id: "tc1", callId: "c1", entryId: 2, name: "create_page", args: { path: "Login.md" }, status: "done", output: "created OAuth notes" },
  { kind: "cron", id: "e3", entryId: 3, cronId: "x", name: "Nightly", slot: 1, text: "check" },
];

describe("find", () => {
  const index = buildFindIndex(items);
  it("matches text case-insensitively, including tool names, arguments and output", () => {
    expect(findItems(items, index, "login").map((i) => i.id)).toEqual(["e1", "tc1"]);
    expect(findItems(items, index, "CREATE_PAGE").map((i) => i.id)).toEqual(["tc1"]);
    expect(findItems(items, index, "oauth").map((i) => i.id)).toEqual(["tc1"]);
    expect(findItems(items, index, "nightly").map((i) => i.id)).toEqual(["e3"]);
  });

  it("keeps everything for a blank query", () => {
    expect(findItems(items, index, "  ")).toBe(items);
  });

  it("says how many loaded entries matched, and how to search further back", () => {
    expect(findSummary("x", 2, 10, false)).toBe("2 of 10 entries match.");
    expect(findSummary("x", 1, 10, true)).toBe("1 of 10 loaded entries matches.");
    expect(findSummary(" x ", 0, 10, false)).toBe('No entry holds "x".');
    expect(findSummary("x", 0, 10, true)).toBe('No loaded entry holds "x". Load earlier messages to search further back.');
  });
});

describe("tool step text", () => {
  it("drops a leading cd from a command for display", () => {
    expect(withoutCd("cd /repo && npm test")).toBe("npm test");
    expect(withoutCd('cd "my dir" && ls -la && pwd')).toBe("ls -la && pwd");
    expect(withoutCd("npm test && cd x")).toBe("npm test && cd x");
    expect(withoutCd("cd /repo")).toBe("cd /repo");
  });

  it("notes the first short argument on one line", () => {
    expect(toolArgNote({ command: "cd /repo && npm test\nmore" })).toBe("npm test");
    expect(toolArgNote({ path: "a.md", command: "x" })).toBe("a.md");
    expect(toolArgNote({ count: 1 })).toBeUndefined();
    expect(toolArgNote({ path: "x".repeat(100) })).toHaveLength(80);
    expect(toolArgNote(null)).toBeUndefined();
  });

  it("copies the whole command when a step has one, else the JSON arguments", () => {
    expect(copyableArgs({ command: "cd /repo && npm test" })).toBe("cd /repo && npm test");
    expect(copyableArgs({ path: "a.md" })).toBe('{\n  "path": "a.md"\n}');
  });

  it("cuts a first line with an ellipsis", () => {
    expect(firstLine("\n  hello\nworld", 90)).toBe("hello");
    expect(firstLine("abcdef", 4)).toBe("abc…");
  });

  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });
});

describe("answerMeta", () => {
  it("shows the model without its provider and the elapsed time; the title adds provider, tokens and cost", () => {
    const m = answerMeta({
      model: "openrouter/anthropic/claude-5",
      durationMs: 4_200,
      usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 1280, costUsd: 0.0123 },
    });
    expect(m).toEqual({ text: "claude-5 · 4.2 s", title: "openrouter: anthropic/claude-5 · 1,200 tokens in, 80 out · $0.0123 · 4.2 s" });
  });

  it("leaves out a zero cost and is null with nothing to show", () => {
    expect(answerMeta({ model: "faux/faux-1", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costUsd: 0 } })?.title).toBe(
      "faux: faux-1 · 1 tokens in, 2 out",
    );
    expect(answerMeta({})).toBeNull();
  });
});

describe("composer history", () => {
  it("parses what it stored and ignores anything else", () => {
    expect(parseHistory('["a"," ",3,"b"]')).toEqual(["a", "b"]);
    expect(parseHistory("{")).toEqual([]);
    expect(parseHistory('"a"')).toEqual([]);
  });

  it("moves a repeat to the end and caps the list", () => {
    expect(pushHistory(["a", "b"], " a ")).toEqual(["b", "a"]);
    expect(pushHistory(["a"], "  ")).toEqual(["a"]);
    const many = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => `m${i}`).reduce<readonly string[]>(pushHistory, []);
    expect(many).toHaveLength(HISTORY_MAX);
    expect(many.at(-1)).toBe(`m${HISTORY_MAX + 4}`);
  });

  const history = ["first", "second"];
  const at = (value: string, caret = value.length) => ({ value, selectionStart: caret, selectionEnd: caret });

  it("walks back with ↑ and returns to the draft with ↓", () => {
    const up1 = walkHistory({ history, walk: null, direction: -1, ...at("draft") });
    expect(up1).toEqual({ walk: { index: 1, typed: "draft" }, value: "second" });
    const up2 = walkHistory({ history, walk: up1!.walk, direction: -1, ...at("second") });
    expect(up2).toEqual({ walk: { index: 0, typed: "draft" }, value: "first" });
    expect(walkHistory({ history, walk: up2!.walk, direction: -1, ...at("first") })).toBeNull();
    const down = walkHistory({ history, walk: up2!.walk, direction: 1, ...at("first") });
    expect(down).toEqual({ walk: { index: 1, typed: "draft" }, value: "second" });
    expect(walkHistory({ history, walk: down!.walk, direction: 1, ...at("second") })).toEqual({ walk: null, value: "draft" });
  });

  it("leaves the arrows to a multi-line message unless the caret is on the edge line", () => {
    expect(walkHistory({ history, walk: null, direction: -1, ...at("a\nb") })).toBeNull();
    expect(walkHistory({ history, walk: null, direction: -1, ...at("a\nb", 1) })).not.toBeNull();
    const walk = { index: 0, typed: "" };
    expect(walkHistory({ history, walk, direction: 1, ...at("a\nb", 0) })).toBeNull();
    expect(walkHistory({ history, walk, direction: 1, ...at("a\nb", 3) })).not.toBeNull();
  });

  it("does nothing with no history, a selection, or ↓ outside a walk", () => {
    expect(walkHistory({ history: [], walk: null, direction: -1, ...at("") })).toBeNull();
    expect(walkHistory({ history, walk: null, direction: -1, value: "abc", selectionStart: 0, selectionEnd: 2 })).toBeNull();
    expect(walkHistory({ history, walk: null, direction: 1, ...at("") })).toBeNull();
  });

  it("hints only when it has something to say", () => {
    expect(historyHint(history, null, "")).toBe("↑ recalls your last message");
    expect(historyHint(history, null, "typing")).toBeNull();
    expect(historyHint([], null, "")).toBeNull();
    expect(historyHint(history, { index: 0, typed: "" }, "first")).toBe("Earlier message 1 of 2. ↓ returns to your draft.");
  });
});
