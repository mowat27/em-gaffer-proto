import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "../../src/shared/events.ts";
import type { ChatItem, Delta } from "../../src/shared/types.ts";
import type { Factory } from "../../src/server/main.ts";
import { LANGUAGES, PAGES_PROMPT, rules, SELECTED_PAGE } from "../fixtures/faux-pages.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

let factory: Factory & { root: string };
let events: AppEvent[];

beforeEach(async () => {
  factory = await createTestFactory({ rules });
  events = [];
  const publish = factory.hub.publish.bind(factory.hub);
  vi.spyOn(factory.hub, "publish").mockImplementation((d: Delta) => {
    if ("type" in d && /^(pages|page|selection)\./.test(d.type)) events.push(d as AppEvent);
    return publish(d);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await factory.close();
  await cleanupTmp();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Send a prompt and wait for the run to end with an assistant answer containing `answer`. */
async function ask(text: string, answer: string): Promise<readonly ChatItem[]> {
  await factory.service.sendMessage({ text, requestId: `r-${Math.random().toString(36).slice(2)}` }, { by: "ui" });
  await until(() => {
    const v = factory.service.chatView();
    return !v.live.busy && v.items.some((i) => i.kind === "assistant" && i.text.includes(answer));
  }, `the answer "${answer}"`);
  return factory.service.chatView().items;
}

const tools = (items: readonly ChatItem[], name?: string): ToolItem[] =>
  items.filter((i): i is ToolItem => i.kind === "tool" && (name === undefined || i.name === name));

describe("the page tools", () => {
  it("registers the nine tools in page_harness with the replay table of DESIGN 7", () => {
    const infos = factory.service.listTools().filter((t) => t.layer === "page_harness");
    const replay = Object.fromEntries(infos.map((t) => [t.name, t.replay]));
    expect(replay).toEqual({
      list_pages: "safe",
      read_page: "safe",
      create_page: "unsafe",
      update_page: "unsafe",
      move_page: "unsafe",
      delete_page: "unsafe",
      create_folder: "unsafe",
      select_page: "safe",
      unselect_page: "safe",
    });
    expect(infos.every((t) => t.offered && t.inCeiling)).toBe(true);
    const layer = factory.service.listLayers().find((l) => l.name === "page_harness")!;
    expect(layer.status).toBe("loaded");
    expect(layer.sections).toEqual(["page_harness-rules"]);
  });

  it("the demo prompt creates Languages/{Python,TypeScript,Rust}/Basics.md and selects one", async () => {
    const items = await ask(PAGES_PROMPT, "I added Languages");

    for (const l of LANGUAGES) {
      const file = join(factory.root, "tsf/pages/Languages", l.folder, "Basics.md");
      expect(await readFile(file, "utf8")).toBe(l.text);
    }
    const created = tools(items, "create_page");
    expect(created).toHaveLength(3);
    const selected = tools(items, "select_page");
    expect(selected).toHaveLength(1);
    for (const t of [...created, ...selected]) expect(t.status).toBe("done");

    const sel = events.filter((e) => e.type === "selection.changed");
    expect(sel).toHaveLength(1);
    expect(sel[0]).toMatchObject({ selection: { path: SELECTED_PAGE, by: "agent" }, focus: { path: SELECTED_PAGE } });
    const snap = factory.service.snapshot();
    expect(snap.selection).toMatchObject({ path: SELECTED_PAGE, by: "agent" });
    expect(snap.focus?.content).toBe(LANGUAGES[0].text);

    const lang = snap.pages.children.find((c) => c.name === "Languages");
    expect(lang?.kind === "folder" && lang.children.map((c) => c.name).sort()).toEqual(["Python", "Rust", "TypeScript"]);

    await sleep(500);
    expect(events.filter((e) => e.type === "page.updated")).toHaveLength(3);
  });

  it("the tool results carry the page JSON, and a failing call is an error the model can read", async () => {
    await factory.service.createPage({ path: "Dup.md", content: "x" }, { by: "ui" });
    const items = await ask('probe create_page {"path":"Dup.md"}', "probe done");
    const t = tools(items, "create_page").at(-1)!;
    expect(t.status).toBe("failed");
    expect(t.output).toContain("page already exists: Dup.md");

    const read = await ask('probe read_page {"path":"Dup.md"}', "probe done");
    const r = tools(read, "read_page").at(-1)!;
    expect(r.status).toBe("done");
    expect(JSON.parse(r.output ?? "{}")).toMatchObject({ path: "Dup.md", content: "x" });
  });

  it("update_page with a stale baseVersion is reported as a conflict, never overwriting", async () => {
    const page = await factory.service.createPage({ path: "V.md", content: "one" }, { by: "ui" });
    await factory.service.updatePage({ path: "V.md", content: "two" }, { by: "ui" });
    const items = await ask(
      `probe update_page ${JSON.stringify({ path: "V.md", content: "agent", baseVersion: page.version })}`,
      "probe done",
    );
    const t = tools(items, "update_page").at(-1)!;
    expect(t.status).toBe("failed");
    expect(t.output).toMatch(/changed since you read it/);
    expect((await factory.service.readPage({ path: "V.md" })).content).toBe("two");
  });
});

describe("external changes to the selected page", () => {
  it("an external write updates snapshot().focus and publishes page.updated; a delete clears the selection", async () => {
    await factory.service.createPage({ path: "Live.md", content: "# Live\n\none" }, { by: "ui" });
    await factory.service.selectPage({ path: "Live.md" }, { by: "ui" });
    await sleep(500); // let the watcher settle after the Service writes
    events.length = 0;
    const file = join(factory.root, "tsf/pages/Live.md");

    await writeFile(file, "# Live\n\ntwo, from an editor");
    await until(() => factory.service.snapshot().focus?.content === "# Live\n\ntwo, from an editor", "the focus to follow the file");
    const updated = events.filter((e) => e.type === "page.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ page: { path: "Live.md", content: "# Live\n\ntwo, from an editor" }, by: "system" });
    expect(factory.service.getSelection().path).toBe("Live.md");

    events.length = 0;
    await rm(file);
    await until(() => factory.service.getSelection().path === null, "the selection to clear");
    expect(factory.service.snapshot().focus).toBeNull();
    expect(events.filter((e) => e.type === "selection.changed")).toHaveLength(1);
    expect(events.find((e) => e.type === "selection.changed")).toMatchObject({ selection: { path: null, by: "system" }, focus: null });
    expect(events.filter((e) => e.type === "page.removed")).toEqual([{ type: "page.removed", path: "Live.md", by: "system" }]);
    expect(events.some((e) => e.type === "pages.changed")).toBe(true);
  });

  it("an external page elsewhere shows up in the tree with pages.changed", async () => {
    await sleep(300);
    events.length = 0;
    await writeFile(join(factory.root, "tsf/pages/Dropped.md"), "# Dropped in\n");
    await until(() => events.some((e) => e.type === "page.updated"), "the page.updated event");
    expect(factory.service.listPages().children.some((c) => c.path === "Dropped.md")).toBe(true);
    expect(events.filter((e) => e.type === "pages.changed")).toHaveLength(1);
    expect(events.find((e) => e.type === "pages.changed")).toMatchObject({ paths: ["Dropped.md"], by: "system" });
    expect(factory.service.getSelection().path).toBe("Start Here.md");
  });

  it("coding_tools write into tsf/pages is picked up like any external edit", async () => {
    await sleep(300);
    events.length = 0;
    const items = await ask('probe write {"path":"tsf/pages/ByAgent/Note.md","content":"# By the write tool\\n"}', "probe done");
    expect(tools(items, "write").at(-1)?.status).toBe("done");
    await until(() => events.some((e) => e.type === "page.updated" && e.page.path === "ByAgent/Note.md"), "page.updated for the written page");
    expect(factory.service.listPages().children.some((c) => c.path === "ByAgent")).toBe(true);
  });
});
