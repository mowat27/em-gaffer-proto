import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdr, deleteAdr, getAdr, listAdrs, parseAdr, renderAdr, updateAdr } from '../../src/core/adrs.ts';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

afterEach(cleanupTmp);

const input = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  context: `Why ${title}`,
  decision: `We do ${title}`,
  consequences: `After ${title}`,
  ...extra,
});

describe('adrs', () => {
  it('round-trips frontmatter and sections', async () => {
    const dir = path.join(await tmpDir(), 'adrs');
    const adr = await createAdr(dir, input('Use PostgreSQL!', { elements: ['shop.db', 'shop.api'], date: '2026-10-31', status: 'accepted' }));
    expect(adr).toMatchObject({ id: '0001', file: '0001-use-postgresql.md', status: 'accepted', date: '2026-10-31', elements: ['shop.db', 'shop.api'] });
    const text = await fs.readFile(path.join(dir, adr.file), 'utf8');
    const fm = matter(text);
    expect(fm.data.id).toBe('0001');
    expect(fm.content).toContain('## Context');
    expect(fm.content).toContain('## Decision');
    expect(fm.content).toContain('## Consequences');
    const back = await getAdr(dir, '0001');
    expect(back).toEqual(adr);
    expect(parseAdr(renderAdr(adr), adr.file)).toEqual(adr);
  });

  it('numbers sequentially and survives deletes', async () => {
    const dir = path.join(await tmpDir(), 'adrs');
    expect((await createAdr(dir, input('One'))).id).toBe('0001');
    expect((await createAdr(dir, input('Two'))).id).toBe('0002');
    expect((await createAdr(dir, input('Three'))).id).toBe('0003');
    await deleteAdr(dir, '0002');
    expect((await createAdr(dir, input('Four'))).id).toBe('0004');
    expect((await listAdrs(dir)).map((a) => a.id)).toEqual(['0001', '0003', '0004']);
    await expect(getAdr(dir, '0002')).rejects.toMatchObject({ status: 404 });
  });

  it('maintains supersedes and supersededBy both ways', async () => {
    const dir = path.join(await tmpDir(), 'adrs');
    await createAdr(dir, input('Old', { status: 'accepted' }));
    const next = await createAdr(dir, input('New', { supersedes: '0001', status: 'accepted' }));
    expect(next.supersedes).toBe('0001');
    const old = await getAdr(dir, '0001');
    expect(old).toMatchObject({ status: 'superseded', supersededBy: '0002' });

    // changing supersedes clears the old link
    await createAdr(dir, input('Other', { status: 'accepted' }));
    await updateAdr(dir, '0002', input('New', { supersedes: '0003' }));
    expect(await getAdr(dir, '0001')).toMatchObject({ status: 'accepted' });
    expect((await getAdr(dir, '0001')).supersededBy).toBeUndefined();
    expect(await getAdr(dir, '0003')).toMatchObject({ status: 'superseded', supersededBy: '0002' });

    // deleting the superseding ADR clears supersededBy
    await deleteAdr(dir, '0002');
    expect((await getAdr(dir, '0003')).supersededBy).toBeUndefined();
    await expect(createAdr(dir, input('Bad', { supersedes: '0099' }))).rejects.toMatchObject({ status: 400 });
  });

  it('renames the file when the title changes and keeps the id', async () => {
    const dir = path.join(await tmpDir(), 'adrs');
    await createAdr(dir, input('Before'));
    const updated = await updateAdr(dir, '0001', input('After the change'));
    expect(updated.file).toBe('0001-after-the-change.md');
    expect(await fs.readdir(dir)).toEqual(['0001-after-the-change.md']);
  });

  it('reads hand-written ADRs with unquoted dates and ids', () => {
    const text = '---\nid: 7\ntitle: Hand written\nstatus: accepted\ndate: 2026-01-02\n---\n\n## Context\n\nA\n\n## Decision\n\nB\n';
    const adr = parseAdr(text, '0007-hand-written.md');
    expect(adr).toMatchObject({ id: '0007', date: '2026-01-02', context: 'A', decision: 'B', consequences: '' });
  });
});
