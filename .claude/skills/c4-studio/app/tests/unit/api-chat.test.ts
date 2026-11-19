import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

process.env.C4_STUDIO_VALIDATOR = 'none';
vi.mock('../../src/core/dsl/index.ts', async () => await import('./helpers/fake-dsl.ts'));

const { createStudio } = await import('../../src/server/app.ts');
const { buildTools, TOOL_NAMES } = await import('../../src/server/chat/tools.ts');
const { buildSystemPrompt } = await import('../../src/server/chat/system-prompt.ts');
const { chatProviders } = await import('../../src/server/chat/providers.ts');
const { defaultConfig } = await import('../../src/core/config.ts');

let studio: Awaited<ReturnType<typeof createStudio>>;
let root: string;

beforeAll(async () => {
  root = await tmpDir('c4s-chat-');
  studio = await createStudio({ projectRoot: root, watch: false });
  await studio.ctx.service.createModel({ name: 'Shop' });
  await fs.writeFile(path.join(root, 'README.md'), 'hello shop\nsecond line');
});
afterAll(async () => {
  await studio.close();
  await cleanupTmp();
});

// tools are invoked the way the AI SDK does: execute(input, options)
async function call(name: string, input: unknown = {}): Promise<any> {
  const tools = buildTools(studio.ctx, 'shop', 'main') as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  return tools[name]!.execute(input, { toolCallId: 't', messages: [] });
}

describe('chat tools', () => {
  it('exposes exactly the documented tool list', () => {
    const tools = buildTools(studio.ctx, 'shop', 'main');
    expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('reads the model', async () => {
    const m = await call('get_model');
    expect(m.dsl).toContain('softwareSystem "Shop"');
    expect(m.elements).toEqual([{ id: 'shop', kind: 'softwareSystem', name: 'Shop' }]);
    expect(m.views.map((v: { key: string }) => v.key)).toEqual(['system-context', 'containers']);
    expect((await call('get_element', { id: 'shop' })).element.name).toBe('Shop');
    expect((await call('get_element', { id: 'zzz' })).ok).toBe(false);
    expect((await call('list_views')).views).toHaveLength(2);
    expect((await call('list_relationships')).relationships).toEqual([]);
  });

  it('edit_model writes an agent version; a failing edit writes nothing and returns the error', async () => {
    const ok = await call('edit_model', { ops: [{ op: 'addElement', parent: null, kind: 'person', name: 'Customer' }], message: 'add customer' });
    expect(ok).toMatchObject({ ok: true, created: ['customer'] });
    const [head] = await studio.ctx.store.listVersions('shop', 'main');
    expect(head).toMatchObject({ source: 'agent', message: 'add customer' });
    const before = (await studio.ctx.store.readBranch('shop', 'main')).dsl;
    const bad = await call('edit_model', { ops: [{ op: 'setRelationship', id: 'a', description: 'b' }], message: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    expect((await studio.ctx.store.readBranch('shop', 'main')).dsl).toBe(before);
  });

  it('replace_dsl returns the parse error and leaves the file alone', async () => {
    const before = (await studio.ctx.store.readBranch('shop', 'main')).dsl;
    const bad = await call('replace_dsl', { dsl: 'workspace {\nSYNTAX_ERROR\n}', message: 'oops' });
    expect(bad).toMatchObject({ ok: false, parseError: { line: 2 } });
    expect((await studio.ctx.store.readBranch('shop', 'main')).dsl).toBe(before);
    const good = await call('replace_dsl', { dsl: before.replace('Customer', 'Client'), message: 'rename' });
    expect(good.ok).toBe(true);
    expect((await call('get_model')).elements.map((e: { name: string }) => e.name)).toContain('Client');
  });

  it('patch_dsl replaces exact text, and writes nothing when a find does not match once', async () => {
    const before = (await studio.ctx.store.readBranch('shop', 'main')).dsl;
    expect((await call('patch_dsl', { edits: [{ find: 'no such text', replace: 'x' }], message: 'm' })).error).toMatch(/not found/);
    expect((await call('patch_dsl', { edits: [{ find: 'include *', replace: 'include *' }], message: 'm' })).error).toMatch(/occurs \d+ times/);
    expect((await call('patch_dsl', { edits: [{ find: 'workspace', replace: 'SYNTAX_ERROR', all: true }], message: 'm' })).ok).toBe(false);
    expect((await studio.ctx.store.readBranch('shop', 'main')).dsl).toBe(before);
    const ok = await call('patch_dsl', { edits: [{ find: 'softwareSystem "Shop"', replace: 'softwareSystem "Shop $& Co"' }], message: 'rename shop' });
    expect(ok.ok).toBe(true);
    expect((await call('get_model')).elements.find((e: { id: string }) => e.id === 'shop').name).toBe('Shop $& Co');
    const [head] = await studio.ctx.store.listVersions('shop', 'main');
    expect(head).toMatchObject({ source: 'agent', message: 'rename shop' });
  });

  it('scopes file tools to the project and the skill directories', async () => {
    expect((await call('read_file', { path: 'README.md' })).content).toContain('hello shop');
    expect((await call('read_file', { path: 'README.md', maxLines: 1 })).truncated).toBe(true);
    expect((await call('read_file', { path: '../../../../etc/hosts' })).ok).toBe(false);
    expect((await call('read_file', { path: '/etc/hosts' })).ok).toBe(false);
    expect((await call('list_files', { dir: '..' })).ok).toBe(false);
    expect((await call('list_files', {})).files).toContain('README.md');
    const found = await call('search_files', { pattern: 'second', glob: '*.md' });
    expect(found.matches).toEqual([{ file: 'README.md', line: 2, text: 'second line' }]);
    expect((await call('search_files', { pattern: '(' })).ok).toBe(false);
    // a symlink out of the project is refused
    await fs.symlink('/etc', path.join(root, 'escape')).catch(() => undefined);
    expect((await call('read_file', { path: 'escape/hosts' })).ok).toBe(false);
    // skills
    expect((await call('read_skill', { name: '../x' })).ok).toBe(false);
    expect((await call('read_skill', { name: 'c4-studio', file: '../../etc/hosts' })).ok).toBe(false);
  });

  it('manages ADRs and branches', async () => {
    const added = await call('add_adr', { title: 'Use Redis', context: 'c', decision: 'd', consequences: 'q' });
    expect(added).toMatchObject({ ok: true, id: '0001' });
    expect((await call('list_adrs')).adrs).toHaveLength(1);
    expect((await call('get_adr', { id: '0001' })).adr).toMatchObject({ title: 'Use Redis', decision: 'd', status: 'proposed' });
    expect(await call('update_adr', { id: '0001', status: 'accepted' })).toMatchObject({ ok: true, status: 'accepted', title: 'Use Redis' });
    expect((await call('get_adr', { id: '0001' })).adr).toMatchObject({ status: 'accepted', context: 'c', decision: 'd', consequences: 'q' });
    expect((await call('update_adr', { id: '0009', status: 'accepted' })).ok).toBe(false);
    await call('add_adr', { title: 'Temp', context: '', decision: 'x', consequences: '' });
    expect(await call('delete_adr', { id: '0002' })).toMatchObject({ ok: true, deleted: '0002' });
    expect((await call('list_adrs')).adrs).toHaveLength(1);
    const b = await call('create_branch', { name: 'idea' });
    expect(b).toMatchObject({ ok: true, branch: 'idea' });
    expect((await call('create_branch', { name: 'idea' })).ok).toBe(false);
  });
});

describe('chat route', () => {
  it('lists providers and reports missing keys', () => {
    const list = chatProviders(defaultConfig(), {});
    expect(list.find((p) => p.id === 'anthropic')).toMatchObject({ available: false, reason: 'Set ANTHROPIC_API_KEY in c4-studio/.env' });
    expect(chatProviders(defaultConfig(), { OPENROUTER_API_KEY: 'x' }).find((p) => p.id === 'openrouter')!.available).toBe(true);
    expect(list.map((p) => p.defaultModel)).toEqual(['anthropic/claude-sonnet-5.5', 'accounts/fireworks/models/kimi-k3', 'claude-sonnet-5-5', 'opus']);
  });

  it('rejects bad requests with JSON errors', async () => {
    const post = (body: unknown) => studio.app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ask = { chatId: 'chat-test-1', message: { id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    expect((await post({})).status).toBe(400);
    expect((await post({ ...ask, model: 'ghost', branch: 'main', provider: 'anthropic' })).status).toBe(404);
    expect((await post({ ...ask, model: 'shop', branch: 'main', provider: 'bogus' })).status).toBe(400);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const noKey = await post({ ...ask, model: 'shop', branch: 'main', provider: 'anthropic', modelId: 'claude-sonnet-5-5' });
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).error).toContain('ANTHROPIC_API_KEY');
  });
});

describe('system prompt', () => {
  it('includes the DSL, branch, view keys, tool guidance and DSL rules', async () => {
    const state = await studio.ctx.service.branchState('shop', 'main');
    const p = buildSystemPrompt(state, { skills: ['c4-modeller'] });
    expect(p).toContain('Branch: main');
    expect(p).toContain('system-context (systemContext), containers (systemContext)'.replace('containers (systemContext)', 'containers ('));
    expect(p).toContain(state.dsl);
    expect(p).toContain('edit_model');
    expect(p).toContain('replace_dsl');
    expect(p).toContain('Keep identifiers and view keys stable');
    expect(p).toContain('Structurizr DSL rules');
    expect(p).toContain('ADR rules:');
    expect(p).toContain('not a work log or a to-do list');
  });
});
