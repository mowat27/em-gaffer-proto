import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Temp files carry this suffix so the watcher can ignore them. */
export const TMP_SUFFIX = '.c4tmp';

/** Write a file atomically: temp file in the same directory, then rename. */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(4).toString('hex')}${TMP_SUFFIX}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  const text = await readText(file);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

/** True when `target` equals or is inside `root` (lexical, after resolving). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Like isInside, but resolves symlinks of the deepest existing ancestor. */
export async function isInsideReal(root: string, target: string): Promise<boolean> {
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  let probe = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      return isInside(realRoot, path.join(real, ...tail.reverse()));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

export async function copyDir(from: string, to: string): Promise<void> {
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true, filter: (src) => !src.endsWith(TMP_SUFFIX) });
}
