import { describe, expect, it } from "vitest";
import { actionFor, matchHotkey, type KeyLike } from "../../src/web/lib/hotkeys.ts";
import { pageForLink } from "../../src/web/common/Markdown.tsx";
import { DEFAULT_UI_CONFIG, type PageTree } from "../../src/shared/types.ts";

const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe("matchHotkey", () => {
  it("matches a single key in either case and refuses it with ctrl, meta or alt", () => {
    expect(matchHotkey(key("s"), "s")).toBe(true);
    expect(matchHotkey(key("S", { shiftKey: true }), "s")).toBe(true);
    expect(matchHotkey(key("s", { ctrlKey: true }), "s")).toBe(false);
    expect(matchHotkey(key("s", { metaKey: true }), "s")).toBe(false);
    expect(matchHotkey(key("s", { altKey: true }), "s")).toBe(false);
    expect(matchHotkey(key("["), "[")).toBe(true);
    expect(matchHotkey(key("x"), "s")).toBe(false);
  });
  it("matches mod+key with ctrl or meta", () => {
    expect(matchHotkey(key("k", { ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchHotkey(key("k", { metaKey: true }), "mod+k")).toBe(true);
    expect(matchHotkey(key("k"), "mod+k")).toBe(false);
    expect(matchHotkey(key("k", { ctrlKey: true, altKey: true }), "mod+k")).toBe(false);
  });
  it("never matches an empty spec", () => {
    expect(matchHotkey(key("s"), "")).toBe(false);
    expect(matchHotkey(key("s"), "mod+")).toBe(false);
  });
  it("finds the action in the default table", () => {
    expect(actionFor(key("s"), DEFAULT_UI_CONFIG.hotkeys)).toBe("settings.open");
    expect(actionFor(key("r"), DEFAULT_UI_CONFIG.hotkeys)).toBe("cron.open");
    expect(actionFor(key("q"), DEFAULT_UI_CONFIG.hotkeys)).toBeNull();
  });
});

describe("pageForLink", () => {
  const page = (path: string) => ({ kind: "page" as const, path, name: path, title: path, size: 1, mtimeMs: 1 });
  const tree: PageTree = {
    kind: "folder",
    path: "",
    name: "",
    children: [
      page("Start Here.md"),
      { kind: "folder", path: "Languages", name: "Languages", children: [page("Languages/Rust.md"), page("Languages/Notes.md")] },
    ],
  };
  it("resolves relative to the open page, then from the root, with or without .md", () => {
    expect(pageForLink(tree, "Languages/Rust.md", "Notes")).toBe("Languages/Notes.md");
    expect(pageForLink(tree, "Languages/Rust.md", "./Notes.md")).toBe("Languages/Notes.md");
    expect(pageForLink(tree, "Languages/Rust.md", "../Start%20Here")).toBe("Start Here.md");
    expect(pageForLink(tree, "Languages/Rust.md", "Start Here.md#top")).toBe("Start Here.md");
    expect(pageForLink(tree, null, "Languages/Rust")).toBe("Languages/Rust.md");
  });
  it("leaves external links, anchors and unknown pages alone", () => {
    expect(pageForLink(tree, null, "https://example.com")).toBeNull();
    expect(pageForLink(tree, null, "mailto:a@b.c")).toBeNull();
    expect(pageForLink(tree, null, "#section")).toBeNull();
    expect(pageForLink(tree, null, "Missing")).toBeNull();
    expect(pageForLink(tree, null, "../../x")).toBeNull();
  });
});
