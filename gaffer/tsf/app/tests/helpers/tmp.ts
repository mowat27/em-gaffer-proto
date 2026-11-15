import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** Create a temp directory (real path, so comparisons with `git rev-parse` and `pwd -P` hold). */
export async function tmpDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), `${prefix}-`)));
  made.push(dir);
  return dir;
}

/** Remove every directory made by `tmpDir` since the last call. */
export async function cleanupTmp(): Promise<void> {
  const dirs = made.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
}
