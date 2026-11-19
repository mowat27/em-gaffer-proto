import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BranchState, ServerEvent } from '../../src/shared/types.ts';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

process.env.C4_STUDIO_VALIDATOR = 'none';
vi.mock('../../src/core/dsl/index.ts', async () => await import('./helpers/fake-dsl.ts'));

const { createStudio } = await import('../../src/server/app.ts');
type Studio = Awaited<ReturnType<typeof createStudio>>;

let studio: Studio;
let base: string;
let root: string;
let webRoot: string;

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

/** Subscribe to /api/events and collect events. */
async function subscribe() {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: ServerEvent[] = [];
  const raw: string[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          raw.push(block);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    raw,
    waitFor: (pred: (e: ServerEvent) => boolean, ms = 2000) => vi.waitFor(() => expect(events.find(pred)).toBeTruthy(), { timeout: ms, interval: 20 }).then(() => events.find(pred)!),
    close: () => ctrl.abort(),
  };
}

beforeAll(async () => {
  root = await tmpDir('c4s-api-');
  webRoot = path.join(root, 'web');
  studio = await createStudio({ projectRoot: root, watch: true, snapshotDebounceMs: 100, webRoot });
  base = (await studio.listen(0)).url;
});

afterAll(async () => {
  await studio.close();
});

afterEach(cleanupTmp.bind(null));

describe('api', () => {
  it('serves status and binds loopback only', async () => {
    const { status, json } = await api('GET', '/api/status');
    expect(status).toBe(200);
    expect(json).toMatchObject({ projectRoot: root, modelsDir: path.join(root, 'c4-studio', 'models'), config: { port: 47145 } });
    expect(json.providers.map((p: { id: string }) => p.id)).toEqual(['openrouter', 'fireworks', 'anthropic', 'claude-code']);
    for (const k of ['OPENROUTER_API_KEY', 'FIREWORKS_API_KEY', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY']) {
      const v = process.env[k];
      if (v) expect(JSON.stringify(json)).not.toContain(v);
    }
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
    expect((await api('GET', '/api/chat/providers')).json).toHaveLength(4);
  });

  it('walks models, branches, dsl, edits, layout, versions, rollback, adrs, compare and events', async () => {
    const sse = await subscribe();
    await sse.waitFor((e) => e.type === 'hello');

    // models
    let r = await api('POST', '/api/models', { name: 'Shop', description: 'An online shop' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ slug: 'shop', defaultBranch: 'main', versionCount: 1 });
    await sse.waitFor((e) => e.type === 'models');
    expect((await api('POST', '/api/models', { name: 'Shop' })).status).toBe(409);
    expect((await api('POST', '/api/models', {})).status).toBe(400);
    expect((await api('GET', '/api/models')).json).toHaveLength(1);
    expect((await api('GET', '/api/models/shop')).json.lineage.branches.main).toBeTruthy();
    expect((await api('GET', '/api/models/nope')).status).toBe(404);

    // branches
    r = await api('POST', '/api/models/shop/branches', { name: 'feature' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: 'feature', parent: 'main' });
    expect((await api('POST', '/api/models/shop/branches', { name: 'feature' })).status).toBe(409);
    r = await api('GET', '/api/models/shop/branches/feature');
    expect(r.status).toBe(200);
    const initial: BranchState = r.json;
    expect(initial.workspace?.elements.map((e) => e.name)).toEqual(['Shop']);
    expect(initial.head).toMatchObject({ source: 'fork' });
    expect(initial.busy).toBeNull();

    // PUT dsl: parse error leaves everything untouched
    const bad = await api('PUT', '/api/models/shop/branches/feature/dsl', { dsl: 'workspace "x" {\nSYNTAX_ERROR\n}' });
    expect(bad.status).toBe(400);
    expect(bad.json.parseError).toMatchObject({ line: 2 });
    expect((await api('GET', '/api/models/shop/branches/feature')).json.dsl).toBe(initial.dsl);

    // PUT dsl: ok -> branch event
    const before = sse.events.length;
    const newDsl = initial.dsl.replace('model {\n', 'model {\n        cache = container "Cache"\n');
    r = await api('PUT', '/api/models/shop/branches/feature/dsl', { dsl: newDsl, message: 'add cache' });
    expect(r.status).toBe(200);
    expect(r.json.workspace.elements.map((e: { id: string }) => e.id)).toContain('cache');
    expect(r.json.head).toMatchObject({ source: 'ui', message: 'add cache' });
    const ev = await sse.waitFor((e) => e.type === 'branch' && e.branch === 'feature' && e.state.dsl === newDsl);
    expect(ev).toMatchObject({ type: 'branch', model: 'shop', branch: 'feature' });
    expect(sse.events.length).toBeGreaterThan(before);
    expect(sse.raw.some((b) => b.startsWith('event: message\ndata: '))).toBe(true);
    const rev1 = r.json.revision;

    // edits
    r = await api('POST', '/api/models/shop/branches/feature/edits', { ops: [{ op: 'addElement', parent: null, kind: 'person', name: 'Customer' }], message: 'add customer' });
    expect(r.status).toBe(200);
    expect(r.json.created).toEqual(['customer']);
    expect(r.json.revision).toBeGreaterThan(rev1);
    expect(r.json.head.message).toBe('add customer');
    r = await api('POST', '/api/models/shop/branches/feature/edits', { ops: [{ op: 'setRelationship', id: 'x', description: 'y' }] });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('does not support');
    expect((await api('POST', '/api/models/shop/branches/feature/edits', { ops: [] })).status).toBe(400);

    // layout
    r = await api('PUT', '/api/models/shop/branches/feature/layout/containers', { elements: { customer: { x: 10, y: 20 } } });
    expect(r.status).toBe(204);
    await sse.waitFor((e) => e.type === 'branch' && e.state.layout.views.containers?.elements.customer?.x === 10);
    expect((await api('PUT', '/api/models/shop/branches/feature/layout/containers', { nope: 1 })).status).toBe(400);
    expect((await api('GET', '/api/models/shop/branches/feature')).json.layout.views.containers.elements.customer).toEqual({ x: 10, y: 20 });
    // layout alone does not create a version
    const versions = (await api('GET', '/api/models/shop/branches/feature/versions')).json;
    expect(versions.map((v: { message: string }) => v.message)).toEqual(['add customer', 'add cache', 'Forked from main']);
    expect((await api('DELETE', '/api/models/shop/branches/feature/layout/containers')).status).toBe(204);
    expect((await api('GET', '/api/models/shop/branches/feature')).json.layout.views).toEqual({});

    // snapshot with nothing changed -> 204
    expect((await api('POST', '/api/models/shop/branches/feature/snapshot', { message: 'x' })).status).toBe(204);

    // version detail
    const detail = await api('GET', `/api/models/shop/branches/feature/versions/${versions[1].id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.dsl).toBe(newDsl);
    expect(detail.json.workspace.elements.length).toBe(2);

    // compare feature vs main
    r = await api('GET', '/api/models/shop/compare?left=main&right=feature');
    expect(r.status).toBe(200);
    expect(r.json.elements.map((e: { id: string; kind: string }) => `${e.kind}:${e.id}`).sort()).toEqual(['added:cache', 'added:customer']);
    r = await api('GET', `/api/models/shop/compare?left=feature@${versions[2].id}&right=feature@${versions[0].id}`);
    expect(r.json.left.version.id).toBe(versions[2].id);
    expect(r.json.elements).toHaveLength(2);
    expect((await api('GET', '/api/models/shop/compare?left=main')).status).toBe(400);

    // rollback
    r = await api('POST', '/api/models/shop/branches/feature/rollback', { version: versions[2].id });
    expect(r.status).toBe(200);
    expect(r.json.dsl).toBe(initial.dsl);
    expect(r.json.head).toMatchObject({ source: 'rollback', message: `Rollback to ${versions[2].id}` });
    expect((await api('POST', '/api/models/shop/branches/feature/rollback', { version: 'zzz' })).status).toBe(404);

    // adrs
    r = await api('POST', '/api/models/shop/branches/feature/adrs', { title: 'Use a cache', context: 'slow', decision: 'add redis', consequences: 'ops', elements: ['cache'] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ id: '0001', file: '0001-use-a-cache.md' });
    r = await api('POST', '/api/models/shop/branches/feature/adrs', { title: 'Replace cache', context: 'c', decision: 'd', consequences: 'q', supersedes: '0001' });
    expect(r.json.id).toBe('0002');
    r = await api('GET', '/api/models/shop/branches/feature/adrs');
    expect(r.json.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([['0001', 'superseded'], ['0002', 'proposed']]);
    expect((await api('GET', '/api/models/shop/branches/feature')).json.adrs).toHaveLength(2);
    r = await api('PUT', '/api/models/shop/branches/feature/adrs/0002', { title: 'Replace cache', status: 'accepted', context: 'c2', decision: 'd', consequences: 'q', supersedes: '0001' });
    expect(r.json).toMatchObject({ status: 'accepted', context: 'c2' });
    expect((await api('DELETE', '/api/models/shop/branches/feature/adrs/0002')).status).toBe(204);
    expect((await api('DELETE', '/api/models/shop/branches/feature/adrs/0002')).status).toBe(404);
    expect((await api('POST', '/api/models/shop/branches/feature/adrs', { context: '' })).status).toBe(400);
    // ADR changes are versions
    const after = (await api('GET', '/api/models/shop/branches/feature/versions')).json;
    expect(after[0].message).toBe('Delete ADR 0002');

    // validate (tooling disabled for hermetic tests)
    r = await api('POST', '/api/models/shop/branches/feature/validate');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'unavailable', tool: 'none' });
    await sse.waitFor((e) => e.type === 'validation' && e.branch === 'feature');

    // delete branch keeps versions
    expect((await api('DELETE', '/api/models/shop/branches/main')).status).toBe(400);
    expect((await api('DELETE', '/api/models/shop/branches/feature')).status).toBe(204);
    await sse.waitFor((e) => e.type === 'branch-removed' && e.branch === 'feature');
    expect((await api('GET', '/api/models/shop/branches/feature')).status).toBe(404);
    expect((await api('GET', '/api/models/shop')).json.lineage.versions.some((v: { branch: string }) => v.branch === 'feature')).toBe(true);

    // delete model
    expect((await api('DELETE', '/api/models/shop')).status).toBe(204);
    expect((await api('GET', '/api/models')).json).toEqual([]);
    sse.close();
  });

  it('broadcasts a branch event within 2 s when workspace.dsl is edited outside the server, then snapshots it as a file version', async () => {
    await api('POST', '/api/models', { name: 'Watched' });
    const sse = await subscribe();
    await sse.waitFor((e) => e.type === 'hello');
    const file = path.join(root, 'c4-studio', 'models', 'watched', 'branches', 'main', 'workspace.dsl');
    const original = await fs.readFile(file, 'utf8');
    const t0 = Date.now();
    await fs.writeFile(file, original.replace('model {\n', 'model {\n        db = container "Database"\n'));
    const ev = (await sse.waitFor((e) => e.type === 'branch' && e.model === 'watched' && e.state.dsl.includes('Database'), 2000)) as Extract<ServerEvent, { type: 'branch' }>;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ev.state.workspace?.elements.map((e) => e.id)).toContain('db');
    // the debounced file snapshot
    await vi.waitFor(async () => {
      const v = (await api('GET', '/api/models/watched/branches/main/versions')).json;
      expect(v[0]).toMatchObject({ source: 'file', message: 'Edited in file' });
    }, { timeout: 3000, interval: 50 });
    // a write made by the server itself must not produce a second, duplicate branch event
    const n = sse.events.filter((e) => e.type === 'branch').length;
    await api('PUT', '/api/models/watched/branches/main/dsl', { dsl: original });
    await new Promise((r) => setTimeout(r, 400));
    expect(sse.events.filter((e) => e.type === 'branch').length - n).toBe(1);
    sse.close();
    await api('DELETE', '/api/models/watched');
  });

  it('imports DSL from text and from a project file', async () => {
    const text = 'workspace "Imported Bank" "x" {\n    model {\n        a = softwareSystem "A"\n    }\n}\n';
    let r = await api('POST', '/api/models/import', { dsl: text });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ slug: 'imported-bank', name: 'Imported Bank', versionCount: 1 });
    expect(await fs.readFile(path.join(root, 'c4-studio', 'models', 'imported-bank', 'branches', 'main', 'workspace.dsl'), 'utf8')).toBe(text);
    const versions = (await api('GET', '/api/models/imported-bank/branches/main/versions')).json;
    expect(versions[0]).toMatchObject({ source: 'init', message: 'Imported from text' });
    expect((await api('POST', '/api/models/import', { dsl: text })).status).toBe(409);

    r = await api('POST', '/api/models/import', { dsl: 'workspace {\nSYNTAX_ERROR\n}' });
    expect(r.status).toBe(400);
    expect(r.json.parseError).toMatchObject({ line: 2 });
    expect((await api('POST', '/api/models/import', {})).status).toBe(400);
    expect((await api('POST', '/api/models/import', { dsl: text, path: 'x.dsl' })).status).toBe(400);

    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'my-arch.dsl'), text.replace('Imported Bank', 'File Bank') + '// !include other.dsl\n!include other.dsl\n');
    r = await api('POST', '/api/models/import', { path: 'docs/my-arch.dsl', description: 'from file' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ slug: 'file-bank', description: 'from file' });
    expect(r.json.warnings.join(' ')).toContain('!include');
    expect((await api('GET', '/api/models/file-bank/branches/main/versions')).json[0].message).toBe('Imported from docs/my-arch.dsl');
    // original untouched
    expect(await fs.readFile(path.join(root, 'docs', 'my-arch.dsl'), 'utf8')).toContain('File Bank');

    // explicit name wins; absolute path outside the project is allowed (the user typed it); relative escape is not
    const outside = path.join(await tmpDir('c4s-out-'), 'out.dsl');
    await fs.writeFile(outside, text);
    r = await api('POST', '/api/models/import', { path: outside, name: 'Outside One' });
    expect(r.status).toBe(201);
    expect(r.json.slug).toBe('outside-one');
    expect((await api('POST', '/api/models/import', { path: '../../etc/hosts' })).status).toBe(400);
    expect((await api('POST', '/api/models/import', { path: 'docs/missing.dsl' })).status).toBe(404);
    expect((await api('POST', '/api/models/import', { path: 'docs' })).status).toBe(400);
    // file name fallback when the workspace has no name
    await fs.writeFile(path.join(root, 'docs', 'unnamed-thing.dsl'), 'workspace {\n    model {\n        a = softwareSystem "A"\n    }\n}\n');
    r = await api('POST', '/api/models/import', { path: 'docs/unnamed-thing.dsl' });
    expect(r.json.slug).toBe('unnamed-thing');
    for (const s of ['imported-bank', 'file-bank', 'outside-one', 'unnamed-thing']) await api('DELETE', `/api/models/${s}`);
  });

  it('scopes /api/project/files to the project', async () => {
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), '');
    await fs.writeFile(path.join(root, 'src', 'deep', 'b.ts'), '');
    await fs.writeFile(path.join(root, 'src', 'deep', 'c.md'), '');
    await fs.writeFile(path.join(root, 'node_modules', 'x', 'd.ts'), '');
    let r = await api('GET', '/api/project/files?dir=src');
    expect(r.json).toEqual({ files: ['a.ts'], dirs: ['deep'] });
    r = await api('GET', '/api/project/files?dir=.&glob=**/*.ts');
    expect(r.json.files).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect((await api('GET', '/api/project/files?dir=..')).status).toBe(400);
    expect((await api('GET', '/api/project/files?dir=/etc')).status).toBe(400);
    expect((await api('GET', '/api/project/files?dir=nope')).status).toBe(404);
  });

  it('creates jobs through the API and rejects bad ones', async () => {
    await api('POST', '/api/models', { name: 'Jobby' });
    expect((await api('POST', '/api/jobs', { type: 'update', model: 'ghost', prompt: 'x' })).status).toBe(404);
    expect((await api('POST', '/api/jobs', { type: 'update', model: 'jobby', prompt: '' })).status).toBe(400);
    expect((await api('GET', '/api/jobs/nope')).status).toBe(404);
    expect((await api('GET', '/api/jobs')).json).toEqual([]);
    await api('DELETE', '/api/models/jobby');
  });

  it('serves the SPA with an SPA fallback and no-cache index.html', async () => {
    let res = await fetch(base + '/');
    expect(res.status).toBe(404); // not built yet
    await fs.mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>app</title>');
    await fs.writeFile(path.join(webRoot, 'assets', 'app-abc.js'), 'console.log(1)');
    res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-type')).toContain('text/html');
    res = await fetch(base + '/some/client/route?model=x');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>app</title>');
    res = await fetch(base + '/assets/app-abc.js');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(base + '/assets/missing.js')).status).toBe(404);
    expect((await fetch(base + '/../../../etc/passwd')).status).toBeLessThan(500);
    res = await fetch(base + '/api/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
