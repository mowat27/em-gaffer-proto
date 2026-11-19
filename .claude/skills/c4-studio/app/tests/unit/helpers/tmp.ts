import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dirs: string[] = [];

export async function tmpDir(prefix = 'c4s-'): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export async function cleanupTmp(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })));
}
