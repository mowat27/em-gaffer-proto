import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { installFaux, type FauxRule } from "../../src/agent/faux.ts";
import { BUILTIN_RULES } from "../../src/agent/faux-rules.ts";
import { ChatFeed, type FeedCommit } from "../../src/agent/feed.ts";
import { createModelCatalog, type ModelCatalog } from "../../src/agent/models.ts";
import { defineAppTool } from "../../src/agent/tools.ts";
import { silentLogger } from "../../src/core/log.ts";
import { settingsDefaults } from "../../src/core/settings.ts";
import type { ChatDelta, ChatItem, ChatView } from "../../src/shared/types.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const ctx = BACKGROUND_CONTEXT;

const slowEcho = defineAppTool({
  name: "slow_echo",
  description: "Echo after a pause.",
  parameters: obj({ text: str() }),
  replay: "unsafe",
  run: async (args) => {
    await new Promise((r) => setTimeout(r, 300));
    return { echoed: args.text };
  },
});

const toolRules: FauxRule[] = [
  {
    name: "use tool",
    match: (t) => t.lastUser === "use tool" && t.toolResults.length === 0,
    reply: () => ({ toolCalls: [{ name: "slow_echo", args: { text: "hi" } }], text: "Calling." }),
  },
  { name: "after tool", match: (t) => t.lastUser === "use tool", reply: () => ({ text: "tool done" }) },
];

interface Setup {
  harness: Harness;
  main: Conversation;
  catalog: ModelCatalog;
  feeds: ChatFeed[];
}
const setups: Setup[] = [];

async function setup(dir?: string): Promise<Setup & { dir: string }> {
  const root = dir ?? (await tmpDir("tsf-feed"));
  await mkdir(join(root, "data"), { recursive: true });
  const catalog = await createModelCatalog({ faux: true, providers: [], log: silentLogger });
  installFaux(catalog.models, { rules: [...toolRules, ...BUILTIN_RULES], tokensPerSecond: 2_000 });
  const registry = createRegistry();
  const ext = defineExtension({ name: "test_tools", tools: [slowEcho] });
  registry.install(ext);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(root, "data", "agent.sqlite")),
    { models: () => catalog.models, registry, settings: { extensions: [ext] } },
    ctx,
  );
  const main = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  harness.resume();
  const s: Setup = { harness, main, catalog, feeds: [] };
  setups.push(s);
  return { ...s, dir: root };
}

function feedFor(s: Setup): ChatFeed {
  const settings = settingsDefaults("/p/proj", []);
  const feed = new ChatFeed(s.main, {
    catalog: s.catalog,
    settings: () => settings,
    toolLayer: (n) => (n === "slow_echo" ? "test_tools" : undefined),
    log: silentLogger,
  });
  s.feeds.push(feed);
  return feed;
}

afterEach(async () => {
  for (const s of setups.splice(0)) {
    for (const f of s.feeds) await f.stop();
    await s.harness.close(ctx);
  }
});
afterAll(cleanupTmp);

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function run(s: Setup, text: string, requestId: string): Promise<void> {
  const submission = await s.main.submit({ type: "input", content: text, requestId }, ctx);
  await submission.wait(ctx);
}

/** The minimal client reducer (DESIGN 11 "State"). */
function reduce(view: ChatView, d: ChatDelta): ChatView {
  switch (d.type) {
    case "chat.append": {
      const ids = new Set(view.items.map((i) => i.id));
      return { ...view, items: [...view.items, ...d.items.filter((i) => !ids.has(i.id))] };
    }
    case "chat.update": {
      const by = new Map(d.items.map((i) => [i.id, i] as const));
      return { ...view, items: view.items.map((i) => by.get(i.id) ?? i) };
    }
    case "chat.live":
      return { ...view, live: d.live };
    case "chat.meta":
      return { ...view, meta: d.meta };
    case "chat.reset":
      return d.chat;
  }
}

const kinds = (items: readonly ChatItem[]) => items.map((i) => i.kind);

describe("ChatFeed", () => {
  it("start() resolves on a quiet conversation and view() holds the existing entries", async () => {
    const s = await setup();
    await run(s, "ping", "chat:1");
    await s.harness.waitForIdle(ctx);
    const feed = feedFor(s);
    let deltas = 0;
    feed.onDelta(() => deltas++);
    await feed.start();
    const view = feed.view();
    expect(kinds(view.items)).toEqual(["user", "assistant"]);
    expect(view.items.find((i) => i.kind === "assistant")).toMatchObject({ text: "pong" });
    expect(view.live.busy).toBe(false);
    expect(view.meta.model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(feed.current().added.length).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(deltas).toBe(0);
  });

  it("deltas applied in order equal view(); append, update, live and meta are split; holes send no reset", async () => {
    const s = await setup();
    const feed = feedFor(s);
    await feed.start();
    let client = feed.view();
    const deltas: ChatDelta[] = [];
    const commits: FeedCommit[] = [];
    feed.onDelta((d) => {
      deltas.push(d);
      client = reduce(client, d);
    });
    feed.onCommit((c) => commits.push(c));

    await run(s, "ping", "chat:a");
    await run(s, "use tool", "chat:b");
    await run(s, "ping", "chat:c");
    await until(() => !feed.view().live.busy && feed.view().items.filter((i) => i.kind === "assistant").length >= 4);
    await new Promise((r) => setTimeout(r, 100));

    expect(client).toEqual(feed.view());
    const types = new Set(deltas.map((d) => d.type));
    expect(types.has("chat.append")).toBe(true);
    expect(types.has("chat.update")).toBe(true);
    expect(types.has("chat.live")).toBe(true);
    expect(types.has("chat.meta")).toBe(true);
    expect(types.has("chat.reset")).toBe(false);

    const tool = feed.view().items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ name: "slow_echo", layer: "test_tools", status: "done", output: '{"echoed":"hi"}' });
    const update = deltas.find((d) => d.type === "chat.update");
    expect(update && update.type === "chat.update" && update.items[0]!.kind).toBe("tool");

    // Entry ids have holes (task ids share the id space); nothing treats them as missed entries.
    const ids = feed.view().items.map((i) => i.entryId);
    expect(ids.some((id, i) => i > 0 && id - ids[i - 1]! > 1)).toBe(true);

    // onCommit gets every value raw: the entries it added cover every entry of the view, once.
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      expect(c.value.docs).toBeDefined();
      expect(typeof c.at).toBe("number");
    }
    const added = commits.flatMap((c) => c.added.map((e) => e.id as number));
    expect(new Set(added).size).toBe(added.length);
    for (const item of feed.view().items) {
      if (item.kind !== "tool") expect(added).toContain(item.entryId);
    }
    expect(feed.current()).toBe(commits[commits.length - 1]);
  });

  it("loadEarlier pages entries before an id, oldest first", async () => {
    const s = await setup();
    await run(s, "ping", "chat:1");
    await run(s, "use tool", "chat:2");
    await s.harness.waitForIdle(ctx);
    const feed = feedFor(s);
    await feed.start();
    const lastUser = [...feed.view().items].reverse().find((i) => i.kind === "user")!;
    const page = await feed.loadEarlier({ before: lastUser.entryId, limit: 50 });
    expect(kinds(page.items)).toEqual(["user", "assistant"]);
    expect(page.hasEarlier).toBe(false);
    const all = await feed.loadEarlier({ before: 1_000_000 });
    const tool = all.items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "done" });
  });

  it("stop() ends the watch and no more deltas arrive", async () => {
    const s = await setup();
    const feed = feedFor(s);
    await feed.start();
    await feed.stop();
    let deltas = 0;
    feed.onDelta(() => deltas++);
    await run(s, "ping", "chat:z");
    await new Promise((r) => setTimeout(r, 200));
    expect(deltas).toBe(0);
  });

  it("gives up after 5 listener_error restarts in a minute: onFatal fires once, never process.exit", async () => {
    const s = await setup();
    const real: { stop(): Promise<unknown> }[] = [];
    // Every watch the feed opens reports `listener_error` at once, so the feed restarts until its limit.
    const failing = new Proxy(s.main, {
      get(target, prop) {
        if (prop === "watch") {
          return async (...args: Parameters<Conversation["watch"]>) => {
            const w = await target.watch(...args);
            real.push(w);
            return new Proxy(w, {
              get(t, p) {
                if (p === "closed") return Promise.resolve({ kind: "listener_error", error: new Error("boom") });
                const v = Reflect.get(t, p, t) as unknown;
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
    }) as typeof process.exit;
    try {
      const feed = feedFor({ ...s, main: failing });
      const fatal: Error[] = [];
      feed.onFatal((e) => fatal.push(e));
      await feed.start();
      for (let i = 0; i < 50 && fatal.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(fatal).toHaveLength(1);
      expect(fatal[0]!.message).toMatch(/restarted 5 times/);
      expect(real).toHaveLength(6);
      let late = 0;
      feed.onFatal(() => late++);
      expect(late).toBe(1);
      expect(exited).toBe(false);
    } finally {
      process.exit = exit;
      for (const w of real) await w.stop().catch(() => undefined);
    }
  });
});
