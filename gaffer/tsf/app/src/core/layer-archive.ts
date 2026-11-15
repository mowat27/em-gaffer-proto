/**
 * Layer archives (P9 export and import): a layer folder as a `.tgz` (gzip over a minimal ustar tar), written and read
 * with node's zlib and no dependency. Pure functions over buffers; the Service does the file and network work.
 *
 * Reading is strict: only regular files and folders (symlinks, hard links and devices are refused), every file path
 * must pass `checkRelPath` (relative, no `..`, no dot segment, .json .ts .md only, at most 200 characters), at most
 * `MAX_ENTRIES` files, `MAX_LAYER_FILE_BYTES` each and `MAX_UNPACKED_BYTES` in all. A `./` prefix and one top-level folder
 * that holds the manifest (as `tar czf x.tgz folder/` makes) are stripped. macOS `._*` companion files are skipped.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { ServiceError } from "./errors.ts";
import { checkRelPath, MAX_LAYER_FILE_BYTES } from "./layer-files.ts";

export const MAX_ENTRIES = 500;
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024;
/** Largest archive accepted for import (compressed). */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

export interface ArchiveFile {
  /** POSIX path relative to the layer folder. */
  readonly path: string;
  readonly data: Buffer;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** Split a path of more than 100 characters into ustar `prefix` and `name`, or throw. */
function splitName(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  throw new ServiceError("invalid", `path ${path} is too long for an archive`);
}

/** A gzip-compressed tar of `files` (mode 0644, mtime 0, so the same files give the same bytes). */
export function createTgz(files: readonly ArchiveFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const { prefix, name } = splitName(f.path);
    const h = Buffer.alloc(BLOCK);
    h.write(name, 0, 100, "utf8");
    h.write(octal(0o644, 8), 100, 8, "ascii");
    h.write(octal(0, 8), 108, 8, "ascii");
    h.write(octal(0, 8), 116, 8, "ascii");
    h.write(octal(f.data.length, 12), 124, 12, "ascii");
    h.write(octal(0, 12), 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h.write("0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    parts.push(h, f.data, Buffer.alloc((BLOCK - (f.data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

const cstring = (buf: Buffer, start: number, end: number): string => {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
};

/** The `path=` record of a pax extended header. */
function paxPath(data: Buffer): string | undefined {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) return undefined;
    const len = Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(len) || len <= space - at + 1 || at + len > data.length) return undefined;
    const record = data.subarray(space + 1, at + len - 1).toString("utf8");
    if (record.startsWith("path=")) return record.slice(5);
    at += len;
  }
  return undefined;
}

/** The files of a `.tgz`, checked as described in the file header. Throws a `ServiceError` for anything else. */
export function parseTgz(archive: Buffer): ArchiveFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES + 64 * BLOCK });
  } catch (err) {
    if (err instanceof RangeError) throw new ServiceError("too_large", `the archive unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
    throw new ServiceError("invalid", "the archive is not a gzip-compressed tar (.tgz)");
  }
  const files: ArchiveFile[] = [];
  let total = 0;
  let nextName: string | undefined;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const stored = Number.parseInt(cstring(h, 148, 156).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (stored !== sum) throw new ServiceError("invalid", "the archive is damaged (tar header checksum)");
    if ((h[124]! & 0x80) !== 0) throw new ServiceError("too_large", "the archive has an entry of unsupported size");
    const size = Number.parseInt(cstring(h, 124, 136).trim() || "0", 8);
    if (!Number.isInteger(size) || size < 0 || size > MAX_UNPACKED_BYTES) throw new ServiceError("too_large", `an archive entry is larger than ${MAX_UNPACKED_BYTES} bytes`);
    const type = String.fromCharCode(h[156] === 0 ? 0x30 : h[156]!);
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) throw new ServiceError("invalid", "the archive is truncated");
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      nextName = paxPath(data) ?? nextName;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextName = cstring(data, 0, data.length);
      continue;
    }
    const prefix = cstring(h, 345, 500);
    let path = nextName ?? (prefix === "" ? cstring(h, 0, 100) : `${prefix}/${cstring(h, 0, 100)}`);
    nextName = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "7") {
      throw new ServiceError("invalid", `archive entry ${path}: only regular files and folders are allowed (type ${type})`);
    }
    while (path.startsWith("./")) path = path.slice(2);
    if (path === "" || path === ".") continue;
    if (path.split("/").pop()!.startsWith("._")) continue;
    files.push({ path, data: Buffer.from(data) });
    total += size;
    if (files.length > MAX_ENTRIES) throw new ServiceError("too_large", `the archive has more than ${MAX_ENTRIES} files`);
    if (total > MAX_UNPACKED_BYTES) throw new ServiceError("too_large", `the archive unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
  }
  return checkEntries(stripTopFolder(files));
}

/** One top-level folder that holds the manifest: drop it. */
function stripTopFolder(files: ArchiveFile[]): ArchiveFile[] {
  const isManifest = (p: string) => p === "manifest.json" || p === "manifest.ts";
  if (files.some((f) => isManifest(f.path))) return files;
  const tops = new Set(files.map((f) => f.path.split("/")[0]!));
  if (tops.size !== 1) return files;
  const top = [...tops][0]!;
  if (!files.some((f) => isManifest(f.path.slice(top.length + 1)) && f.path.startsWith(`${top}/`))) return files;
  return files.map((f) => ({ path: f.path.slice(top.length + 1), data: f.data }));
}

/** Every path must be a legal layer file path (this is where `../x` and `/etc/x` are refused); no duplicates. */
function checkEntries(files: ArchiveFile[]): ArchiveFile[] {
  const seen = new Set<string>();
  for (const f of files) {
    try {
      checkRelPath(f.path);
    } catch (err) {
      throw new ServiceError("invalid", `archive entry ${JSON.stringify(f.path)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (seen.has(f.path)) throw new ServiceError("invalid", `archive entry ${f.path} appears twice`);
    seen.add(f.path);
    if (f.data.length > MAX_LAYER_FILE_BYTES) throw new ServiceError("too_large", `archive entry ${f.path} is larger than ${MAX_LAYER_FILE_BYTES} bytes`);
  }
  return files;
}

/** The same checks for files that came from a folder instead of an archive. */
export const checkFolderFiles = checkEntries;
