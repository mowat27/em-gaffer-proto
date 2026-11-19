import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ValidationResult } from '../shared/types.ts';
import { which } from './paths.ts';

export type ValidatorTool = 'cli' | 'docker' | 'none';

interface Runner {
  tool: 'cli' | 'docker';
  /** Build the command for running `structurizr <args>` against a workspace directory. */
  command(dir: string, args: string[]): { cmd: string; args: string[]; cwd?: string };
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, out: out + String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

let cachedDocker: { at: number; ok: boolean } | null = null;

async function dockerRunning(): Promise<boolean> {
  if (cachedDocker && Date.now() - cachedDocker.at < 30_000) return cachedDocker.ok;
  if (!which('docker')) {
    cachedDocker = { at: Date.now(), ok: false };
    return false;
  }
  const r = await run('docker', ['info'], { timeoutMs: 8000 });
  cachedDocker = { at: Date.now(), ok: r.code === 0 };
  return cachedDocker.ok;
}

/** Same preference order as c4-modeller/scripts/validate.sh: structurizr, structurizr.sh, Docker image. */
export async function detectRunner(): Promise<Runner | null> {
  // C4_STUDIO_VALIDATOR=none disables validation (used by hermetic tests).
  if (process.env.C4_STUDIO_VALIDATOR === 'none') return null;
  const native = which('structurizr') ?? which('structurizr.sh');
  if (native) return { tool: 'cli', command: (dir, args) => ({ cmd: native, args, cwd: dir }) };
  if (await dockerRunning()) {
    const image = process.env.STRUCTURIZR_IMAGE || 'structurizr/structurizr';
    return { tool: 'docker', command: (dir, args) => ({ cmd: 'docker', args: ['run', '--rm', '-v', `${dir}:/w`, '-w', '/w', image, ...args] }) };
  }
  return null;
}

export async function detectValidator(): Promise<ValidatorTool> {
  return (await detectRunner())?.tool ?? 'none';
}

/** Mirrors validate.sh's `sed -E 's/^.*(Command|Parser)[^-]* -- //'`. */
export function stripLogPrefix(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^.*(Command|Parser)[^-]* -- /, ''))
    .join('\n');
}

/**
 * Validate a workspace file: `validate` then `inspect -s error,warning`.
 * Status mapping matches validate.sh: validate fails -> parse-failed (exit 1); inspect fails -> inspections-failed (exit 2);
 * no tooling -> unavailable (exit 3).
 */
export async function validateWorkspace(workspaceFile: string, timeoutMs = 30_000): Promise<ValidationResult> {
  const started = Date.now();
  const ranAt = new Date(started).toISOString();
  const done = (status: ValidationResult['status'], tool: ValidationResult['tool'], output: string): ValidationResult => ({
    status,
    tool,
    output: output.trim(),
    ranAt,
    durationMs: Date.now() - started,
  });

  const runner = await detectRunner();
  if (!runner) {
    return done('unavailable', 'none', 'NO_TOOLING: install the Structurizr CLI or start Docker to validate');
  }
  const dir = path.dirname(workspaceFile);
  const file = path.basename(workspaceFile);
  const exec = (args: string[]) => {
    const c = runner.command(dir, args);
    const left = Math.max(1000, timeoutMs - (Date.now() - started));
    return run(c.cmd, c.args, { cwd: c.cwd, timeoutMs: left });
  };

  let output = '== validate\n';
  const v = await exec(['validate', '-w', file]);
  if (v.timedOut) return done('parse-failed', runner.tool, `${output}timed out after ${timeoutMs / 1000}s`);
  if (v.code !== 0) {
    return done('parse-failed', runner.tool, `${output}${stripLogPrefix(v.out)}\nRESULT: parse failed`);
  }
  output += 'parse ok\n== inspect (errors and warnings)\n';
  const i = await exec(['inspect', '-w', file, '-s', 'error,warning']);
  if (i.timedOut) return done('inspections-failed', runner.tool, `${output}timed out after ${timeoutMs / 1000}s`);
  if (i.out.trim()) output += stripLogPrefix(i.out) + '\n';
  if (i.code !== 0) return done('inspections-failed', runner.tool, `${output}RESULT: inspections failed`);
  return done('ok', runner.tool, `${output}RESULT: ok`);
}
