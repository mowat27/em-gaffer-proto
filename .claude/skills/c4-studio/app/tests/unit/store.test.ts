import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdr } from '../../src/core/adrs.ts';
import { skeletonDsl, Store, StoreError } from '../../src/core/store.ts';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

afterEach(cleanupTmp);

async function newStore() {
  const dir = await tmpDir();
  return new Store(path.join(dir, 'models'));
}

describe('store', () => {
  it('creates a model with the c4-modeller skeleton and an init version', async () => {
    const store = await newStore();
    const m = await store.createModel({ name: 'Internet Banking', description: 'Bank "online"' });
    expect(m.slug).toBe('internet-banking');
    expect(m.defaultBranch).toBe('main');
    expect(m.versionCount).toBe(1);
    const { dsl } = await store.readBranch(m.slug, 'main');
    expect(dsl).toBe(skeletonDsl('Internet Banking', 'Bank "online"'));
    expect(dsl).toContain('workspace "Internet Banking" "Bank \\"online\\""');
    expect(dsl).toContain('!identifiers hierarchical');
    expect(dsl).toContain('internetBanking = softwareSystem "Internet Banking"');
    expect(dsl).toContain('systemContext internetBanking "system-context"');
    expect(dsl).toContain('container internetBanking "containers"');
    const versions = await store.listVersions(m.slug, 'main');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ source: 'init', parent: null, branch: 'main' });
    await expect(store.createModel({ name: 'Internet Banking' })).rejects.toMatchObject({ status: 409 });
    const files = await fs.readdir(path.join(store.modelDir(m.slug), 'branches', 'main'));
    expect(files.sort()).toEqual(['adrs', 'layout.json', 'workspace.dsl']);
    expect((await fs.readdir(store.modelDir(m.slug))).sort()).toEqual(['branches', 'history', 'lineage.json', 'model.json']);
  });

  it('snapshots only when the DSL or ADRs changed', async () => {
    const store = await newStore();
    const { slug } = await store.createModel({ name: 'Shop' });
    expect(await store.snapshot(slug, 'main', { source: 'cli', message: 'nothing' })).toBeNull();
    const v1 = await store.writeDsl(slug, 'main', 'workspace "Shop" {\n}\n', { source: 'ui', message: 'edit' });
    expect(v1).toMatchObject({ source: 'ui', message: 'edit' });
    // same content again: deduped
    expect(await store.writeDsl(slug, 'main', 'workspace "Shop" {\n}\n', { source: 'ui', message: 'again' })).toBeNull();
    // layout-only change never creates a version
    await store.setViewLayout(slug, 'main', 'containers', { elements: { a: { x: 1, y: 2 } } });
    expect(await store.snapshot(slug, 'main', { source: 'cli', message: 'layout' })).toBeNull();
    // ADR change does
    const { version } = await store.mutate(slug, 'main', { source: 'ui', message: 'adr' }, (p) =>
      createAdr(p.adrs, { title: 'Use Postgres', context: 'c', decision: 'd', consequences: 'q' }),
    );
    expect(version).not.toBeNull();
    const versions = await store.listVersions(slug, 'main');
    expect(versions.map((v) => v.message)).toEqual(['adr', 'edit', 'Model created']);
    // parent chain
    expect(versions[0]!.parent).toBe(versions[1]!.id);
    // the current layout is part of every snapshot
    const snap = await store.getVersion(slug, versions[0]!.id);
    expect(snap.layout.views.containers?.elements.a).toEqual({ x: 1, y: 2 });
    expect(snap.adrs).toHaveLength(1);
  });

  it('forks a branch from the working copy and from a version', async () => {
    const store = await newStore();
    const { slug } = await store.createModel({ name: 'Shop' });
    const v1 = (await store.writeDsl(slug, 'main', 'workspace "v1" {\n}\n', { source: 'ui', message: 'v1' }))!;
    await store.writeDsl(slug, 'main', 'workspace "v2" {\n}\n', { source: 'ui', message: 'v2' });

    const info = await store.createBranch(slug, { name: 'feature' });
    expect(info).toMatchObject({ name: 'feature', parent: 'main' });
    expect((await store.readBranch(slug, 'feature')).dsl).toContain('v2');
    const fv = await store.listVersions(slug, 'feature');
    expect(fv).toHaveLength(1);
    expect(fv[0]).toMatchObject({ source: 'fork', parent: info.forkedFrom });

    await store.createBranch(slug, { name: 'old', from: { branch: 'main', version: v1.id } });
    expect((await store.readBranch(slug, 'old')).dsl).toContain('v1');
    expect((await store.getLineage(slug)).branches.old!.forkedFrom).toBe(v1.id);

    await expect(store.createBranch(slug, { name: 'feature' })).rejects.toMatchObject({ status: 409 });
    await expect(store.createBranch(slug, { name: 'Bad Name' })).rejects.toBeInstanceOf(StoreError);
    // branches are independent
    await store.writeDsl(slug, 'feature', 'workspace "f" {\n}\n', { source: 'ui', message: 'f' });
    expect((await store.readBranch(slug, 'main')).dsl).toContain('v2');
  });

  it('rolls back by restoring DSL and ADRs and recording a rollback version', async () => {
    const store = await newStore();
    const { slug } = await store.createModel({ name: 'Shop' });
    const v1 = (await store.writeDsl(slug, 'main', 'workspace "one" {\n}\n', { source: 'ui', message: 'one' }))!;
    await store.mutate(slug, 'main', { source: 'ui', message: 'two + adr' }, async (p) => {
      await fs.writeFile(p.workspace, 'workspace "two" {\n}\n');
      await createAdr(p.adrs, { title: 'A', context: '', decision: '', consequences: '' });
    });
    await store.setViewLayout(slug, 'main', 'v', { elements: { x: { x: 5, y: 5 } } });
    const rb = await store.rollback(slug, 'main', v1.id);
    expect(rb).toMatchObject({ source: 'rollback', message: `Rollback to ${v1.id}` });
    const head = await store.headVersion(slug, 'main');
    expect(head!.id).toBe(rb!.id);
    const { dsl, layout, paths } = await store.readBranch(slug, 'main');
    expect(dsl).toContain('"one"');
    expect(await fs.readdir(paths.adrs)).toEqual([]);
    expect(layout.views.v).toBeDefined(); // layout kept
    await expect(store.rollback(slug, 'main', 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('deleting a branch keeps its versions; deleting the default branch is refused', async () => {
    const store = await newStore();
    const { slug } = await store.createModel({ name: 'Shop' });
    await store.createBranch(slug, { name: 'tmp' });
    await store.writeDsl(slug, 'tmp', 'workspace "t" {\n}\n', { source: 'ui', message: 't' });
    const before = (await store.getLineage(slug)).versions.length;
    await store.deleteBranch(slug, 'tmp');
    const lineage = await store.getLineage(slug);
    expect(lineage.branches.tmp).toBeUndefined();
    expect(lineage.versions).toHaveLength(before);
    expect(lineage.versions.filter((v) => v.branch === 'tmp')).toHaveLength(2);
    await expect(fs.access(store.branchPaths(slug, 'tmp').dir)).rejects.toThrow();
    // history of the deleted branch is still readable and forkable
    const v = lineage.versions.find((x) => x.branch === 'tmp' && x.message === 't')!;
    expect((await store.getVersion(slug, v.id)).dsl).toContain('"t"');
    await store.createBranch(slug, { name: 'again', from: { branch: 'tmp', version: v.id } });
    expect((await store.readBranch(slug, 'again')).dsl).toContain('"t"');
    await expect(store.deleteBranch(slug, 'main')).rejects.toMatchObject({ status: 400 });
    await expect(store.deleteBranch(slug, 'ghost')).rejects.toMatchObject({ status: 404 });
  });

  it('deletes a model and lists models newest first', async () => {
    const store = await newStore();
    await store.createModel({ name: 'One' });
    await new Promise((r) => setTimeout(r, 5));
    await store.createModel({ name: 'Two' });
    expect((await store.listModels()).map((m) => m.slug)).toEqual(['two', 'one']);
    await store.deleteModel('one');
    expect((await store.listModels()).map((m) => m.slug)).toEqual(['two']);
    await expect(store.getModel('one')).rejects.toMatchObject({ status: 404 });
  });

  it('imports DSL verbatim as an init version', async () => {
    const store = await newStore();
    const text = '// my file\nworkspace "Imported" {\n}\n';
    const m = await store.importModel({ name: 'Imported', description: '', dsl: text, sourceLabel: 'docs/x.dsl' });
    expect(m.slug).toBe('imported');
    expect((await store.readBranch('imported', 'main')).dsl).toBe(text);
    const [v] = await store.listVersions('imported', 'main');
    expect(v).toMatchObject({ source: 'init', message: 'Imported from docs/x.dsl' });
    await expect(store.importModel({ name: 'Imported', dsl: text, sourceLabel: 'text' })).rejects.toMatchObject({ status: 409 });
  });

  it('writes atomically without leaving temp files', async () => {
    const store = await newStore();
    const { slug } = await store.createModel({ name: 'Shop' });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.writeDsl(slug, 'main', `workspace "w${i}" {\n}\n`, { source: 'ui', message: `m${i}` })));
    const names = await fs.readdir(store.branchPaths(slug, 'main').dir);
    expect(names.filter((n) => n.endsWith('.c4tmp'))).toEqual([]);
    expect((await store.listVersions(slug, 'main')).length).toBe(11);
  });
});
