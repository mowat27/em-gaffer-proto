import { spawn, type ChildProcess } from 'node:child_process';
import type { JobEvent, StudioConfig } from '../shared/types.ts';
import { which } from './paths.ts';

/** Resolve the claude binary: C4_STUDIO_CLAUDE, else `claude` on PATH. */
export function resolveClaudeBinary(): string | null {
  const override = process.env.C4_STUDIO_CLAUDE;
  if (override) return which(override);
  return which('claude');
}

export interface ArgvOptions {
  config: StudioConfig['claude'];
  prompt: string;
  modelsDir: string;
  /** Codebase to read (reverse jobs) */
  codePath?: string;
  /** Other directories claude must be able to read (for example the c4-modeller skill outside the project) */
  extraDirs?: string[];
  /** Extra args appended after the config args */
  claudeArgs?: string[];
}

/**
 * claude -p <prompt> --model M --effort E --output-format stream-json --verbose --permission-mode P
 *   --allowedTools a,b,c --add-dir <modelsDir> [--add-dir <codePath>] [--add-dir <extra>...] <config.args...> <claudeArgs...>
 */
export function buildJobArgv(o: ArgvOptions): string[] {
  const argv = [
    '-p',
    o.prompt,
    '--model',
    o.config.model,
    '--effort',
    o.config.effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    o.config.permissionMode,
    '--allowedTools',
    o.config.allowedTools.join(','),
    '--add-dir',
    o.modelsDir,
  ];
  if (o.codePath) argv.push('--add-dir', o.codePath);
  for (const d of o.extraDirs ?? []) argv.push('--add-dir', d);
  argv.push(...o.config.args, ...(o.claudeArgs ?? []));
  return argv;
}

export interface ChatArgvOptions extends ArgvOptions {
  /** Session id to resume; when absent, `sessionId` is used to start a new session */
  resume?: string;
  /** New session id (uuid) for the first turn */
  sessionId?: string;
  model?: string;
}

/** Same flags as jobs plus --include-partial-messages and --session-id / --resume. */
export function buildChatArgv(o: ChatArgvOptions): string[] {
  const argv = buildJobArgv({ ...o, config: { ...o.config, model: o.model || o.config.model } });
  // --include-partial-messages and the session flag go before the user-supplied args so that those still win.
  const insertAt = argv.indexOf('--add-dir');
  const extra = ['--include-partial-messages', ...(o.resume ? ['--resume', o.resume] : o.sessionId ? ['--session-id', o.sessionId] : [])];
  argv.splice(insertAt, 0, ...extra);
  return argv;
}

// ---------------------------------------------------------------------------
// stream-json parsing
// ---------------------------------------------------------------------------

export interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** Parse one stdout line. Returns null for blank or non-JSON lines (for example wrapper banners). */
export function parseStreamLine(line: string): StreamMessage | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === 'object' && typeof (v as StreamMessage).type === 'string') return v as StreamMessage;
  } catch {
    // not JSON
  }
  return null;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** One-line summary of a tool call, for example `Read /a/b.dsl` or `Bash ls -la`. */
export function summariseToolUse(name: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof inp[k] === 'string' ? (inp[k] as string) : undefined);
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${name} ${str('file_path') ?? str('notebook_path') ?? ''}`.trim();
    case 'Bash':
      return `Bash ${clip(str('command') ?? '', 80)}`.trim();
    case 'Glob':
      return `Glob ${clip(str('pattern') ?? '', 80)}`.trim();
    case 'Grep':
      return `Grep ${clip(str('pattern') ?? '', 80)}`.trim();
    default: {
      const first = Object.values(inp).find((v) => typeof v === 'string') as string | undefined;
      return first ? `${name} ${clip(first, 80)}` : name;
    }
  }
}

export interface MappedMessage {
  sessionId?: string;
  events: JobEvent[];
  result?: { text: string; isError: boolean };
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

/** Map a stream-json message to job events. Partial-message `stream_event`s are ignored (jobs do not request them). */
export function mapStreamMessage(msg: StreamMessage, now: () => string = () => new Date().toISOString()): MappedMessage {
  const out: MappedMessage = { events: [] };
  if (typeof msg.session_id === 'string') out.sessionId = msg.session_id;
  const ts = now();
  if (msg.type === 'system' && msg.subtype === 'init') {
    const model = typeof msg.model === 'string' ? ` (${msg.model})` : '';
    out.events.push({ ts, kind: 'system', text: `Session ${msg.session_id ?? ''}${model}`.trim() });
  } else if (msg.type === 'assistant') {
    const content = (msg.message as { content?: ContentBlock[] } | undefined)?.content;
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text' && b.text?.trim()) out.events.push({ ts, kind: 'text', text: b.text });
      else if (b.type === 'tool_use' && b.name) out.events.push({ ts, kind: 'tool', text: summariseToolUse(b.name, b.input) });
    }
  } else if (msg.type === 'result') {
    const text = typeof msg.result === 'string' ? msg.result : '';
    const isError = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'));
    out.result = { text, isError };
    out.events.push({ ts, kind: 'result', text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

export interface ClaudeRun {
  child: ChildProcess;
  /** Resolves when the process exits */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  cancel(): void;
}

export interface SpawnOptions {
  bin: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLine(line: string): void;
  onStderr?(text: string): void;
}

export function spawnClaude(o: SpawnOptions): ClaudeRun {
  let buf = '';
  let stderr = '';
  let finished = false;
  let cancelled = false;
  let resolveDone!: (v: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((r) => (resolveDone = r));

  const finish = (code: number | null, signal: NodeJS.Signals | null, extra = '') => {
    if (finished) return;
    finished = true;
    if (buf.trim()) o.onLine(buf);
    buf = '';
    resolveDone({ code, signal, stderr: stderr + extra });
  };

  const start = (cmd: string, args: string[], retryViaShell: boolean): ChildProcess => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // spawn can throw synchronously (for example ENOEXEC for a wrapper script without a shebang): let sh run it
      if ((err as NodeJS.ErrnoException).code === 'ENOEXEC' && retryViaShell) return start('/bin/sh', [o.bin, ...o.argv], false);
      throw err;
    }
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) o.onLine(line);
      }
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      o.onStderr?.(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOEXEC' && retryViaShell && !cancelled) {
        // a wrapper script without a shebang: let sh run it
        current = start('/bin/sh', [o.bin, ...o.argv], false);
        run.child = current;
        return;
      }
      finish(127, null, `\n${err.message}`);
    });
    child.on('close', (code, signal) => finish(code, signal));
    return child;
  };

  let current = start(o.bin, o.argv, true);
  const run: ClaudeRun = {
    child: current,
    done,
    cancel() {
      cancelled = true;
      if (!current.killed && current.exitCode === null) current.kill('SIGTERM');
    },
  };
  return run;
}
