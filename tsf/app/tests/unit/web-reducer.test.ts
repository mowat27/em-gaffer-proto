import { describe, expect, it } from "vitest";
import { CHAT_ITEMS_KEPT, initialState, reduce, RUNS_KEPT, withConnection, type FactoryState } from "../../src/web/state/reducer.ts";
import {
  API_VERSION,
  DEFAULT_UI_CONFIG,
  type ChatItem,
  type ChatLive,
  type ChatMeta,
  type ChatView,
  type Delta,
  type Page,
  type PageTree,
  type RunSummary,
  type Snapshot,
  type SseFrame,
} from "../../src/shared/types.ts";

const BOOT = 1_700_000_000_000;
const tree = (names: string[]): PageTree => ({
  kind: "folder",
  path: "",
  name: "",
  children: names.map((n) => ({ kind: "page", path: `${n}.md`, name: n, title: n, size: 1, mtimeMs: 1 })),
});
const page = (path: string, content: string): Page => ({ path, title: path, content, version: content.slice(0, 12), size: content.length, mtimeMs: 1 });
const live = (busy = false): ChatLive => ({ busy, phase: busy ? "streaming" : "idle", tools: [], compactions: [], inbox: [] });
const meta = { model: null, modelName: "faux", thinkingLevel: "low", contextTokens: 0, contextWindow: 1 } as unknown as ChatMeta;
const user = (n: number, text = `u${n}`): ChatItem => ({ kind: "user", id: `e${n}`, entryId: n, text });
const run = (id: number): RunSummary => ({ id, prompt: `p${id}` }) as unknown as RunSummary;

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const chat: ChatView = { items: [user(1)], hasEarlier: false, live: live(), meta };
  return {
    apiVersion: API_VERSION,
    bootId: BOOT,
    serverTime: BOOT,
    status: { name: "demo" } as Snapshot["status"],
    chat,
    pages: tree(["Start Here"]),
    selection: { path: "Start Here.md", by: "system", at: 1 },
    focus: page("Start Here.md", "# Start Here"),
    settings: { factoryName: "demo" } as Snapshot["settings"],
    uiConfig: DEFAULT_UI_CONFIG,
    layers: [],
    tools: [],
    ceiling: { source: "default" } as unknown as Snapshot["ceiling"],
    runs: [run(3)],
    themes: [],
    themeCss: ":root{--pw-ai-glow:0.8}",
    cron: [],
    ...over,
  };
}

let nextId = BOOT * 1000 + 10;
const delta = (d: Delta, id = nextId++): SseFrame => ({ type: "delta", id, delta: d });
const loaded = (): FactoryState => reduce(initialState, { type: "snapshot", id: BOOT * 1000 + 5, snapshot: snapshot() });

describe("frames", () => {
  it("a snapshot replaces the state, flattens its fields and makes the connection live", () => {
    const old = loaded();
    const s = reduce({ ...old, focus: page("X.md", "x") }, { type: "snapshot", id: BOOT * 1000 + 7, snapshot: snapshot({ pages: tree(["A"]) }) });
    expect(s.connection).toBe("live");
    expect(s.bootId).toBe(BOOT);
    expect(s.lastId).toBe(BOOT * 1000 + 7);
    expect(s.pages).toEqual(tree(["A"]));
    expect(s.focus?.path).toBe("Start Here.md");
    expect(s.chat?.items).toEqual([user(1)]);
    expect(s.uiConfig).toBe(DEFAULT_UI_CONFIG);
    expect(s.themeCss).toContain("--pw-ai-glow");
    expect(s.snapshot?.bootId).toBe(BOOT);
  });

  it("an empty themeCss in a snapshot keeps the CSS already shown", () => {
    const s = reduce(loaded(), { type: "snapshot", id: BOOT * 1000 + 8, snapshot: snapshot({ themeCss: "" }) });
    expect(s.themeCss).toContain("--pw-ai-glow");
  });

  it("hello sets the boot id; a resumed hello is live at once, a fresh one waits for the snapshot", () => {
    const fresh = reduce(initialState, { type: "hello", apiVersion: API_VERSION, bootId: BOOT, serverTime: 0, resumed: false });
    expect(fresh).toMatchObject({ bootId: BOOT, connection: "connecting" });
    const resumed = reduce(withConnection(loaded(), "offline"), { type: "hello", apiVersion: API_VERSION, bootId: BOOT, serverTime: 0, resumed: true });
    expect(resumed.connection).toBe("live");
  });

  it("ping changes nothing on a live stream and revives an offline one", () => {
    const s = loaded();
    expect(reduce(s, { type: "ping", serverTime: 1 })).toBe(s);
    expect(reduce(withConnection(s, "offline"), { type: "ping", serverTime: 1 }).connection).toBe("live");
  });

  it("a delta id at or below the last applied one is ignored", () => {
    const s = loaded();
    const once = reduce(s, delta({ type: "chat.append", items: [user(2)] }, BOOT * 1000 + 20));
    expect(once.lastId).toBe(BOOT * 1000 + 20);
    const again = reduce(once, delta({ type: "chat.append", items: [user(3)] }, BOOT * 1000 + 20));
    expect(again).toBe(once);
    expect(reduce(once, delta({ type: "chat.append", items: [user(3)] }, BOOT * 1000 + 19))).toBe(once);
  });

  it("withConnection returns the same state when nothing changes", () => {
    const s = loaded();
    expect(withConnection(s, "live")).toBe(s);
    expect(withConnection(s, "offline").connection).toBe("offline");
  });
});

describe("chat deltas", () => {
  it("chat.append appends and dedupes by item id (a repeated item replaces the held one)", () => {
    let s = reduce(loaded(), delta({ type: "chat.append", items: [user(2), user(3)] }));
    s = reduce(s, delta({ type: "chat.append", items: [user(3, "edited"), user(4)] }));
    expect(s.chat!.items.map((i) => i.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect((s.chat!.items[2] as { text: string }).text).toBe("edited");
  });

  it("chat.append keeps at most CHAT_ITEMS_KEPT items and then has earlier items", () => {
    const many = Array.from({ length: CHAT_ITEMS_KEPT + 5 }, (_, i) => user(i + 2));
    const s = reduce(loaded(), delta({ type: "chat.append", items: many }));
    expect(s.chat!.items).toHaveLength(CHAT_ITEMS_KEPT);
    expect(s.chat!.items.at(-1)!.id).toBe(`e${CHAT_ITEMS_KEPT + 6}`);
    expect(s.chat!.hasEarlier).toBe(true);
  });

  it("chat.update replaces by id and ignores ids it does not hold", () => {
    const tool: ChatItem = { kind: "tool", id: "tc1", callId: "c1", entryId: 2, name: "list_pages", args: {}, status: "running" };
    let s = reduce(loaded(), delta({ type: "chat.append", items: [tool] }));
    s = reduce(s, delta({ type: "chat.update", items: [{ ...tool, status: "done", output: "[]" }, { ...tool, id: "tc9" }] }));
    expect(s.chat!.items.map((i) => i.id)).toEqual(["e1", "tc1"]);
    expect(s.chat!.items[1]).toMatchObject({ status: "done", output: "[]" });
  });

  it("chat.live, chat.meta and chat.reset replace their parts", () => {
    let s = reduce(loaded(), delta({ type: "chat.live", live: live(true) }));
    expect(s.chat!.live.busy).toBe(true);
    s = reduce(s, delta({ type: "chat.meta", meta: { ...meta, contextTokens: 42 } }));
    expect(s.chat!.meta.contextTokens).toBe(42);
    const chat: ChatView = { items: [user(9)], hasEarlier: true, live: live(), meta };
    s = reduce(s, delta({ type: "chat.reset", chat }));
    expect(s.chat).toBe(chat);
  });
});

describe("app events", () => {
  it("pages.changed replaces the tree", () => {
    const s = reduce(loaded(), delta({ type: "pages.changed", tree: tree(["Start Here", "B"]), paths: ["B.md"], by: "agent" }));
    expect(s.pages!.children).toHaveLength(2);
  });

  it("page.updated updates the focus only for the selected path", () => {
    const s = loaded();
    const other = reduce(s, delta({ type: "page.updated", page: page("Other.md", "# Other"), by: "ui" }));
    expect(other.focus?.path).toBe("Start Here.md");
    expect(other.focus?.content).toBe("# Start Here");
    const selected = reduce(s, delta({ type: "page.updated", page: page("Start Here.md", "# Start Here\n\nmore"), by: "system" }));
    expect(selected.focus?.content).toBe("# Start Here\n\nmore");
  });

  it("page.removed alone leaves the focus; selection.changed sets selection and focus", () => {
    let s = reduce(loaded(), delta({ type: "page.removed", path: "Start Here.md", by: "ui" }));
    expect(s.focus?.path).toBe("Start Here.md");
    s = reduce(s, delta({ type: "selection.changed", selection: { path: null, by: "ui", at: 2 }, focus: null }));
    expect(s.selection?.path).toBeNull();
    expect(s.focus).toBeNull();
    const p = page("B.md", "# B");
    s = reduce(s, delta({ type: "selection.changed", selection: { path: "B.md", by: "agent", at: 3 }, focus: p }));
    expect(s.focus).toBe(p);
  });

  it("ui_config.changed applies only a higher version", () => {
    const newer = { ...DEFAULT_UI_CONFIG, version: 5, panes: { ...DEFAULT_UI_CONFIG.panes, agentMaximised: true } };
    let s = reduce(loaded(), delta({ type: "ui_config.changed", config: newer, by: "ui" }));
    expect(s.uiConfig).toBe(newer);
    const older = { ...DEFAULT_UI_CONFIG, version: 4 };
    s = reduce(s, delta({ type: "ui_config.changed", config: older, by: "ui" }));
    expect(s.uiConfig).toBe(newer);
    const same = { ...DEFAULT_UI_CONFIG, version: 5 };
    expect(reduce(s, delta({ type: "ui_config.changed", config: same, by: "agent" })).uiConfig).toBe(newer);
  });

  it("theme.applied replaces the theme CSS; themes.changed the list", () => {
    let s = reduce(loaded(), delta({ type: "theme.applied", name: "x", css: ":root{--pw-brand:red}", check: { ok: true } as never }));
    expect(s.themeCss).toBe(":root{--pw-brand:red}");
    expect(s.themeCheck).toEqual({ ok: true });
    s = reduce(s, delta({ type: "themes.changed", themes: [{ name: "x" } as never] }));
    expect(s.themes).toHaveLength(1);
  });

  it("settings, layers, tools, ceiling and cron events replace their slices", () => {
    let s = loaded();
    s = reduce(s, delta({ type: "settings.changed", settings: { factoryName: "renamed" } as never, keys: ["factoryName"], by: "ui" }));
    expect(s.settings?.factoryName).toBe("renamed");
    s = reduce(s, delta({ type: "layers.changed", layers: [{ name: "a" } as never] }));
    s = reduce(s, delta({ type: "tools.changed", tools: [{ name: "t" } as never] }));
    s = reduce(s, delta({ type: "ceiling.changed", ceiling: { source: "file" } as never }));
    s = reduce(s, delta({ type: "cron.changed", entries: [{ id: "c" } as never] }));
    expect([s.layers.length, s.tools.length, s.cron.length]).toEqual([1, 1, 1]);
    expect(s.ceiling).toEqual({ source: "file" });
  });

  it("run.recorded upserts newest first and keeps RUNS_KEPT", () => {
    let s = reduce(loaded(), delta({ type: "run.recorded", run: run(5) }));
    s = reduce(s, delta({ type: "run.recorded", run: { ...run(3), prompt: "again" } }));
    expect(s.runs.map((r) => r.id)).toEqual([5, 3]);
    expect(s.runs[1]!.prompt).toBe("again");
    for (let i = 10; i < 40; i++) s = reduce(s, delta({ type: "run.recorded", run: run(i) }));
    expect(s.runs).toHaveLength(RUNS_KEPT);
    expect(s.runs[0]!.id).toBe(39);
  });

  it("layer.changed, cron.fired and ui.open change no slice", () => {
    const s = loaded();
    for (const d of [
      { type: "layer.changed", layer: "x", by: "agent" },
      { type: "cron.fired", cronId: "c", name: "n", slot: 1, submissionId: 2, catchUp: false },
      { type: "ui.open", target: "settings", by: "ui" },
    ] as Delta[]) {
      const next = reduce(s, delta(d));
      const { lastId: _a, ...rest } = next;
      const { lastId: _b, ...before } = s;
      expect(rest).toEqual(before);
      expect(next.chat).toBe(s.chat);
      expect(next.pages).toBe(s.pages);
    }
  });

  it("prompts.changed and models.changed bump their refetch counters and nothing else", () => {
    const s = loaded();
    const p = reduce(s, delta({ type: "prompts.changed", by: "agent" }));
    expect(p.revs).toEqual({ prompts: s.revs.prompts + 1, models: s.revs.models });
    const m = reduce(p, delta({ type: "models.changed", count: 3, fetchedAt: 1 }));
    expect(m.revs).toEqual({ prompts: s.revs.prompts + 1, models: s.revs.models + 1 });
    expect(m.chat).toBe(s.chat);
    expect(m.tools).toBe(s.tools);
  });

  it("chat deltas before any snapshot are ignored without throwing", () => {
    const s = reduce(initialState, delta({ type: "chat.append", items: [user(1)] }));
    expect(s.chat).toBeNull();
  });
});
