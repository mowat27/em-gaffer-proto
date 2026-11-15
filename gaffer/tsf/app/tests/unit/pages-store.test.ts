import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../../src/core/errors.ts";
import { silentLogger } from "../../src/core/log.ts";
import { KeyedMutex } from "../../src/core/mutex.ts";
import { applyEdits, PageStore, titleOf } from "../../src/core/pages.ts";
import type { FolderNode, PagePath, TreeNode } from "../../src/shared/types.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

type Call = { changed: PagePath[]; removed: PagePath[]; structureChanged: boolean };

const stores: PageStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await cleanupTmp();
});

async function open(opts: { watch?: boolean } = {}): Promise<{ store: PageStore; dir: string; calls: Call[] }> {
  const root = await tmpDir("tsf-pages");
  const dir = join(root, "pages");
  const calls: Call[] = [];
  const store = new PageStore({
    dir,
    log: silentLogger,
    mutex: new KeyedMutex(),
    debounceMs: 40,
    onExternalChange: (changed, removed, info) => {
      calls.push({ changed, removed, structureChanged: info.structureChanged });
    },
  });
  stores.push(store);
  await store.init();
  if (opts.watch) {
    store.watch();
    // A recursive watch needs a moment before it sees events (FSEvents on macOS).
    await new Promise((r) => setTimeout(r, 200));
  }
  return { store, dir, calls };
}

async function rejects(p: Promise<unknown>, code: ServiceError["code"], message?: RegExp): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  if (message) expect((err as ServiceError).message).toMatch(message);
}

const names = (nodes: readonly TreeNode[]): string[] => nodes.map((n) => (n.kind === "folder" ? `${n.name}/` : n.name));

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("path rules", () => {
  it("appends .md to a page and keeps a folder as it is", async () => {
    const { store } = await open();
    expect(store.normalise("Notes/Hello", "page")).toBe("Notes/Hello.md");
    expect(store.normalise("Notes/Hello.md", "page")).toBe("Notes/Hello.md");
    expect(store.normalise("Notes/Hello", "folder")).toBe("Notes/Hello");
    expect(store.normalise("Notes/Hello.md", "any")).toBe("Notes/Hello.md");
  });

  it.each([
    ["", "empty"],
    ["../x", "traversal"],
    ["a/../b", "traversal inside"],
    ["a/./b", "dot segment"],
    ["a//b", "empty segment"],
    ["a/", "trailing slash"],
    ["/abs/x", "absolute"],
    [".hidden/x", "dot folder"],
    ["a/.x.md", "dot page"],
    ["a\\b", "backslash"],
    ["a\u0000b", "NUL"],
    ["a/b/c/d/e/f/g/h/i", "nine levels"],
    [`${"x".repeat(121)}`, "long segment"],
    ["a.md/b", "folder named .md"],
  ])("rejects %j (%s)", async (path) => {
    const { store } = await open();
    expect(() => store.normalise(path, "page")).toThrow(ServiceError);
  });

  it("accepts eight levels and a 120 character segment", async () => {
    const { store } = await open();
    expect(store.normalise("a/b/c/d/e/f/g/h", "page")).toBe("a/b/c/d/e/f/g/h.md");
    expect(store.normalise("x".repeat(117), "page")).toHaveLength(120);
  });

  it("refuses a folder name that ends in .md and a non-string path", async () => {
    const { store } = await open();
    expect(() => store.normalise("Notes.md", "folder")).toThrow(/cannot end in \.md/);
    expect(() => store.normalise(42, "page")).toThrow(ServiceError);
  });
});

describe("create, read, tree", () => {
  it("creates a page in new nested folders with a default heading, and reads it back", async () => {
    const { store, dir } = await open();
    const page = await store.create("Languages/Python/Basics");
    expect(page.path).toBe("Languages/Python/Basics.md");
    expect(page.content).toBe("# Basics\n");
    expect(page.title).toBe("Basics");
    expect(page.version).toMatch(/^[0-9a-f]{12}$/);
    expect(await readFile(join(dir, "Languages/Python/Basics.md"), "utf8")).toBe("# Basics\n");
    expect(await store.read("Languages/Python/Basics.md")).toEqual(page);
    expect(await store.read("Languages/Python/Basics")).toEqual(page);
  });

  it("refuses to create a page that exists, and reports a missing one as not_found", async () => {
    const { store } = await open();
    await store.create("A.md", "one");
    await rejects(store.create("A.md", "two"), "conflict", /already exists/);
    expect((await store.read("A.md")).content).toBe("one");
    await rejects(store.read("Nope.md"), "not_found");
  });

  it("takes the title from the first # heading, else the file name", async () => {
    const { store } = await open();
    expect((await store.create("T1.md", "intro\n\n# The Title\n")).title).toBe("The Title");
    expect((await store.create("T2.md", "no heading")).title).toBe("T2");
    expect(titleOf("## not h1\n#also not", "x")).toBe("x");
  });

  it("orders the tree: folders first, then pages, each by name with numbers numerically", async () => {
    const { store } = await open();
    await store.create("Page 10.md");
    await store.create("Page 2.md");
    await store.create("b/Inner.md");
    await store.create("a/Inner.md");
    await store.mkdir("c/empty");
    const tree = store.tree();
    expect(tree).toMatchObject({ kind: "folder", path: "", name: "" });
    expect(names(tree.children)).toEqual(["a/", "b/", "c/", "Page 2", "Page 10"]);
    const c = tree.children.find((n) => n.name === "c") as FolderNode;
    expect(names(c.children)).toEqual(["empty/"]);
    const inner = (tree.children[0] as FolderNode).children[0]!;
    expect(inner).toMatchObject({ kind: "page", path: "a/Inner.md", name: "Inner", title: "Inner" });
  });

  it("refuses a path through a symlink that leaves the pages folder", async () => {
    const { store, dir } = await open();
    const outside = await tmpDir("tsf-outside");
    await symlink(outside, join(dir, "link"));
    await rejects(store.create("link/x.md", "no"), "invalid", /leaves the pages folder/);
    await rejects(store.read("link/x.md"), "invalid");
    await expect(readFile(join(outside, "x.md"), "utf8")).rejects.toThrow();
  });

  it("rejects content that is not a string and a page over 1 MB", async () => {
    const { store } = await open();
    await rejects(store.create("A.md", 5 as unknown as string), "invalid");
    await rejects(store.create("Big.md", "x".repeat(1024 * 1024 + 1)), "too_large");
  });
});

describe("update", () => {
  it("replaces the content, and applies edits in order", async () => {
    const { store } = await open();
    await store.create("P.md", "one two three");
    expect((await store.update({ path: "P.md", content: "new" })).content).toBe("new");
    const p = await store.update({
      path: "P.md",
      edits: [
        { oldText: "new", newText: "alpha beta" },
        { oldText: "beta", newText: "$& gamma" },
      ],
    });
    expect(p.content).toBe("alpha $& gamma");
    expect((await store.read("P.md")).content).toBe("alpha $& gamma");
  });

  it("an edit whose oldText is missing or occurs twice fails and changes nothing", async () => {
    const { store } = await open();
    await store.create("P.md", "a b a");
    await rejects(store.update({ path: "P.md", edits: [{ oldText: "zzz", newText: "y" }] }), "invalid", /not found/);
    await rejects(store.update({ path: "P.md", edits: [{ oldText: "a", newText: "y" }] }), "invalid", /more than once/);
    await rejects(store.update({ path: "P.md", edits: [{ oldText: "b", newText: "y" }, { oldText: "zzz", newText: "q" }] }), "invalid");
    await rejects(store.update({ path: "P.md", edits: [{ oldText: "", newText: "y" }] }), "invalid", /empty/);
    expect((await store.read("P.md")).content).toBe("a b a");
  });

  it("needs exactly one of content and edits, and an existing page", async () => {
    const { store } = await open();
    await store.create("P.md", "x");
    await rejects(store.update({ path: "P.md" }), "invalid", /exactly one/);
    await rejects(store.update({ path: "P.md", content: "a", edits: [{ oldText: "x", newText: "y" }] }), "invalid", /exactly one/);
    await rejects(store.update({ path: "Missing.md", content: "a" }), "not_found");
  });

  it("a baseVersion that is not current is a conflict; the current one is accepted", async () => {
    const { store } = await open();
    const v1 = await store.create("P.md", "one");
    const v2 = await store.update({ path: "P.md", content: "two", baseVersion: v1.version });
    await rejects(store.update({ path: "P.md", content: "three", baseVersion: v1.version }), "conflict", /version/);
    expect((await store.read("P.md")).content).toBe("two");
    expect((await store.update({ path: "P.md", content: "three", baseVersion: v2.version })).content).toBe("three");
  });

  it("applyEdits is exported for reuse and rejects an empty list", () => {
    expect(applyEdits("abc", [{ oldText: "b", newText: "B" }])).toBe("aBc");
    expect(() => applyEdits("abc", [])).toThrow(ServiceError);
  });
});

describe("move and remove", () => {
  it("moves a page and creates the parent folders", async () => {
    const { store, dir } = await open();
    await store.create("A.md", "# A");
    const r = await store.move("A.md", "New/Place/B");
    expect(r).toEqual({ from: "A.md", to: "New/Place/B.md", kind: "page", moved: [{ from: "A.md", to: "New/Place/B.md" }] });
    expect(await readFile(join(dir, "New/Place/B.md"), "utf8")).toBe("# A");
    await rejects(store.read("A.md"), "not_found");
    expect(store.hasPage("New/Place/B.md")).toBe(true);
    expect(store.hasPage("A.md")).toBe(false);
  });

  it("moves a folder with its pages", async () => {
    const { store } = await open();
    await store.create("Src/One.md");
    await store.create("Src/Deep/Two.md");
    await store.mkdir("Src/Empty");
    const r = await store.move("Src", "Dst/Moved");
    expect(r.kind).toBe("folder");
    expect([...r.moved].sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: "Src/Deep/Two.md", to: "Dst/Moved/Deep/Two.md" },
      { from: "Src/One.md", to: "Dst/Moved/One.md" },
    ]);
    expect(store.hasFolder("Src")).toBe(false);
    expect(store.hasFolder("Dst/Moved/Empty")).toBe(true);
    expect((await store.read("Dst/Moved/Deep/Two.md")).path).toBe("Dst/Moved/Deep/Two.md");
  });

  it("refuses a target that exists, a move onto itself and a folder into itself", async () => {
    const { store } = await open();
    await store.create("A.md");
    await store.create("B.md");
    await store.create("F/X.md");
    await rejects(store.move("A.md", "B.md"), "conflict");
    await rejects(store.move("A.md", "A.md"), "invalid");
    await rejects(store.move("F", "F/G"), "invalid", /into itself/);
    await rejects(store.move("Nope.md", "C.md"), "not_found");
    await rejects(store.move("F", "F2.md"), "invalid");
  });

  it("finds a page named without .md", async () => {
    const { store } = await open();
    await store.create("Notes/Hello.md");
    expect((await store.move("Notes/Hello", "Notes/Hi")).to).toBe("Notes/Hi.md");
  });

  it("deletes a page; a non-empty folder needs recursive", async () => {
    const { store, dir } = await open();
    await store.create("F/A.md");
    await store.create("F/G/B.md");
    await store.create("Top.md");
    const one = await store.remove("Top.md");
    expect(one).toEqual({ path: "Top.md", kind: "page", removed: ["Top.md"] });
    await rejects(store.remove("F"), "conflict", /not empty/);
    expect(store.hasPage("F/A.md")).toBe(true);
    const all = await store.remove("F", true);
    expect(all.kind).toBe("folder");
    expect([...all.removed].sort()).toEqual(["F/A.md", "F/G/B.md"]);
    expect(store.tree().children).toEqual([]);
    await expect(readFile(join(dir, "F/A.md"), "utf8")).rejects.toThrow();
  });

  it("deletes an empty folder without recursive, and mkdir is idempotent", async () => {
    const { store } = await open();
    const f = await store.mkdir("X/Y");
    expect(f).toMatchObject({ kind: "folder", path: "X/Y", name: "Y", children: [] });
    expect(await store.mkdir("X/Y")).toMatchObject({ path: "X/Y" });
    expect((await store.remove("X/Y")).removed).toEqual([]);
    expect(store.hasFolder("X/Y")).toBe(false);
    expect(store.hasFolder("X")).toBe(true);
    await rejects(store.remove("Nope"), "not_found");
  });
});

describe("external changes", () => {
  it("an external file write triggers onExternalChange once, with the changed path", async () => {
    const { store, dir, calls } = await open({ watch: true });
    await mkdir(join(dir, "Ext"), { recursive: true });
    await writeFile(join(dir, "Ext/New.md"), "# From outside\n");
    await waitFor(() => calls.some((c) => c.changed.includes("Ext/New.md")));
    await new Promise((r) => setTimeout(r, 300));
    const hits = calls.filter((c) => c.changed.includes("Ext/New.md"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ removed: [], structureChanged: true });
    expect(store.hasPage("Ext/New.md")).toBe(true);
    expect(store.tree().children[0]).toMatchObject({ kind: "folder", name: "Ext" });
  });

  it("an external edit of a known page is a content change, not a structure change; a delete is reported removed", async () => {
    const { store, dir, calls } = await open({ watch: true });
    await store.create("P.md", "one");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    await writeFile(join(dir, "P.md"), "two, longer");
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ changed: ["P.md"], removed: [], structureChanged: false });
    await rm(join(dir, "P.md"));
    await waitFor(() => calls.length === 2);
    expect(calls[1]).toEqual({ changed: [], removed: ["P.md"], structureChanged: true });
    expect(store.hasPage("P.md")).toBe(false);
  });

  it("its own writes, moves and deletes cause no callback", async () => {
    const { store, calls } = await open({ watch: true });
    await store.create("A/One.md", "1");
    await store.update({ path: "A/One.md", content: "11" });
    await store.mkdir("B");
    await store.move("A/One.md", "B/One.md");
    await store.create("C.md");
    await store.remove("C.md");
    await store.remove("A", true);
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toEqual([]);
  });

  it("ignores non-markdown files, dot files and files inside a symlinked folder", async () => {
    const { store, dir, calls } = await open({ watch: true });
    const outside = await tmpDir("tsf-outside");
    await writeFile(join(outside, "Secret.md"), "secret");
    await symlink(outside, join(dir, "link"));
    await writeFile(join(dir, "notes.txt"), "x");
    await writeFile(join(dir, ".Hidden.md"), "x");
    await writeFile(join(dir, "Seen.md"), "x");
    await waitFor(() => calls.length > 0);
    expect(calls.flatMap((c) => c.changed)).toEqual(["Seen.md"]);
    expect(store.hasPage("link/Secret.md")).toBe(false);
  });
});
