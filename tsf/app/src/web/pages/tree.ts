/** Pure helpers over the page tree (shared types). Used by the tree, the dialogs and the focus view. */
import type { FolderNode, PagePath, PageTree, TreeNode } from "../../shared/types.ts";

/** The page that a fresh install opens on, and the empty state offers. */
export const START_PAGE: PagePath = "Start Here.md";

/** "Languages/Python/Basics.md" -> "Languages/Python"; a top-level path gives "". */
export function parentOf(path: PagePath): PagePath {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Every folder above a path, outermost first: "a/b/c.md" -> ["a", "a/b"]. */
export function ancestorsOf(path: PagePath): PagePath[] {
  const parts = path.split("/");
  const out: PagePath[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** The last segment without the ".md" of a page. */
export function displayName(path: PagePath): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.endsWith(".md") ? last.slice(0, -3) : last;
}

export function findNode(tree: PageTree | null | undefined, path: PagePath): TreeNode | null {
  if (!tree) return null;
  const walk = (nodes: readonly TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.kind === "folder" && path.startsWith(`${n.path}/`)) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(tree.children);
}

export function hasPage(tree: PageTree | null | undefined, path: PagePath): boolean {
  return findNode(tree, path)?.kind === "page";
}

/** Pages inside a folder, at any depth. */
export function countPages(node: TreeNode): number {
  if (node.kind === "page") return 1;
  return node.children.reduce((sum, c) => sum + countPages(c), 0);
}

export function isEmptyFolder(node: FolderNode): boolean {
  return node.children.length === 0;
}
