import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';
import { buildChatArgv, buildJobArgv, mapStreamMessage, parseStreamLine, spawnClaude, summariseToolUse } from '../../src/core/claude.ts';
import { defaultConfig } from '../../src/core/config.ts';
import { buildChatPrompt, ClaudeStreamTranslator, lastUserText } from '../../src/server/chat/claude-code.ts';

// Lines recorded from `claude -p ... --output-format stream-json --verbose --include-partial-messages` (trimmed).
const SID = '49114d53-d6ac-45b8-835f-a9b69a3b6e47';
const RECORDED_TEXT = [
  `agent-vault: routing HTTP/HTTPS through MITM proxy (localhost:14322)`,
  `{"type":"system","subtype":"hook_started","hook_id":"x","session_id":"${SID}"}`,
  `{"type":"system","subtype":"init","cwd":"/tmp","session_id":"${SID}","model":"claude-haiku-5-5","tools":["Read"]}`,
  `{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"po"}},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ng"}},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"pong"}]},"parent_tool_use_id":null,"session_id":"${SID}"}`,
  `{"type":"stream_event","event":{"type":"content_block_stop","index":1},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"stream_event","event":{"type":"message_stop"},"session_id":"${SID}","parent_tool_use_id":null}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"${SID}"}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"pong","stop_reason":"end_turn","session_id":"${SID}"}`,
];

const RECORDED_TOOL = [
  `{"type":"system","subtype":"init","session_id":"${SID}"}`,
  `{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/etc/hostname"}}]},"parent_tool_use_id":null,"session_id":"${SID}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"File does not exist.","is_error":true,"tool_use_id":"toolu_01"}]},"parent_tool_use_id":null,"session_id":"${SID}"}`,
  `{"type":"assistant","message":{"id":"msg_3","role":"assistant","content":[{"type":"text","text":"The Read failed."}]},"parent_tool_use_id":null,"session_id":"${SID}"}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"The Read failed.","session_id":"${SID}"}`,
];

describe('claude argv', () => {
  const cfg = defaultConfig().claude;

  it('builds the job argv exactly as DESIGN.md describes', () => {
    const argv = buildJobArgv({ config: cfg, prompt: 'PROMPT', modelsDir: '/p/c4-studio/models' });
    expect(argv).toEqual([
      '-p',
      'PROMPT',
      '--model',
      'opus',
      '--effort',
      'high',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      cfg.allowedTools.join(','),
      '--add-dir',
      '/p/c4-studio/models',
    ]);
  });

  it('adds the code path, extra dirs, config args and request args in order', () => {
    const argv = buildJobArgv({
      config: { ...cfg, args: ['--max-turns', '40'] },
      prompt: 'P',
      modelsDir: '/m',
      codePath: '/code',
      extraDirs: ['/skill'],
      claudeArgs: ['--append-system-prompt', 'be brief'],
    });
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual(['--add-dir', '/m', '--add-dir', '/code', '--add-dir', '/skill', '--max-turns', '40', '--append-system-prompt', 'be brief']);
  });

  it('chat argv adds --include-partial-messages and session flags', () => {
    const first = buildChatArgv({ config: cfg, prompt: 'P', modelsDir: '/m', sessionId: SID, model: 'sonnet' });
    expect(first).toContain('--include-partial-messages');
    expect(first.slice(first.indexOf('--session-id'), first.indexOf('--session-id') + 2)).toEqual(['--session-id', SID]);
    expect(first[first.indexOf('--model') + 1]).toBe('sonnet');
    const again = buildChatArgv({ config: cfg, prompt: 'P', modelsDir: '/m', resume: SID });
    expect(again).toContain('--resume');
    expect(again).not.toContain('--session-id');
  });
});

describe('stream-json parsing', () => {
  it('ignores blank and non-JSON lines', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine(RECORDED_TEXT[0]!)).toBeNull();
    expect(parseStreamLine('{broken')).toBeNull();
    expect(parseStreamLine(RECORDED_TEXT[2]!)?.subtype).toBe('init');
  });

  it('maps messages to job events, session id and result', () => {
    const fixed = () => 'T';
    const events: string[] = [];
    let result;
    let session;
    for (const line of RECORDED_TOOL) {
      const msg = parseStreamLine(line);
      if (!msg) continue;
      const m = mapStreamMessage(msg, fixed);
      if (msg.type === 'system') session = m.sessionId;
      events.push(...m.events.map((e) => `${e.kind}:${e.text}`));
      if (m.result) result = m.result;
    }
    expect(session).toBe(SID);
    expect(events).toEqual([`system:Session ${SID}`, 'tool:Read /etc/hostname', 'text:The Read failed.', 'result:The Read failed.']);
    expect(result).toEqual({ text: 'The Read failed.', isError: false });
  });

  it('flags error results', () => {
    const m = mapStreamMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
    expect(m.result?.isError).toBe(true);
  });

  it('summarises tool calls', () => {
    expect(summariseToolUse('Read', { file_path: '/a/b' })).toBe('Read /a/b');
    expect(summariseToolUse('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(85);
    expect(summariseToolUse('Grep', { pattern: 'foo' })).toBe('Grep foo');
    expect(summariseToolUse('Agent', { description: 'explore' })).toBe('Agent explore');
    expect(summariseToolUse('Whatever', {})).toBe('Whatever');
  });
});

describe('claude-code chat translation', () => {
  function run(lines: string[]) {
    const tr = new ClaudeStreamTranslator();
    const chunks = [...tr.start()];
    for (const l of lines) {
      const m = parseStreamLine(l);
      if (m) chunks.push(...tr.push(m));
    }
    chunks.push(...tr.finish());
    return { tr, chunks };
  }

  it('translates streamed text into text-start / text-delta / text-end between start and finish', () => {
    const { tr, chunks } = run(RECORDED_TEXT);
    expect(tr.sessionId).toBe(SID);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'start-step', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish-step', 'finish']);
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta);
    expect(deltas.join('')).toBe('pong');
    const ids = new Set(chunks.filter((c) => 'id' in c).map((c) => (c as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it('emits tool-input-available then tool-output(-error) and does not duplicate unstreamed text', () => {
    const { chunks } = run(RECORDED_TOOL);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-input-available', 'tool-output-error', 'text-start', 'text-delta', 'text-end', 'finish']);
    expect(chunks[1]).toEqual({ type: 'tool-input-available', toolCallId: 'toolu_01', toolName: 'Read', input: { file_path: '/etc/hostname' } });
    expect(chunks[2]).toEqual({ type: 'tool-output-error', toolCallId: 'toolu_01', errorText: 'File does not exist.' });
  });

  it('reports a successful tool result as tool-output-available with the text', () => {
    const lines = [
      `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"session_id":"s"}`,
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a\\nb"}]}]},"session_id":"s"}`,
    ];
    const { chunks } = run(lines);
    expect(chunks[2]).toEqual({ type: 'tool-output-available', toolCallId: 't1', output: 'a\nb' });
  });

  it('turns an error result into an error chunk and finishes with reason error', () => {
    const { chunks } = run([`{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","session_id":"s"}`]);
    expect(chunks.at(-2)).toEqual({ type: 'error', errorText: 'boom' });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' });
  });

  it('ignores sub-agent traffic', () => {
    const { chunks } = run([`{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hidden"}]},"parent_tool_use_id":"toolu_x","session_id":"s"}`]);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'finish']);
  });
});

describe('chat prompt', () => {
  it('names the workspace, branch and skill, and keeps the user text last', () => {
    const p = buildChatPrompt({ workspacePath: '/w/workspace.dsl', adrsDir: '/w/adrs', branch: 'feat', model: 'shop', c4ModellerDir: '/skills/c4-modeller', text: 'add a cache' });
    expect(p).toContain('/w/workspace.dsl');
    expect(p).toContain('branch "feat"');
    expect(p).toContain('use the c4-modeller skill at /skills/c4-modeller'.replace('use', 'Use'));
    expect(p).toContain('keep identifiers and view keys stable');
    expect(p).toContain('/w/adrs/NNNN-<slug>.md');
    expect(p).toContain('ADR rules:');
    expect(p.endsWith('add a cache')).toBe(true);
  });

  it('extracts the last user text', () => {
    expect(lastUserText([{ role: 'user', parts: [{ type: 'text', text: 'one' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'x' }] }, { role: 'user', parts: [{ type: 'text', text: 'two' }, { type: 'file' }] }])).toBe('two');
  });
});

describe('spawnClaude', () => {
  afterEach(cleanupTmp);

  it('splits stdout into lines, captures stderr and survives a wrapper script without a shebang (ENOEXEC)', async () => {
    const dir = await tmpDir();
    const bin = path.join(dir, 'fake-claude');
    await fs.writeFile(bin, `echo '{"type":"result","result":"one"}'\nprintf '{"type":"system","subtype":"init"}\\n{"type":"x"'\necho >&2 "warn"\necho '}'\nexit 3\n`, { mode: 0o755 });
    const lines: string[] = [];
    const run = spawnClaude({ bin, argv: ['-p', 'x'], cwd: dir, onLine: (l) => lines.push(l) });
    const exit = await run.done;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain('warn');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['result', 'system', 'x']);
  });

  it('reports a missing binary as exit 127 with the error text', async () => {
    const run = spawnClaude({ bin: '/nonexistent/claude', argv: [], cwd: '/', onLine: () => undefined });
    const exit = await run.done;
    expect(exit.code).toBe(127);
    expect(exit.stderr).toContain('ENOENT');
  });
});
