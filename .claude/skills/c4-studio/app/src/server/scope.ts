import fs from 'node:fs/promises';
import path from 'node:path';
import { isInsideReal } from '../core/fsutil.ts';
import { findC4Modeller } from '../core/paths.ts';
import type { StudioContext } from './service.ts';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite']);

export class ScopeError extends Error {
  status = 400 as const;
}

/** Roots that file tools may read: the project and the two skill directories. */
export function allowedRoots(ctx: Pick<StudioContext, 'projectRoot' | 'skillDir'>): string[] {
  const roots = [ctx.projectRoot, ctx.skillDir];
  const c4 = findC4Modeller(ctx.projectRoot, ctx.skillDir);
  if (c4) roots.push(c4);
  return roots;
}

/** Resolve a user-supplied path (relative to the project root) and make sure it stays inside an allowed root. */
export async function resolveScoped(ctx: Pick<StudioContext, 'projectRoot' | 'skillDir'>, p: string): Promise<string> {
  if (typeof p !== 'string' || p.includes('\0')) throw new ScopeError('invalid path');
  const abs = path.resolve(ctx.projectRoot, p || '.');
  for (const root of allowedRoots(ctx)) {
    if (await isInsideReal(root, abs)) return abs;
  }
  throw new ScopeError(`path is outside the project: ${p}`);
}

/** Convert a glob (`*`, `**`, `?`) to a RegExp over forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface WalkOptions {
  glob?: string;
  maxFiles?: number;
  maxDepth?: number;
}

/** Recursively list files under `dir` (absolute), as paths relative to `dir`, skipping node_modules, .git and dist. */
export async function walkFiles(dir: string, opts: WalkOptions = {}): Promise<string[]> {
  const re = opts.glob ? globToRegExp(opts.glob) : null;
  const max = opts.maxFiles ?? 2000;
  const maxDepth = opts.maxDepth ?? 12;
  const out: string[] = [];
  async function visit(abs: string, rel: string, depth: number): Promise<void> {
    if (out.length >= max || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await visit(path.join(abs, e.name), r, depth + 1);
      } else if (e.isFile() && (!re || re.test(r))) out.push(r);
    }
  }
  await visit(dir, '', 0);
  return out;
}

/** Immediate children of a directory: files and sub-directories, skipping noise. */
export async function listDir(dir: string): Promise<{ files: string[]; dirs: string[] }> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) dirs.push(e.name);
    } else if (e.isFile()) files.push(e.name);
  }
  return { files, dirs };
}
