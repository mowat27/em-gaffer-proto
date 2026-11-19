import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.ts';
import { buildPrompt, JobManager } from '../../src/core/jobs.ts';
import type { SpawnOptions } from '../../src/core/claude.ts';
import { skeletonDsl, Store } from '../../src/core/store.ts';
import type { Job } from '../../src/shared/types.ts';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

afterEach(cleanupTmp);

/** A fake spawn: feeds the given stream-json lines, optionally runs a side effect first, then exits. */
function fakeSpawn(lines: string[], opts: { code?: number; stderr?: string; effect?: () => Promise<void>; hold?: Promise<void> } = {}) {
  const calls: SpawnOptions[] = [];
  const spawn = (o: SpawnOptions) => {
    calls.push(o);
    const ev = new EventEmitter();
    let cancelled = false;
    const done = (async () => {
      await opts.effect?.();
      for (const l of lines) o.onLine(l);
      if (opts.stderr) o.onStderr?.(opts.stderr);
      await opts.hold;
      return { code: cancelled ? null : (opts.code ?? 0), signal: cancelled ? ('SIGTERM' as const) : null, stderr: opts.stderr ?? '' };
    })();
    return { child: ev as never, done, cancel: () => void (cancelled = true) };
  };
  return { spawn: spawn as never, calls };
}

const OK_LINES = [
  `{"type":"system","subtype":"init","session_id":"sess-1","model":"opus"}`,
  `{"type":"assistant","message":{"id":"a","content":[{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"/x/workspace.dsl"}}]},"session_id":"sess-1"}`,
  `{"type":"assistant","message":{"id":"b","content":[{"type":"text","text":"Done."}]},"session_id":"sess-1"}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"## C4 model\\nHand-off","session_id":"sess-1"}`,
];

async function setup(spawnImpl: ReturnType<typeof fakeSpawn>, c4: string | null = '/skills/c4-modeller') {
  const root = await tmpDir();
  const store = new Store(path.join(root, 'c4-studio', 'models'));
  await store.createModel({ name: 'Shop', description: 'A shop' });
  const busy: Array<unknown> = [];
  const jobEvents: Job[] = [];
  const mgr = new JobManager({
    store,
    config: defaultConfig,
    projectRoot: root,
    modelsDir: store.modelsDir,
    skillDir: '/nonexistent',
    claudeBin: () => '/usr/bin/claude',
    c4Modeller: () => c4,
    spawn: spawnImpl.spawn,
    hooks: {
      onBusy: (_m, _b, b) => busy.push(b),
      onJob: (j, reason) => reason !== 'event' && jobEvents.push(structuredClone(j)),
    },
  });
  return { root, store, mgr, busy, jobEvents };
}

describe('jobs', () => {
  it('runs an update job: argv, events, session id, result, busy flag, agent snapshot', async () => {
    let ws = '';
    const fake = fakeSpawn(OK_LINES, { effect: () => fs.writeFile(ws, 'workspace "Shop" {\n    // changed by claude\n}\n') });
    const { root, store, mgr, busy } = await setup(fake);
    ws = store.branchPaths('shop', 'main').workspace;
    const job = await mgr.submit({ type: 'update', model: 'shop', prompt: 'add a cache to the API', claudeArgs: ['--max-turns', '9'] });
    const done = await mgr.waitFor(job.id);

    expect(done.status).toBe('succeeded');
    expect(done.sessionId).toBe('sess-1');
    expect(done.result).toContain('Hand-off');
    expect(done.exitCode).toBe(0);
    expect(done.events.map((e) => e.kind)).toEqual(['system', 'tool', 'text', 'result']);
    expect(done.events[1]!.text).toBe('Write /x/workspace.dsl');

    const argv = done.argv;
    expect(argv[0]).toBe('claude');
    expect(argv.slice(1, 3)).toEqual(['-p', expect.stringContaining('`update` mode on the workspace at ')]);
    expect(argv[2]).toContain(ws);
    expect(argv[2]).toContain('add a cache to the API');
    expect(argv).toContain('--add-dir');
    expect(argv.slice(-2)).toEqual(['--max-turns', '9']);
    // a skill directory outside the project is added as a readable dir
    expect(argv).toContain('/skills/c4-modeller');
    expect(fake.calls[0]!.cwd).toBe(root);
    expect(fake.calls[0]!.bin).toBe('/usr/bin/claude');

    await vi.waitFor(() => expect(busy.at(-1)).toBeNull());
    expect(busy).toEqual([{ jobId: job.id, label: 'update: add a cache to the API' }, null]);
    const versions = await store.listVersions('shop', 'main');
    expect(versions[0]).toMatchObject({ source: 'agent', message: 'update: add a cache to the API' });
    const saved = JSON.parse(await fs.readFile(path.join(store.modelsDir, '.jobs', `${job.id}.json`), 'utf8'));
    expect(saved.status).toBe('succeeded');
  });

  it('does not create a version when nothing changed (dedupe) and skips snapshot for ask', async () => {
    const { store, mgr } = await setup(fakeSpawn(OK_LINES));
    const j1 = await mgr.waitFor((await mgr.submit({ type: 'update', model: 'shop', prompt: 'noop' })).id);
    expect(j1.status).toBe('succeeded');
    const j2 = await mgr.waitFor((await mgr.submit({ type: 'ask', model: 'shop', prompt: 'what?' })).id);
    expect(j2.status).toBe('succeeded');
    expect(await store.listVersions('shop', 'main')).toHaveLength(1);
  });

  it('fails with claude stderr on a non-zero exit and on an error result', async () => {
    const { mgr } = await setup(fakeSpawn([], { code: 1, stderr: 'unknown option --nope' }));
    const j = await mgr.waitFor((await mgr.submit({ type: 'update', model: 'shop', prompt: 'x', claudeArgs: ['--nope'] })).id);
    expect(j.status).toBe('failed');
    expect(j.error).toContain('unknown option --nope');
    expect(j.events.some((e) => e.kind === 'stderr')).toBe(true);

    const { mgr: m2 } = await setup(fakeSpawn([`{"type":"result","subtype":"error_max_turns","is_error":true,"result":"too many turns"}`], { code: 0 }));
    const j2 = await m2.waitFor((await m2.submit({ type: 'update', model: 'shop', prompt: 'x' })).id);
    expect(j2).toMatchObject({ status: 'failed', error: 'too many turns' });
  });

  it('fails clearly when the claude binary or the c4-modeller skill is missing', async () => {
    const { mgr } = await setup(fakeSpawn([]), null);
    const j = await mgr.waitFor((await mgr.submit({ type: 'update', model: 'shop', prompt: 'x' })).id);
    expect(j.status).toBe('failed');
    expect(j.error).toContain('c4-modeller skill not found');
  });

  it('queues a second job on the same branch and supports cancelling', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { mgr, busy } = await setup(fakeSpawn(OK_LINES, { hold }));
    const a = await mgr.submit({ type: 'update', model: 'shop', prompt: 'first' });
    const b = await mgr.submit({ type: 'update', model: 'shop', prompt: 'second' });
    await vi.waitFor(() => expect(mgr.get(a.id)!.status).toBe('running'));
    expect(mgr.get(b.id)!.status).toBe('queued');
    mgr.cancel(b.id);
    expect((await mgr.waitFor(b.id)).status).toBe('cancelled');
    mgr.cancel(a.id);
    release();
    expect((await mgr.waitFor(a.id)).status).toBe('cancelled');
    await vi.waitFor(() => expect(busy.at(-1)).toBeNull());
  });

  it('validates requests', async () => {
    const { mgr } = await setup(fakeSpawn([]));
    await expect(mgr.submit({ type: 'update', model: 'ghost', prompt: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(mgr.submit({ type: 'update', model: 'shop', prompt: '' })).rejects.toMatchObject({ status: 400 });
    await expect(mgr.submit({ type: 'nope' as never, model: 'shop', prompt: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(mgr.submit({ type: 'update', model: 'shop', branch: 'ghost', prompt: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('marks jobs left running by a dead process as failed on init', async () => {
    const { mgr, store } = await setup(fakeSpawn(OK_LINES));
    await fs.mkdir(path.join(store.modelsDir, '.jobs'), { recursive: true });
    await fs.writeFile(
      path.join(store.modelsDir, '.jobs', 'jold.json'),
      JSON.stringify({ id: 'jold', type: 'update', model: 'shop', prompt: 'x', status: 'running', createdAt: '2026-01-01T00:00:00Z', argv: [], events: [] }),
    );
    await mgr.init();
    expect(mgr.get('jold')).toMatchObject({ status: 'failed' });
  });
});

describe('job prompts', () => {
  const ctx = { c4ModellerDir: '/c4', workspacePath: '/ws/workspace.dsl', codePath: '/code', skeleton: true };
  it('create / update / ask follow the DESIGN.md templates', () => {
    const c = buildPrompt({ type: 'create', model: 'm', prompt: 'a bank' }, ctx);
    expect(c).toBe(
      'Follow the c4-modeller skill at /c4/SKILL.md in `model` mode. Request: a bank. Write the workspace to /ws/workspace.dsl (replace the skeleton there), export JSON beside it only if the skill\'s recipe says so, validate with /c4/scripts/validate.sh, and finish with the Model Hand-Off block. Do not write anywhere else.',
    );
    expect(buildPrompt({ type: 'update', model: 'm', prompt: 'add X' }, ctx)).toContain('in `update` mode on the workspace at /ws/workspace.dsl: add X');
    expect(buildPrompt({ type: 'ask', model: 'm', prompt: 'why?' }, ctx)).toContain('in `ask` mode on the workspace at /ws/workspace.dsl: why?');
  });
  it('reverse uses model mode on a skeleton and update sync otherwise', () => {
    expect(buildPrompt({ type: 'reverse', model: 'm', prompt: '' }, ctx)).toContain('`model` mode on the codebase at /code');
    expect(buildPrompt({ type: 'reverse', model: 'm', prompt: '' }, { ...ctx, skeleton: false })).toContain('`update sync` mode against the codebase at /code');
  });
  it('the skeleton comparison used for reverse matches the generated skeleton', () => {
    expect(skeletonDsl('A', 'b')).toBe(skeletonDsl('A', 'b'));
  });
});
