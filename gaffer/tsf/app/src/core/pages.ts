/**
 * PageStore (DESIGN 4.3): Markdown pages under `tsf/pages`, nested folders, on disk.
 *
 * Path rules: POSIX, relative, no empty, `.` or `..` segment, no segment starting with `.`, no `\` or control
 * character, at most 8 levels, a segment at most 120 characters; a page path ends in `.md` (appended on create), a
 * folder path never does; the resolved real path must stay inside `tsf/pages` (a symlink pointing out is refused).
 *
 * Locking. Write methods (`create`, `update`, `move`, `remove`, `mkdir`) do NOT take the `pages` mutex: the Service
 * holds it across the write, its own state change (selection, focus) and the event, so all of that is one step. The
 * debounced rescan takes the mutex itself and calls `onExternalChange` inside it (so the callback must not take it
 * again; it may return a promise, which the rescan awaits).
 *
 * Own writes versus external ones. `known` maps every page path to its version, size and mtime. Every write updates
 * `known`, the folder set and the in-memory tree before it returns, so the file system event it causes finds nothing
 * new: the rescan re-hashes only files whose size or mtime differ from `known`, and reports only real differences.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  FolderNode,
  Page,
  PageEdit,
  PageNode,
  PagePath,
  PageTree,
  TreeNode,
} from "../shared/types.ts";
import type { DeleteResult, MoveResult, UpdatePageInput } from "./service-api.ts";
import { ServiceError } from "./errors.ts";
import { atomicWrite, isInside, sha12 } from "./fsutil.ts";
import type { Logger } from "./log.ts";
import type { KeyedMutex } from "./mutex.ts";

export const MAX_DEPTH = 8;
export const MAX_SEGMENT = 120;
/** A page's content is at most this many bytes (the HTTP body limit is the same). */
export const MAX_PAGE_BYTES = 1024 * 1024;
/** The `KeyedMutex` key every page write takes (DESIGN 4.2). */
export const PAGES_MUTEX = "pages";

export interface ExternalInfo {
  /** The set of pages or folders changed (a page or folder appeared or disappeared), not only a page's content. */
  readonly structureChanged: boolean;
}

export interface PageStoreOptions {
  /** `<project>/tsf/pages`. */
  dir: string;
  log: Logger;
  mutex: KeyedMutex;
  /** Called inside the `pages` mutex, only for real differences found on disk. */
  onExternalChange: (changed: PagePath[], removed: PagePath[], info: ExternalInfo) => void | Promise<void>;
  /** Default 150. */
  debounceMs?: number;
}

interface Known {
  version: string;
  size: number;
  mtimeMs: number;
  title: string;
}

/** First `# ` heading of the markdown, else `fallback`. */
export function titleOf(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    const m = /^# +(.*\S)\s*$/.exec(line.replace(/\r$/, ""));
    if (m) return m[1]!;
  }
  return fallback;
}

const invalid = (message: string): ServiceError => new ServiceError("invalid", message);

function validSegment(seg: string): boolean {
  return (
    seg !== "" &&
    seg.length <= MAX_SEGMENT &&
    !seg.startsWith(".") &&
    !/[\\\u0000-\u001f\u007f/]/.test(seg)
  );
}

/** Apply `edits` in order; each `oldText` must match exactly once in the text as it is at that point. */
export function applyEdits(text: string, edits: readonly PageEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) throw invalid("edits must be a non-empty list of { oldText, newText }");
  let out = text;
  edits.forEach((edit, i) => {
    const label = `edit ${i + 1}`;
    if (typeof edit !== "object" || edit === null || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw invalid(`${label}: oldText and newText must be strings`);
    }
    if (edit.oldText === "") throw invalid(`${label}: oldText must not be empty`);
    const first = out.indexOf(edit.oldText);
    if (first < 0) throw invalid(`${label}: oldText was not found in the page; read the page again`);
    if (out.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
      throw invalid(`${label}: oldText matches more than once; include more of the surrounding text`);
    }
    out = out.slice(0, first) + edit.newText + out.slice(first + edit.oldText.length);
  });
  return out;
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function checkContent(content: unknown): string {
  if (typeof content !== "string") throw invalid("content must be a string");
  if (Buffer.byteLength(content) > MAX_PAGE_BYTES) {
    throw new ServiceError("too_large", `a page is at most ${MAX_PAGE_BYTES} bytes`);
  }
  return content;
}

const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseName = (p: string): string => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);

export class PageStore {
  readonly #opts: PageStoreOptions;
  readonly #dir: string;
  #realDir = "";
  readonly #known = new Map<PagePath, Known>();
  #folders = new Set<PagePath>();
  #tree: PageTree = { kind: "folder", path: "", name: "", children: [] };
  #watcher: FSWatcher | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(opts: PageStoreOptions) {
    this.#opts = opts;
    this.#dir = opts.dir;
  }

  // --- lifecycle -------------------------------------------------------------------------------------------------

  /** Create the folder, resolve its real path and scan it once (no callback). Call before anything else. */
  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    this.#realDir = await realpath(this.#dir);
    await this.#rescan(false);
  }

  /** Start the file system watch (recursive, debounced). */
  watch(): void {
    if (this.#watcher || this.#closed) return;
    try {
      this.#watcher = fsWatch(this.#dir, { recursive: true }, () => this.#schedule());
      this.#watcher.on("error", (error) => this.#opts.log.error("pages.watch_error", { error }));
    } catch (error) {
      this.#opts.log.error("pages.watch_failed", { dir: this.#dir, error });
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  #schedule(): void {
    if (this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.rescan().catch((error: unknown) => this.#opts.log.error("pages.rescan_failed", { error }));
    }, this.#opts.debounceMs ?? 150);
  }

  /** Rescan the folder under the `pages` mutex and report real differences through `onExternalChange`. */
  rescan(): Promise<void> {
    return this.#opts.mutex.run(PAGES_MUTEX, async () => {
      if (this.#closed) return;
      await this.#rescan(true);
    });
  }

  // --- reads -----------------------------------------------------------------------------------------------------

  /** The in-memory tree, rebuilt by every write and every scan. */
  tree(): PageTree {
    return this.#tree;
  }

  hasFolder(path: PagePath): boolean {
    return this.#folders.has(path);
  }

  hasPage(path: PagePath): boolean {
    return this.#known.has(path);
  }

  /** Validate a path (see the file comment) and return it in canonical form. */
  normalise(path: unknown, kind: "page" | "folder" | "any"): PagePath {
    if (typeof path !== "string") throw invalid("path must be a string");
    if (path === "") throw invalid("path must not be empty");
    if (path.startsWith("/")) throw invalid(`path must be relative to the pages folder, not absolute: ${path}`);
    if (/[\\\u0000-\u001f\u007f]/.test(path)) throw invalid("path must not contain backslashes or control characters");
    const isPage = kind === "page" || (kind === "any" && path.endsWith(".md"));
    let text = path;
    if (kind === "page" && !text.endsWith(".md")) text += ".md";
    const segments = text.split("/");
    if (segments.length > MAX_DEPTH) throw invalid(`path is more than ${MAX_DEPTH} levels deep`);
    for (const seg of segments) {
      if (seg === "") throw invalid("path must not have an empty segment (a doubled or trailing '/')");
      if (seg === "." || seg === "..") throw invalid("path must not contain '.' or '..' segments");
      if (seg.startsWith(".")) throw invalid(`path segments must not start with '.': ${seg}`);
      if (seg.length > MAX_SEGMENT) throw invalid(`a path segment is at most ${MAX_SEGMENT} characters`);
      if (!validSegment(seg)) throw invalid(`invalid path segment: ${seg}`);
    }
    segments.forEach((seg, i) => {
      if (i < segments.length - 1 && seg.endsWith(".md")) throw invalid(`a folder name cannot end in .md: ${seg}`);
    });
    if (!isPage && segments[segments.length - 1]!.endsWith(".md")) throw invalid(`a folder name cannot end in .md: ${text}`);
    return text;
  }

  async read(path: PagePath): Promise<Page> {
    const p = this.normalise(path, "page");
    const abs = await this.#abs(p);
    return await this.#load(p, abs);
  }

  // --- writes (the caller holds the `pages` mutex) -----------------------------------------------------------------

  async create(path: PagePath, content?: string): Promise<Page> {
    const p = this.normalise(path, "page");
    const text = checkContent(content ?? `# ${baseName(p).slice(0, -3)}\n`);
    const abs = await this.#abs(p);
    if (await this.#exists(abs)) throw new ServiceError("conflict", `page already exists: ${p}`);
    await this.#write(abs, text);
    return await this.#record(p, abs, text);
  }

  async update(input: UpdatePageInput): Promise<Page> {
    const p = this.normalise(input.path, "page");
    const hasContent = input.content !== undefined;
    const hasEdits = input.edits !== undefined;
    if (hasContent === hasEdits) throw invalid("provide exactly one of content and edits");
    if (input.baseVersion !== undefined && typeof input.baseVersion !== "string") throw invalid("baseVersion must be a string");
    const abs = await this.#abs(p);
    const current = await this.#readText(p, abs);
    const version = sha12(current);
    if (input.baseVersion !== undefined && input.baseVersion !== version) {
      throw new ServiceError(
        "conflict",
        `the page changed since you read it: its version is ${version}, not ${input.baseVersion}. Read it again and redo the change.`,
      );
    }
    const next = hasContent ? checkContent(input.content) : checkContent(applyEdits(current, input.edits!));
    await this.#write(abs, next);
    return await this.#record(p, abs, next);
  }

  async move(fromIn: PagePath, toIn: PagePath): Promise<MoveResult> {
    const { path: from, kind } = await this.#resolveExisting(fromIn);
    const to = this.normalise(toIn, kind);
    if (from === to) throw invalid("from and to are the same path");
    if (kind === "folder" && to.startsWith(`${from}/`)) throw invalid("a folder cannot be moved into itself");
    const absFrom = await this.#abs(from);
    const absTo = await this.#abs(to);
    const dest = await lstat(absTo).catch(() => undefined);
    if (dest) {
      const src = await lstat(absFrom);
      // A rename that only changes case is the same file on a case-insensitive file system.
      const same = dest.ino === src.ino && dest.dev === src.dev && from.toLowerCase() === to.toLowerCase();
      if (!same) throw new ServiceError("conflict", `${kind === "page" ? "a page" : "a folder"} already exists at ${to}`);
    }
    try {
      await mkdir(dirname(absTo), { recursive: true });
      await rename(absFrom, absTo);
    } catch (err) {
      if (codeOf(err) === "ENOTDIR" || codeOf(err) === "EEXIST") throw new ServiceError("conflict", `cannot move to ${to}: a file is in the way`);
      throw err;
    }
    const moved: { from: PagePath; to: PagePath }[] = [];
    if (kind === "page") {
      this.#known.delete(from);
      this.#addFolders(parentOf(to));
      await this.#recordFromDisk(to, absTo);
      moved.push({ from, to });
    } else {
      for (const [p, k] of [...this.#known]) {
        if (!p.startsWith(`${from}/`)) continue;
        const next = to + p.slice(from.length);
        this.#known.delete(p);
        this.#known.set(next, k);
        moved.push({ from: p, to: next });
      }
      const folders = new Set<PagePath>();
      for (const f of this.#folders) {
        if (f === from || f.startsWith(`${from}/`)) folders.add(to + f.slice(from.length));
        else folders.add(f);
      }
      this.#folders = folders;
      this.#addFolders(to);
    }
    this.#rebuild();
    return { from, to, kind, moved };
  }

  async remove(pathIn: PagePath, recursive?: boolean): Promise<DeleteResult> {
    const { path: p, kind } = await this.#resolveExisting(pathIn);
    const abs = await this.#abs(p);
    const removed: PagePath[] = [];
    if (kind === "page") {
      await unlink(abs);
      this.#known.delete(p);
      removed.push(p);
    } else {
      if (recursive === true) {
        await rm(abs, { recursive: true });
      } else {
        try {
          await rmdir(abs);
        } catch (err) {
          if (codeOf(err) === "ENOTEMPTY" || codeOf(err) === "EEXIST") {
            throw new ServiceError("conflict", `the folder is not empty: ${p}. Pass recursive: true to delete it with everything in it.`);
          }
          throw err;
        }
      }
      for (const k of [...this.#known.keys()]) {
        if (k.startsWith(`${p}/`)) {
          this.#known.delete(k);
          removed.push(k);
        }
      }
      for (const f of [...this.#folders]) if (f === p || f.startsWith(`${p}/`)) this.#folders.delete(f);
    }
    this.#rebuild();
    return { path: p, kind, removed };
  }

  /** `mkdir -p`. Idempotent. */
  async mkdir(path: PagePath): Promise<FolderNode> {
    const p = this.normalise(path, "folder");
    const abs = await this.#abs(p);
    try {
      await mkdir(abs, { recursive: true });
    } catch (err) {
      if (codeOf(err) === "ENOTDIR" || codeOf(err) === "EEXIST") throw new ServiceError("conflict", `cannot create ${p}: a file is in the way`);
      throw err;
    }
    this.#addFolders(p);
    this.#rebuild();
    return this.#folderNode(p)!;
  }

  // --- internals -------------------------------------------------------------------------------------------------

  async #exists(abs: string): Promise<boolean> {
    return (await lstat(abs).catch(() => undefined)) !== undefined;
  }

  /** `abs` with its deepest existing ancestor resolved through symlinks; refused when that leaves the pages folder. */
  async #abs(path: PagePath): Promise<string> {
    const abs = join(this.#dir, ...path.split("/"));
    let probe = abs;
    const rest: string[] = [];
    for (;;) {
      try {
        const real = await realpath(probe);
        const resolved = join(real, ...rest.reverse());
        if (!isInside(this.#realDir, resolved)) throw invalid(`path leaves the pages folder: ${path}`);
        return abs;
      } catch (err) {
        if (err instanceof ServiceError) throw err;
        const code = codeOf(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        const parent = dirname(probe);
        if (parent === probe) throw invalid(`cannot resolve ${path}`);
        rest.push(baseName(probe));
        probe = parent;
      }
    }
  }

  async #readText(path: PagePath, abs: string): Promise<string> {
    try {
      return await readFile(abs, "utf8");
    } catch (err) {
      const code = codeOf(err);
      if (code === "ENOENT" || code === "ENOTDIR") throw new ServiceError("not_found", `no such page: ${path}`);
      if (code === "EISDIR") throw invalid(`${path} is a folder, not a page`);
      throw err;
    }
  }

  async #load(path: PagePath, abs: string): Promise<Page> {
    const content = await this.#readText(path, abs);
    const st = await stat(abs).catch(() => undefined);
    return this.#page(path, content, st?.mtimeMs ?? Date.now());
  }

  #page(path: PagePath, content: string, mtimeMs: number): Page {
    return {
      path,
      title: titleOf(content, baseName(path).slice(0, -3)),
      content,
      version: sha12(content),
      size: Buffer.byteLength(content),
      mtimeMs,
    };
  }

  async #write(abs: string, text: string): Promise<void> {
    try {
      await atomicWrite(abs, text);
    } catch (err) {
      if (codeOf(err) === "ENOTDIR" || codeOf(err) === "EEXIST") throw new ServiceError("conflict", "a file is in the way of that path");
      if (codeOf(err) === "EISDIR") throw invalid("that path is a folder");
      throw err;
    }
  }

  /** After a write: stat the file, update `known`, the folders and the tree. */
  async #record(path: PagePath, abs: string, content: string): Promise<Page> {
    const st = await stat(abs);
    const page = this.#page(path, content, st.mtimeMs);
    this.#known.set(path, { version: page.version, size: st.size, mtimeMs: st.mtimeMs, title: page.title });
    this.#addFolders(parentOf(path));
    this.#rebuild();
    return page;
  }

  async #recordFromDisk(path: PagePath, abs: string): Promise<void> {
    const content = await readFile(abs, "utf8");
    await this.#record(path, abs, content);
  }

  /** The existing page or folder an input path names; `Notes/Hello` also finds the page `Notes/Hello.md`. */
  async #resolveExisting(input: PagePath): Promise<{ path: PagePath; kind: "page" | "folder" }> {
    const p = this.normalise(input, "any");
    const kind = p.endsWith(".md") ? "page" : "folder";
    const st = await lstat(await this.#abs(p)).catch(() => undefined);
    if (kind === "page") {
      if (!st?.isFile()) throw new ServiceError("not_found", `no such page: ${p}`);
      return { path: p, kind };
    }
    if (st?.isDirectory()) return { path: p, kind };
    const asPage = `${p}.md`;
    if (asPage.split("/").length <= MAX_DEPTH) {
      const pst = await lstat(await this.#abs(asPage)).catch(() => undefined);
      if (pst?.isFile()) return { path: asPage, kind: "page" };
    }
    throw new ServiceError("not_found", `no such page or folder: ${p}`);
  }

  #addFolders(path: PagePath): void {
    let p = path;
    while (p !== "") {
      this.#folders.add(p);
      p = parentOf(p);
    }
  }

  async #walk(): Promise<{ files: Map<PagePath, { size: number; mtimeMs: number }>; folders: Set<PagePath> }> {
    const files = new Map<PagePath, { size: number; mtimeMs: number }>();
    const folders = new Set<PagePath>();
    const visit = async (rel: PagePath, depth: number): Promise<void> => {
      const abs = rel === "" ? this.#dir : join(this.#dir, ...rel.split("/"));
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!validSegment(e.name)) continue;
        const path = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (depth + 1 >= MAX_DEPTH || e.name.endsWith(".md")) continue;
          folders.add(path);
          await visit(path, depth + 1);
        } else if (e.isFile() && e.name.endsWith(".md")) {
          const st = await lstat(join(abs, e.name)).catch(() => undefined);
          if (st) files.set(path, { size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    await visit("", 0);
    return { files, folders };
  }

  async #rescan(report: boolean): Promise<void> {
    const { files, folders } = await this.#walk();
    const next = new Map<PagePath, Known>();
    const changed: PagePath[] = [];
    let created = false;
    for (const [path, st] of files) {
      const k = this.#known.get(path);
      if (k && k.size === st.size && k.mtimeMs === st.mtimeMs) {
        next.set(path, k);
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(this.#dir, ...path.split("/")), "utf8");
      } catch {
        continue; // vanished since the listing: the next scan sees it missing
      }
      const version = sha12(content);
      next.set(path, { version, size: st.size, mtimeMs: st.mtimeMs, title: titleOf(content, baseName(path).slice(0, -3)) });
      if (!k) created = true;
      if (!k || k.version !== version) changed.push(path);
    }
    const removed = [...this.#known.keys()].filter((p) => !next.has(p));
    const foldersDiffer = folders.size !== this.#folders.size || [...folders].some((f) => !this.#folders.has(f));
    // Only folders that hold nothing on disk are kept from memory; the walk is the truth.
    let metaChanged = false;
    for (const [p, k] of next) {
      const old = this.#known.get(p);
      if (old && (old.size !== k.size || old.mtimeMs !== k.mtimeMs || old.title !== k.title)) metaChanged = true;
    }
    this.#known.clear();
    for (const [p, k] of next) this.#known.set(p, k);
    this.#folders = folders;
    if (changed.length > 0 || removed.length > 0 || foldersDiffer || metaChanged) this.#rebuild();
    if (!report) return;
    if (changed.length === 0 && removed.length === 0 && !foldersDiffer) return;
    changed.sort();
    removed.sort();
    try {
      await this.#opts.onExternalChange(changed, removed, {
        structureChanged: created || removed.length > 0 || foldersDiffer,
      });
    } catch (error) {
      this.#opts.log.error("pages.external_change_failed", { error });
    }
  }

  #folderNode(path: PagePath): FolderNode | undefined {
    let node: FolderNode = this.#tree;
    if (path === "") return node;
    for (const seg of path.split("/")) {
      const child = node.children.find((c): c is FolderNode => c.kind === "folder" && c.name === seg);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  #rebuild(): void {
    type MutableFolder = { kind: "folder"; path: PagePath; name: string; children: TreeNode[] };
    const root: MutableFolder = { kind: "folder", path: "", name: "", children: [] };
    const byPath = new Map<PagePath, MutableFolder>([["", root]]);
    const ensure = (path: PagePath): MutableFolder => {
      const hit = byPath.get(path);
      if (hit) return hit;
      const folder: MutableFolder = { kind: "folder", path, name: baseName(path), children: [] };
      byPath.set(path, folder);
      ensure(parentOf(path)).children.push(folder);
      return folder;
    };
    for (const f of [...this.#folders].sort()) ensure(f);
    for (const [path, k] of this.#known) {
      const name = baseName(path).slice(0, -3);
      const node: PageNode = { kind: "page", path, name, title: k.title, size: k.size, mtimeMs: k.mtimeMs };
      ensure(parentOf(path)).children.push(node);
    }
    const byName = (a: TreeNode, b: TreeNode): number => a.name.localeCompare(b.name, undefined, { numeric: true });
    const sort = (folder: MutableFolder): void => {
      const folders = folder.children.filter((c): c is MutableFolder => c.kind === "folder").sort(byName);
      const pages = folder.children.filter((c) => c.kind === "page").sort(byName);
      folder.children = [...folders, ...pages];
      folders.forEach(sort);
    };
    sort(root);
    this.#tree = root;
  }
}
