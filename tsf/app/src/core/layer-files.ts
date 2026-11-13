/**
 * The files of a layer folder (P9, DESIGN 8 "Authoring"): listing, reading, confined writes and deletes. A layer
 * path is POSIX, relative to the folder, with no absolute form, no `..`, no dot segment and no symlink anywhere along
 * it (every existing component is `lstat`-ed); only .json, .ts and .md files; 256 KiB at most. Project layers only
 * are writable; built-in layers can be listed and read. The caller (Service) holds the `layers` mutex and reloads.
 */
import { lstat, mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { LAYER_NAME } from "../agent/layer-manifest.ts";
import { BUILTIN_LAYERS } from "../agent/registry.ts";
import type { LayerFileContent, LayerFileEntry, LayerFileList } from "../shared/types.ts";
import { ServiceError } from "./errors.ts";
import { atomicWrite } from "./fsutil.ts";
import type { ProjectPaths } from "./paths.ts";

export const MAX_LAYER_FILE_BYTES = 256 * 1024;
const EXTENSIONS = [".json", ".ts", ".md"] as const;
const MAX_LISTED = 500;
const MAX_DEPTH = 4;
/** Files that define the layer: deleting them is deleting the layer. */
const MANIFEST_FILES = new Set(["manifest.json", "manifest.ts"]);

export type LayerSource = "builtin" | "project";

export interface LayerFolder {
  readonly name: string;
  readonly source: LayerSource;
  readonly dir: string;
}

export function requireLayerName(name: unknown): string {
  if (typeof name !== "string" || !LAYER_NAME.test(name)) {
    throw new ServiceError("invalid", "name must be a layer name: lowercase letters, digits and underscores, starting with a letter (2..41 characters)");
  }
  return name;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The folder of layer `name`: a built-in, else a project layer. `not_found` when neither exists. */
export async function findLayerFolder(paths: ProjectPaths, name: unknown): Promise<LayerFolder> {
  const n = requireLayerName(name);
  if ((BUILTIN_LAYERS as readonly string[]).includes(n)) {
    const dir = join(paths.builtinLayersDir, n);
    if (await isDir(dir)) return { name: n, source: "builtin", dir };
  }
  const dir = join(paths.layersDir, n);
  let st;
  try {
    st = await lstat(dir);
  } catch {
    throw new ServiceError("not_found", `no such layer: ${n}; list_layers shows the layers`);
  }
  // A symlinked folder is a layer the registry may load, but never one these tools write into or delete.
  if (!st.isDirectory() && !st.isSymbolicLink()) throw new ServiceError("not_found", `no such layer: ${n}; list_layers shows the layers`);
  return { name: n, source: "project", dir };
}

/** A project layer folder these tools may change (not a built-in, not a symlink). */
export async function requireEditable(paths: ProjectPaths, name: unknown): Promise<LayerFolder> {
  const folder = await findLayerFolder(paths, name);
  if (folder.source === "builtin") throw new ServiceError("forbidden", `layer ${folder.name} is built in and cannot be changed; only project layers can`);
  if ((await lstat(folder.dir)).isSymbolicLink()) throw new ServiceError("forbidden", `layer folder ${folder.name} is a symlink; these tools do not write through links`);
  return folder;
}

/** Lexical checks on a layer-relative path; returns its segments. */
export function checkRelPath(path: unknown): string[] {
  if (typeof path !== "string" || path === "" || path.length > 200) throw new ServiceError("invalid", "path must be a relative file path of at most 200 characters");
  if (path.includes("\0") || path.includes("\\")) throw new ServiceError("invalid", "path must use / and contain no control characters");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new ServiceError("invalid", "path must be relative to the layer folder, not absolute");
  const parts = path.split("/");
  for (const p of parts) {
    if (p === "" ) throw new ServiceError("invalid", "path must not have empty segments");
    if (p === "." || p === "..") throw new ServiceError("invalid", "path must not contain . or .. segments");
    if (p.startsWith(".")) throw new ServiceError("invalid", "path segments must not start with a dot");
  }
  if (parts.length > MAX_DEPTH + 1) throw new ServiceError("invalid", `path must be at most ${MAX_DEPTH + 1} segments deep`);
  if (!EXTENSIONS.some((e) => path.endsWith(e))) throw new ServiceError("invalid", `only ${EXTENSIONS.join(", ")} files are allowed`);
  return parts;
}

/** The absolute path of `path` in `folder`; every existing component must be a real directory or file (no symlink). */
async function confine(folder: LayerFolder, path: unknown): Promise<string> {
  const parts = checkRelPath(path);
  let cur = folder.dir;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (st.isSymbolicLink()) throw new ServiceError("forbidden", `${parts.slice(0, i + 1).join("/")} is a symlink; links are not followed`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new ServiceError("invalid", `${parts.slice(0, i + 1).join("/")} is not a folder`);
  }
  return join(folder.dir, ...parts);
}

async function walk(root: string, rel: string, depth: number, out: LayerFileEntry[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_LISTED) return;
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(root, path, depth + 1, out);
    else if (e.isFile() && !e.name.includes(".tmp-")) {
      const st = await lstat(join(root, path));
      out.push({ path, size: st.size });
    }
  }
}

export async function listLayerFiles(paths: ProjectPaths, name: unknown): Promise<LayerFileList> {
  const folder = await findLayerFolder(paths, name);
  const files: LayerFileEntry[] = [];
  await walk(folder.dir, "", 0, files);
  return { name: folder.name, source: folder.source, editable: folder.source === "project", files };
}

export async function readLayerFile(paths: ProjectPaths, name: unknown, path: unknown): Promise<LayerFileContent> {
  const folder = await findLayerFolder(paths, name);
  const file = await confine(folder, path);
  let st;
  try {
    st = await lstat(file);
  } catch {
    throw new ServiceError("not_found", `layer ${folder.name} has no file ${String(path)}; list_layer_files shows them`);
  }
  if (!st.isFile()) throw new ServiceError("invalid", `${String(path)} is not a file`);
  if (st.size > MAX_LAYER_FILE_BYTES) throw new ServiceError("too_large", `${String(path)} is larger than ${MAX_LAYER_FILE_BYTES} bytes`);
  return { name: folder.name, path: String(path), size: st.size, content: await readFile(file, "utf8") };
}

/** Write one file of a project layer (creating folders below it). Returns the written size. */
export async function writeLayerFile(paths: ProjectPaths, name: unknown, path: unknown, content: unknown): Promise<{ name: string; path: string; size: number }> {
  if (typeof content !== "string") throw new ServiceError("invalid", "content must be a string");
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_LAYER_FILE_BYTES) throw new ServiceError("too_large", `content is ${size} bytes; the limit is ${MAX_LAYER_FILE_BYTES}`);
  const folder = await requireEditable(paths, name);
  const file = await confine(folder, path);
  try {
    if ((await lstat(file)).isDirectory()) throw new ServiceError("invalid", `${String(path)} is a folder`);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
  }
  await mkdir(dirname(file), { recursive: true });
  // mkdir may have followed nothing new, but re-check the parent chain once more before writing.
  await confine(folder, path);
  await atomicWrite(file, content);
  return { name: folder.name, path: String(path), size };
}

/** Delete one file of a project layer; the manifest cannot be deleted this way. */
export async function deleteLayerFile(paths: ProjectPaths, name: unknown, path: unknown): Promise<{ name: string; path: string }> {
  const folder = await requireEditable(paths, name);
  const parts = checkRelPath(path);
  if (parts.length === 1 && MANIFEST_FILES.has(parts[0]!)) {
    throw new ServiceError("forbidden", "the manifest cannot be deleted; delete_layer removes the whole layer");
  }
  const file = await confine(folder, path);
  let st;
  try {
    st = await lstat(file);
  } catch {
    throw new ServiceError("not_found", `layer ${folder.name} has no file ${String(path)}; list_layer_files shows them`);
  }
  if (!st.isFile()) throw new ServiceError("invalid", `${String(path)} is not a file`);
  await rm(file);
  // Tidy up an emptied subfolder (never the layer folder itself).
  for (let dir = dirname(file); dir !== folder.dir && dir.startsWith(folder.dir + sep); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      break;
    }
  }
  return { name: folder.name, path: String(path) };
}

/** Remove a whole project layer folder. */
export async function deleteLayerFolder(paths: ProjectPaths, name: unknown): Promise<string> {
  const folder = await requireEditable(paths, name);
  await rm(folder.dir, { recursive: true, force: true });
  return folder.name;
}

/** Read a project layer's manifest.json text, or null when it has none (manifest.ts layer). */
export async function readJsonManifestText(folder: LayerFolder): Promise<string | null> {
  try {
    return await readFile(join(folder.dir, "manifest.json"), "utf8");
  } catch {
    return null;
  }
}

/**
 * The files an export archives (and an import from a folder copies): every .json, .ts and .md file below the folder
 * (dot entries, node_modules, temp files and symlinks skipped), sorted by path, at most MAX_DEPTH folders deep.
 */
export async function collectLayerFiles(dir: string): Promise<Array<{ path: string; data: Buffer }>> {
  const out: Array<{ path: string; data: Buffer }> = [];
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name.includes(".tmp-")) continue;
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await visit(path, depth + 1);
      else if (e.isFile() && EXTENSIONS.some((x) => e.name.endsWith(x))) {
        const data = await readFile(join(dir, path));
        if (data.length > MAX_LAYER_FILE_BYTES) throw new ServiceError("too_large", `${path} is larger than ${MAX_LAYER_FILE_BYTES} bytes`);
        out.push({ path, data });
      }
    }
  };
  await visit("", 0);
  if (out.length > MAX_LISTED) throw new ServiceError("too_large", `the layer has more than ${MAX_LISTED} files`);
  return out;
}
