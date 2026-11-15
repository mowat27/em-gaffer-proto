/**
 * Export and import of project layers (P9, DESIGN 8 "Export and import"). Export writes the layer folder as a `.tgz`
 * into `tsf/data/exports/`; import reads a `.tgz` (local path or https URL) or a layer folder, validates it as a layer
 * and installs it into `tsf/layers/<name>`. The Service holds the `layers` mutex around `installImport` and reloads.
 *
 * Outbound download: the global `fetch`, so the environment's proxy settings (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`,
 * the Agent Vault launch path) apply; no custom agent, no credentials sent, and no proxy value is ever printed.
 * Imports are user-initiated downloads, so the inbound host allow list (`TSF_ALLOWED_HOSTS`) does not apply. https only.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LAYER_NAME, parseJsonManifest } from "../agent/layer-manifest.ts";
import type { ExportLayerResult } from "../shared/types.ts";
import { ServiceError } from "./errors.ts";
import { atomicWrite } from "./fsutil.ts";
import { checkFolderFiles, createTgz, MAX_ARCHIVE_BYTES, parseTgz, type ArchiveFile } from "./layer-archive.ts";
import { collectLayerFiles, type LayerFolder } from "./layer-files.ts";
import type { ProjectPaths } from "./paths.ts";

const EXPORT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:tgz|tar\.gz)$/;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export const exportsDir = (paths: ProjectPaths): string => join(paths.dataDir, "exports");

/** A file name inside `tsf/data/exports` (never a path). */
function requireExportFile(file: unknown): string {
  if (typeof file !== "string" || !EXPORT_FILE.test(file)) {
    throw new ServiceError("invalid", "file must be an archive file name such as extras-0.1.0.tgz (letters, digits, . _ -; ends in .tgz or .tar.gz)");
  }
  return file;
}

/** Archive `folder` into `tsf/data/exports/<to>`; `version` names the default file. */
export async function exportLayerArchive(paths: ProjectPaths, folder: LayerFolder, version: string, to: unknown): Promise<ExportLayerResult> {
  const file = to === undefined ? `${folder.name}-${version}.tgz` : requireExportFile(to);
  requireExportFile(file);
  const files = checkFolderFiles(await collectLayerFiles(folder.dir));
  if (!files.some((f) => f.path === "manifest.json" || f.path === "manifest.ts")) {
    throw new ServiceError("invalid", `layer ${folder.name} has no manifest.json or manifest.ts to export`);
  }
  const tgz = createTgz(files);
  const path = join(exportsDir(paths), file);
  await atomicWrite(path, tgz);
  return { name: folder.name, version, path, file, size: tgz.length, files: files.map((f) => f.path) };
}

/** The bytes of an exported archive, for the download route. `not_found` when it does not exist. */
export async function readExportFile(paths: ProjectPaths, file: unknown): Promise<{ file: string; bytes: Buffer }> {
  const name = requireExportFile(file);
  const path = join(exportsDir(paths), name);
  let st;
  try {
    st = await lstat(path);
  } catch {
    throw new ServiceError("not_found", `no exported archive ${name}`);
  }
  if (!st.isFile()) throw new ServiceError("not_found", `no exported archive ${name}`);
  return { file: name, bytes: await readFile(path) };
}

async function download(url: string): Promise<Buffer> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ServiceError("invalid", "source is not a valid URL");
  }
  if (target.protocol !== "https:") throw new ServiceError("invalid", "only https URLs can be imported");
  if (target.username !== "" || target.password !== "") throw new ServiceError("invalid", "the URL must not carry credentials");
  let res: Response;
  try {
    res = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { accept: "application/gzip, application/octet-stream, */*" } });
  } catch (err) {
    // Never echo the error text: a proxy failure message can carry the proxy address.
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    throw new ServiceError("upstream", `could not download ${target.host}${typeof code === "string" ? ` (${code})` : ""}`);
  }
  if (!res.ok) throw new ServiceError("upstream", `${target.host} answered ${res.status}`);
  if (new URL(res.url || target.href).protocol !== "https:") throw new ServiceError("invalid", "the download redirected away from https");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new ServiceError("too_large", `the archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ServiceError("too_large", `the archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  return bytes;
}

export interface ImportSource {
  readonly files: ArchiveFile[];
  /** The URL the archive came from, for an https source. */
  readonly origin?: string;
}

/** Read the layer files from `source`: an https URL to a .tgz, a local .tgz, or a local layer folder. */
export async function loadImportSource(paths: ProjectPaths, source: unknown): Promise<ImportSource> {
  if (typeof source !== "string" || source.trim() === "" || source.length > 2000) throw new ServiceError("invalid", "source must be a local path or an https URL");
  const text = source.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { files: parseTgz(await download(text)), origin: text };
  const path = resolve(paths.projectRoot, text);
  let st;
  try {
    st = await lstat(path);
  } catch {
    throw new ServiceError("not_found", `no such file or folder: ${text}`);
  }
  if (st.isDirectory()) return { files: checkFolderFiles(await collectLayerFiles(path)) };
  if (!st.isFile()) throw new ServiceError("invalid", `${text} is neither a file nor a folder`);
  if (st.size > MAX_ARCHIVE_BYTES) throw new ServiceError("too_large", `the archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  return { files: parseTgz(await readFile(path)) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Rename a declarative layer: every string `<from>.<name>` (widget, panel, capability ids, hotkey actions, references) becomes `<to>.<name>`. */
function renameStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return new RegExp(`^${from}\\.[a-z0-9_]+$`).test(value) ? `${to}${value.slice(from.length)}` : value;
  if (Array.isArray(value)) return value.map((v) => renameStrings(v, from, to));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameStrings(v, from, to)]));
  return value;
}

export interface ImportPlan {
  readonly name: string;
  readonly files: ArchiveFile[];
}

/**
 * Decide the layer name and validate the layer as `reload` would (`parseJsonManifest`). The name is `requested` or the
 * manifest's own; for a manifest.json layer with no code a different `requested` name renames it (ids follow). A
 * manifest.ts layer cannot be inspected before it is installed, so it needs `requested`. An https source is recorded
 * as the manifest's `origin`.
 */
export function planImport(source: ImportSource, requested: unknown): ImportPlan {
  if (requested !== undefined && (typeof requested !== "string" || !LAYER_NAME.test(requested))) {
    throw new ServiceError("invalid", "name must be a layer name: lowercase letters, digits and underscores, starting with a letter (2..41 characters)");
  }
  const json = source.files.find((f) => f.path === "manifest.json");
  const ts = source.files.find((f) => f.path === "manifest.ts");
  if (json && ts) throw new ServiceError("invalid", "the archive has both manifest.json and manifest.ts; keep one");
  if (!json && !ts) throw new ServiceError("invalid", "the archive has no manifest.json or manifest.ts at its top level");
  if (!json) {
    if (requested === undefined) throw new ServiceError("invalid", "a layer with manifest.ts cannot be read before it is installed: pass name (the layer's own name)");
    return { name: requested, files: source.files };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json.data.toString("utf8"));
  } catch {
    throw new ServiceError("invalid", "manifest.json is not valid JSON");
  }
  if (!isRecord(raw) || typeof raw.name !== "string" || !LAYER_NAME.test(raw.name)) throw new ServiceError("invalid", "manifest.json has no valid name");
  const name = requested ?? raw.name;
  let manifest: Record<string, unknown> = raw;
  let changed = false;
  if (name !== raw.name) {
    if (source.files.some((f) => f.path.endsWith(".ts"))) {
      throw new ServiceError("invalid", `the layer has code (.ts files) and cannot be renamed on import: it is ${raw.name}`);
    }
    manifest = renameStrings(raw, raw.name, name) as Record<string, unknown>;
    manifest.name = name;
    changed = true;
  }
  if (source.origin !== undefined && source.origin.length <= 300 && manifest.origin !== source.origin) {
    manifest = { ...manifest, origin: source.origin };
    changed = true;
  }
  const text = changed ? `${JSON.stringify(manifest, null, 2)}\n` : json.data.toString("utf8");
  try {
    parseJsonManifest(name, text);
  } catch (err) {
    throw new ServiceError("invalid", err instanceof Error ? err.message : String(err));
  }
  return { name, files: source.files.map((f) => (f === json ? { path: f.path, data: Buffer.from(text, "utf8") } : f)) };
}

/**
 * Write the plan into `tsf/layers/<name>` (a dot folder first, then a rename, so a failed import leaves nothing and the
 * registry never sees a half-written layer). Returns true when an existing layer was replaced. Call inside the
 * `layers` mutex.
 */
export async function installImport(paths: ProjectPaths, plan: ImportPlan, replace: boolean): Promise<boolean> {
  await mkdir(paths.layersDir, { recursive: true });
  const target = join(paths.layersDir, plan.name);
  let exists = false;
  try {
    const st = await lstat(target);
    exists = true;
    if (!replace) throw new ServiceError("conflict", `layer ${plan.name} already exists; pass replace: true to overwrite it`);
    if (st.isSymbolicLink()) throw new ServiceError("forbidden", `layer folder ${plan.name} is a symlink; these tools do not write through links`);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const stage = join(paths.layersDir, `.import-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(stage);
    for (const f of plan.files) {
      const file = join(stage, ...f.path.split("/"));
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, f.data);
    }
    let old: string | undefined;
    if (exists) {
      old = join(paths.layersDir, `.old-${randomBytes(4).toString("hex")}`);
      await rename(target, old);
    }
    await rename(stage, target);
    if (old) await rm(old, { recursive: true, force: true });
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return exists;
}
