import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Write `data` to a temp file beside `file`, then rename it over `file`. Creates the parent folder. */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** True when `p` is `root` itself or lies below it (lexical check, no symlink resolution). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** First 12 hex chars of the SHA-256 of `text`. */
export function sha12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
