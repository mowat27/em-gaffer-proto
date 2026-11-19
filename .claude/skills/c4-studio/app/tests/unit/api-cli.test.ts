import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

vi.mock('../../src/core/dsl/index.ts', async () => await import('./helpers/fake-dsl.ts'));

const { parseCliArgs, runCli } = await import('../../src/cli/main.ts');

describe('cli args', () => {
  it('splits claude passthrough args after --', () => {
    const a = parseCliArgs(['update', 'shop', 'add a cache', '--branch', 'feat', '--', '--max-turns', '5', '--append-system-prompt', 'x']);
    expect(a.command).toBe('update');
    expect(a.positionals).toEqual(['shop', 'add a cache']);
    expect(a.values.branch).toBe('feat');
    expect(a.claudeArgs).toEqual(['--max-turns', '5', '--append-system-prompt', 'x']);
  });

  it('parses short flags and booleans', () => {
    const a = parseCliArgs(['snapshot', 'shop', '-m', 'msg', '--yes']);
    expect(a.values).toMatchObject({ message: 'msg', yes: true });
    expect(parseCliArgs(['reverse', 'Shop', '--into', '--path', 'src']).values).toMatchObject({ into: true, path: 'src' });
    expect(parseCliArgs(['import', 'a.dsl', '--name', 'N', '--description', 'D']).values).toMatchObject({ name: 'N', description: 'D' });
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['list', '--bogus'])).toThrow();
  });
});

describe('cli commands', () => {
  let root: string;
  let out: string[];
  let err: string[];
  const run = (...argv: string[]) => runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });

  beforeEach(async () => {
    root = await tmpDir('c4s-cli-');
    process.env.C4_STUDIO_PROJECT = root;
    out = [];
    err = [];
  });
  afterEach(async () => {
    delete process.env.C4_STUDIO_PROJECT;
    await cleanupTmp();
  });

  it('create, path, list, snapshot, versions, branch, rollback, delete', async () => {
    expect(await run('list')).toBe(0);
    expect(out).toEqual(['no models']);

    out.length = 0;
    expect(await run('create', 'Shop', '--description', 'A shop')).toBe(0);
    const ws = path.join(root, 'c4-studio', 'models', 'shop', 'branches', 'main', 'workspace.dsl');
    expect(out).toEqual(['created shop', ws]);
    expect(await run('create', 'Shop')).toBe(1);

    out.length = 0;
    expect(await run('path', 'shop')).toBe(0);
    expect(out).toEqual([ws]);

    // the coding agent edits the file itself, then records a version
    await fs.appendFile(ws, '// edited\n');
    out.length = 0;
    expect(await run('snapshot', 'shop', '-m', 'edited by agent')).toBe(0);
    expect(out[0]).toMatch(/^version /);
    out.length = 0;
    expect(await run('snapshot', 'shop', '-m', 'again')).toBe(0);
    expect(out).toEqual(['no changes']);
    expect(await run('snapshot', 'shop')).toBe(2);

    out.length = 0;
    await run('versions', 'shop');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('cli');
    expect(out[0]).toContain('edited by agent');
    const initId = out[1]!.split(' ')[0]!;

    out.length = 0;
    expect(await run('branch', 'shop', 'feat', '--from', 'main')).toBe(0);
    expect(out[0]).toContain('shop/feat forked from main');
    out.length = 0;
    await run('list');
    expect(out[0]).toMatch(/^shop {2}Shop {2}\[main@\w+, feat@\w+\] {2}3 versions$/);

    expect(await run('rollback', 'shop', initId)).toBe(0);
    expect(await fs.readFile(ws, 'utf8')).not.toContain('// edited');

    expect(await run('delete', 'shop', '--branch', 'feat', '--yes')).toBe(0);
    expect(await run('delete', 'shop')).toBe(1); // no --yes and no TTY
    expect(await run('delete', 'shop', '--yes')).toBe(0);
    expect(await run('path', 'shop')).toBe(1);
  });

  it('import copies the file, prints the slug and workspace path, and reports parse errors', async () => {
    const file = path.join(root, 'arch.dsl');
    const text = 'workspace "Legacy System" {\n    model {\n        a = softwareSystem "A"\n    }\n}\n';
    await fs.writeFile(file, text);
    expect(await run('import', file)).toBe(0);
    const ws = path.join(root, 'c4-studio', 'models', 'legacy-system', 'branches', 'main', 'workspace.dsl');
    expect(out).toEqual(['legacy-system', ws]);
    expect(await fs.readFile(ws, 'utf8')).toBe(text);
    expect(await fs.readFile(file, 'utf8')).toBe(text);

    expect(await run('import', file, '--name', 'Renamed')).toBe(0);
    expect(out.slice(2)[0]).toBe('renamed');

    await fs.writeFile(path.join(root, 'bad.dsl'), 'workspace {\nSYNTAX_ERROR\n}');
    err.length = 0;
    expect(await run('import', path.join(root, 'bad.dsl'))).toBe(1);
    expect(err[0]).toContain('line 2');
    expect(await run('import', path.join(root, 'missing.dsl'))).toBe(1);
    expect(await run('import')).toBe(2);
  });

  it('exit code 2 for usage errors and unknown commands', async () => {
    expect(await run()).toBe(2);
    expect(await run('nope')).toBe(2);
    expect(await run('update', 'only-one-arg')).toBe(2);
    expect(await run('list', '--bogus')).toBe(2);
    expect(await run('--help')).toBe(0);
  });

  it('prompt-driven commands fail cleanly for unknown models', async () => {
    expect(await run('update', 'ghost', 'do it')).toBe(1);
    expect(err.join('\n')).toContain('model not found');
  });
});
