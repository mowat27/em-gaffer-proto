// A lock file in a branch directory that says a headless claude job (possibly in another
// process, e.g. the CLI) is writing the branch. The server's watcher skips its "Edited in
// file" snapshot while the lock is fresh, so the job's own snapshot labels the version.
import fs from 'node:fs';
import path from 'node:path';

export const JOB_LOCK = '.job.lock';
const MAX_AGE_MS = 30 * 60 * 1000;

export function jobLockPath(branchDir: string): string {
  return path.join(branchDir, JOB_LOCK);
}

export function writeJobLock(branchDir: string, info: { jobId: string; label: string }): void {
  try {
    fs.writeFileSync(jobLockPath(branchDir), JSON.stringify({ ...info, at: new Date().toISOString() }));
  } catch {
    // the branch may have been deleted; the job will fail on its own
  }
}

export function clearJobLock(branchDir: string): void {
  try {
    fs.rmSync(jobLockPath(branchDir), { force: true });
  } catch {
    // ignore
  }
}

/** True while a lock exists and is younger than MAX_AGE_MS (a stale lock from a killed process is ignored). */
export function jobLockActive(branchDir: string, now: number = Date.now()): boolean {
  try {
    const st = fs.statSync(jobLockPath(branchDir));
    return now - st.mtimeMs < MAX_AGE_MS;
  } catch {
    return false;
  }
}
