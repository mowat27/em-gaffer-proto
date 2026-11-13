import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEvent } from "../../src/shared/events.ts";
import type { Delta, FolderNode, Page, PageTree, Selection, Snapshot } from "../../src/shared/types.ts";
import type { DeleteResult, MoveResult } from "../../src/core/service-api.ts";
import type { Factory } from "../../src/server/main.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

let factory: Factory & { root: string };
let events: AppEvent[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  factory = await createTestFactory();
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

async function get(path: string): Promise<Response> {
  return await factory.app.request(`/api/${path}`);
}
async function post(path: string, body: unknown = {}): Promise<Response> {
  return await factory.app.request(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const types = (): string[] => events.map((e) => e.type);
const count = (type: string): number => events.filter((e) => e.type === type).length;

/** Wait past the watcher's debounce so a duplicate event, if the Service write caused one, has arrived. */
async function settle(): Promise<void> {
  await sleep(500);
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("a fresh factory", () => {
  it("selects Start Here.md and the snapshot's focus holds it", async () => {
    const sel = (await (await get("pages")).json()) as PageTree;
    expect(sel.children.map((c) => c.path)).toContain("Start Here.md");
    const snap = factory.service.snapshot();
    expect(snap.selection).toMatchObject({ path: "Start Here.md", by: "system" });
    expect(snap.focus).toMatchObject({ path: "Start Here.md" });
    expect(snap.focus!.content.length).toBeGreaterThan(0);
    expect(snap.pages).toEqual(sel);
    expect(factory.service.getSelection().path).toBe("Start Here.md");
  });

  it("restores the selection after a restart, and a missing file clears it", async () => {
    await post("pages/create", { path: "Keep.md", content: "# Keep" });
    await post("pages/select", { path: "Keep.md" });
    const root = factory.root;
    await factory.close();
    factory = await createTestFactory({ project: root });
    expect(factory.service.snapshot().selection).toMatchObject({ path: "Keep.md", by: "ui" });
    expect(factory.service.snapshot().focus).toMatchObject({ path: "Keep.md", content: "# Keep" });
    await factory.close();
    const { rm } = await import("node:fs/promises");
    await rm(`${root}/tsf/pages/Keep.md`);
    factory = await createTestFactory({ project: root });
    const snap: Snapshot = factory.service.snapshot();
    expect(snap.selection.path).toBeNull();
    expect(snap.focus).toBeNull();
  });
});

describe("POST /api/pages/create and GET read", () => {
  it("creates a page (200), publishes pages.changed and page.updated exactly once, and reads it", async () => {
    const res = await post("pages/create", { path: "Notes/Hello", content: "# Hello\n\nbody" });
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page).toMatchObject({ path: "Notes/Hello.md", title: "Hello", content: "# Hello\n\nbody" });
    await settle();
    expect(types()).toEqual(["pages.changed", "page.updated"]);
    expect(events[0]).toMatchObject({ type: "pages.changed", paths: ["Notes/Hello.md"], by: "ui" });
    expect(events[1]).toMatchObject({ type: "page.updated", by: "ui" });

    const read = await get("pages/read?path=Notes/Hello.md");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(page);
    const tree = (await (await get("pages")).json()) as PageTree;
    expect(JSON.stringify(tree)).toContain("Notes/Hello.md");
  });

  it("answers 409 for an existing page, 400 for a bad path or body, 404 for a missing page", async () => {
    await post("pages/create", { path: "A.md" });
    expect((await post("pages/create", { path: "A.md" })).status).toBe(409);
    expect((await post("pages/create", { path: "../x" })).status).toBe(400);
    expect((await post("pages/create", { path: "a/./b" })).status).toBe(400);
    expect((await post("pages/create", {})).status).toBe(400);
    expect((await post("pages/create", { path: "B.md", content: 5 })).status).toBe(400);
    expect((await get("pages/read")).status).toBe(400);
    expect((await get("pages/read?path=Missing.md")).status).toBe(404);
    expect(await errorCode(await get("pages/read?path=Missing.md"))).toBe("not_found");
    expect((await get("pages/read?path=../../etc/passwd")).status).toBe(400);
    const bad = await factory.app.request("/api/pages/create", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect((await post("pages/nope")).status).toBe(404);
  });

  it("parallel creates of one path give one success", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post("pages/create", { path: "Race.md", content: `# ${i}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    await settle();
    expect(count("page.updated")).toBe(1);
    expect(count("pages.changed")).toBe(1);
  });
});

describe("POST /api/pages/update", () => {
  it("replaces content or applies edits, publishing page.updated exactly once", async () => {
    const created = (await (await post("pages/create", { path: "P.md", content: "one two" })).json()) as Page;
    events.length = 0;
    const res = await post("pages/update", { path: "P.md", edits: [{ oldText: "two", newText: "three" }], baseVersion: created.version });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Page).content).toBe("one three");
    await settle();
    expect(types()).toEqual(["page.updated"]);
    expect((await post("pages/update", { path: "P.md", content: "whole" })).status).toBe(200);
    expect(((await (await get("pages/read?path=P.md")).json()) as Page).content).toBe("whole");
  });

  it("400 for both or neither of content and edits, or a failed edit; 404 for a missing page", async () => {
    await post("pages/create", { path: "P.md", content: "x x" });
    expect((await post("pages/update", { path: "P.md" })).status).toBe(400);
    expect((await post("pages/update", { path: "P.md", content: "a", edits: [{ oldText: "x", newText: "y" }] })).status).toBe(400);
    expect((await post("pages/update", { path: "P.md", edits: [{ oldText: "x", newText: "y" }] })).status).toBe(400);
    expect((await post("pages/update", { path: "P.md", edits: "nope" })).status).toBe(400);
    expect((await post("pages/update", { path: "Missing.md", content: "a" })).status).toBe(404);
  });

  it("20 parallel updates with the same baseVersion give one 200 and 19 conflicts", async () => {
    const created = (await (await post("pages/create", { path: "C.md", content: "start" })).json()) as Page;
    events.length = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post("pages/update", { path: "C.md", content: `writer ${i}`, baseVersion: created.version })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const lost = results.filter((r) => r.status === 409);
    expect(lost).toHaveLength(19);
    expect(await errorCode(lost[0]!)).toBe("conflict");
    await settle();
    expect(count("page.updated")).toBe(1);
  });
});

describe("move, delete, folders", () => {
  it("moves a page and a folder; the selection follows; events once", async () => {
    await post("pages/create", { path: "Src/One.md", content: "# One" });
    await post("pages/create", { path: "Src/Two.md", content: "# Two" });
    await post("pages/select", { path: "Src/One.md" });
    events.length = 0;
    const res = await post("pages/move", { from: "Src", to: "Dst" });
    expect(res.status).toBe(200);
    const moved = (await res.json()) as MoveResult;
    expect(moved.kind).toBe("folder");
    expect(moved.moved.map((m) => m.to).sort()).toEqual(["Dst/One.md", "Dst/Two.md"]);
    await settle();
    expect(types()).toEqual(["pages.changed", "selection.changed"]);
    expect(events[1]).toMatchObject({ type: "selection.changed", selection: { path: "Dst/One.md", by: "ui" }, focus: { path: "Dst/One.md", content: "# One" } });
    expect(factory.service.snapshot().focus?.path).toBe("Dst/One.md");

    events.length = 0;
    expect((await post("pages/move", { from: "Dst/Two.md", to: "Elsewhere/Two" })).status).toBe(200);
    await settle();
    expect(types()).toEqual(["pages.changed"]);
    expect((await post("pages/move", { from: "Dst/One.md", to: "Elsewhere/Two.md" })).status).toBe(409);
    expect((await post("pages/move", { from: "Nope.md", to: "X.md" })).status).toBe(404);
    expect((await post("pages/move", { from: "Dst", to: "Dst/In" })).status).toBe(400);
  });

  it("deletes a page; a non-empty folder needs recursive; the selection clears inside", async () => {
    await post("pages/create", { path: "F/A.md" });
    await post("pages/create", { path: "F/G/B.md" });
    await post("pages/select", { path: "F/G/B.md" });
    expect((await post("pages/delete", { path: "F" })).status).toBe(409);
    events.length = 0;
    const res = await post("pages/delete", { path: "F", recursive: true });
    expect(res.status).toBe(200);
    const out = (await res.json()) as DeleteResult;
    expect([...out.removed].sort()).toEqual(["F/A.md", "F/G/B.md"]);
    await settle();
    expect(count("pages.changed")).toBe(1);
    expect(events.filter((e) => e.type === "page.removed").map((e) => (e as { path: string }).path).sort()).toEqual(["F/A.md", "F/G/B.md"]);
    expect(count("selection.changed")).toBe(1);
    expect(factory.service.getSelection().path).toBeNull();
    expect(factory.service.snapshot().focus).toBeNull();
    expect((await post("pages/delete", { path: "F" })).status).toBe(404);
    expect((await post("pages/delete", { path: "x.md", recursive: "yes" })).status).toBe(400);
  });

  it("create-folder is idempotent and publishes pages.changed only for a new folder", async () => {
    const res = await post("pages/create-folder", { path: "Deep/Er" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as FolderNode)).toMatchObject({ kind: "folder", path: "Deep/Er", name: "Er" });
    await settle();
    expect(types()).toEqual(["pages.changed"]);
    events.length = 0;
    expect((await post("pages/create-folder", { path: "Deep/Er" })).status).toBe(200);
    await settle();
    expect(events).toEqual([]);
    expect((await post("pages/create-folder", { path: "Bad.md" })).status).toBe(400);
  });
});

describe("select and unselect", () => {
  it("selects a page (selection.changed carries the focus), and unselects", async () => {
    await post("pages/create", { path: "S.md", content: "# S" });
    events.length = 0;
    const res = await post("pages/select", { path: "S.md" });
    expect(res.status).toBe(200);
    expect((await res.json()) as Selection).toMatchObject({ path: "S.md", by: "ui" });
    await settle();
    expect(types()).toEqual(["selection.changed"]);
    expect(events[0]).toMatchObject({ focus: { path: "S.md", content: "# S" } });
    expect(factory.service.snapshot().focus?.content).toBe("# S");

    events.length = 0;
    const un = await post("pages/unselect");
    expect(un.status).toBe(200);
    expect((await un.json()) as Selection).toMatchObject({ path: null });
    expect(types()).toEqual(["selection.changed"]);
    expect(factory.service.snapshot().focus).toBeNull();
    events.length = 0;
    expect((await post("pages/unselect")).status).toBe(200);
    expect(events).toEqual([]);
  });

  it("a missing page is 404 and leaves the selection alone", async () => {
    const before = factory.service.getSelection();
    expect((await post("pages/select", { path: "Missing.md" })).status).toBe(404);
    expect(factory.service.getSelection()).toEqual(before);
  });

  it("a Service update of the selected page refreshes the focus", async () => {
    await post("pages/create", { path: "S.md", content: "one" });
    await post("pages/select", { path: "S.md" });
    await post("pages/update", { path: "S.md", content: "two" });
    expect(factory.service.snapshot().focus?.content).toBe("two");
  });
});
