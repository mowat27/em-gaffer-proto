import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripLogPrefix, validateWorkspace } from '../../src/core/validate.ts';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

// A fake `structurizr` on PATH that mimics the CLI's exit codes, so the status mapping is tested without Java or Docker.
const FAKE = `#!/bin/sh
cmd="$1"; shift
file=""
while [ $# -gt 0 ]; do case "$1" in -w) file="$2"; shift 2;; *) shift;; esac; done
if [ "$cmd" = "validate" ]; then
  if grep -q BAD "$file"; then echo "2026 ERROR com.structurizr.Parser -- line 3: boom"; exit 1; fi
  exit 0
fi
if [ "$cmd" = "inspect" ]; then
  if grep -q WARN "$file"; then echo "2026 WARN com.structurizr.Command -- container has no description"; exit 1; fi
  exit 0
fi
exit 9
`;

let savedPath: string | undefined;
let savedValidator: string | undefined;
let dir: string;

beforeEach(async () => {
  savedPath = process.env.PATH;
  savedValidator = process.env.C4_STUDIO_VALIDATOR;
  delete process.env.C4_STUDIO_VALIDATOR;
  dir = await tmpDir('c4s-val-');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'structurizr'), FAKE, { mode: 0o755 });
  process.env.PATH = `${bin}:${savedPath}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  if (savedValidator !== undefined) process.env.C4_STUDIO_VALIDATOR = savedValidator;
  await cleanupTmp();
});

async function ws(content: string) {
  const f = path.join(dir, 'workspace.dsl');
  await fs.writeFile(f, content);
  return f;
}

describe('validate', () => {
  it('maps CLI outcomes like validate.sh', async () => {
    const ok = await validateWorkspace(await ws('fine'));
    expect(ok).toMatchObject({ status: 'ok', tool: 'cli' });
    expect(ok.output).toContain('RESULT: ok');

    const parse = await validateWorkspace(await ws('BAD'));
    expect(parse.status).toBe('parse-failed');
    expect(parse.output).toContain('line 3: boom');
    expect(parse.output).toContain('RESULT: parse failed');
    expect(parse.output).not.toContain('com.structurizr');

    const insp = await validateWorkspace(await ws('WARN'));
    expect(insp.status).toBe('inspections-failed');
    expect(insp.output).toContain('parse ok');
    expect(insp.output).toContain('container has no description');
    expect(insp.output).toContain('RESULT: inspections failed');
  });

  it('reports unavailable when no tooling exists', async () => {
    process.env.C4_STUDIO_VALIDATOR = 'none';
    const r = await validateWorkspace(await ws('fine'));
    expect(r).toMatchObject({ status: 'unavailable', tool: 'none' });
  });

  it('strips structurizr log prefixes', () => {
    expect(stripLogPrefix('2026 ERROR com.structurizr.dsl.Parser -- hello')).toBe('hello');
    expect(stripLogPrefix('plain')).toBe('plain');
  });
});
