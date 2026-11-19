import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearJobLock, jobLockActive, jobLockPath, writeJobLock } from '../../src/core/joblock.ts';

describe('job lock', () => {
  it('is active while fresh, ignored when stale, gone after clear', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-joblock-'));
    expect(jobLockActive(dir)).toBe(false);
    writeJobLock(dir, { jobId: 'j1', label: 'update: test' });
    expect(fs.existsSync(jobLockPath(dir))).toBe(true);
    expect(jobLockActive(dir)).toBe(true);
    expect(jobLockActive(dir, Date.now() + 31 * 60 * 1000)).toBe(false);
    clearJobLock(dir);
    expect(jobLockActive(dir)).toBe(false);
  });
});
