import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse, generateId, type UIMessage, type UIMessageChunk } from 'ai';
import type { ChatMessageMeta } from '../../shared/types.ts';
import { buildChatArgv, parseStreamLine, resolveClaudeBinary, spawnClaude, type StreamMessage } from '../../core/claude.ts';
import { isInside } from '../../core/fsutil.ts';
import { findC4Modeller } from '../../core/paths.ts';
import type { StudioContext } from '../service.ts';
import type { AgentStep, AgentUsage } from '../../shared/types.ts';
import { RunRecorder } from './recorder.ts';
import { ADR_RULES } from './system-prompt.ts';
import { saveChat } from '../../core/agentlog.ts';

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Anthropic usage -> AgentUsage; input counts include cached reads and writes. */
function fromClaudeUsage(u: ClaudeUsage | undefined): AgentUsage | undefined {
  if (!u) return undefined;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const input = (u.input_tokens ?? 0) + read + write;
  const out: AgentUsage = { inputTokens: input, outputTokens: u.output_tokens, cacheReadTokens: read, cacheWriteTokens: write };
  out.totalTokens = input + (u.output_tokens ?? 0);
  return out;
}

/** Builds an agent run record from claude's stream-json messages. */
export class ClaudeRunTracker {
  readonly #rec: RunRecorder;
  readonly #steps = new Map<string, Omit<AgentStep, 'index'>>();
  #result: StreamMessage | undefined;

  constructor(rec: RunRecorder) {
    this.#rec = rec;
  }

  push(msg: StreamMessage): void {
    if (msg.parent_tool_use_id) return; // sub-agent traffic is summarised by the Agent tool call itself
    if (msg.type === 'system' && msg.subtype === 'init') {
      const { model, claude_code_version, tools, cwd, permissionMode, mcp_servers, apiKeySource } = msg as Record<string, unknown>;
      this.#rec.setMeta('init', { model, claude_code_version, tools, cwd, permissionMode, mcp_servers, apiKeySource });
      if (typeof msg.session_id === 'string') this.#rec.run.sessionId = msg.session_id;
    } else if (msg.type === 'assistant') {
      const m = msg.message as { id?: string; model?: string; usage?: ClaudeUsage; stop_reason?: string; content?: Block[] } | undefined;
      if (!m) return;
      const key = m.id ?? `m${this.#steps.size}`;
      let step = this.#steps.get(key);
      if (!step) {
        step = { responseId: m.id, modelId: m.model, toolCalls: [] };
        this.#steps.set(key, step);
      }
      if (m.usage) step.usage = fromClaudeUsage(m.usage);
      if (m.stop_reason) step.finishReason = m.stop_reason;
      for (const b of m.content ?? []) {
        if (b.type === 'text' && b.text) step.text = (step.text ? `${step.text}\n` : '') + b.text;
        else if (b.type === 'thinking' && typeof (b as { thinking?: unknown }).thinking === 'string') step.reasoning = (b as unknown as { thinking: string }).thinking;
        else if (b.type === 'tool_use' && b.id && b.name && !step.toolCalls.some((t) => t.id === b.id)) step.toolCalls.push(this.#rec.toolStart(b.id, b.name, b.input ?? {}));
      }
    } else if (msg.type === 'user') {
      const content = (msg.message as { content?: Block[] | string } | undefined)?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const text = toolResultText(b.content);
        this.#rec.toolEnd(b.tool_use_id, b.is_error ? { error: text || 'tool error' } : { output: text });
      }
    } else if (msg.type === 'result') {
      this.#result = msg;
    }
  }

  async finish(outcome: { aborted: boolean; error?: string }): Promise<void> {
    for (const step of this.#steps.values()) this.#rec.addStep(step);
    const r = this.#result as (StreamMessage & { total_cost_usd?: number; usage?: ClaudeUsage; result?: string; is_error?: boolean }) | undefined;
    if (r) {
      const { duration_ms, duration_api_ms, num_turns, modelUsage, subtype, permission_denials } = r as Record<string, unknown>;
      this.#rec.setMeta('result', { subtype, duration_ms, duration_api_ms, num_turns, modelUsage, permission_denials });
    }
    const failed = !!r?.is_error || (typeof r?.subtype === 'string' && r.subtype.startsWith('error'));
    await this.#rec.finish({
      status: outcome.aborted ? 'aborted' : failed || outcome.error ? 'failed' : 'succeeded',
      finishReason: typeof r?.subtype === 'string' ? r.subtype : undefined,
      error: outcome.aborted ? 'stopped by the user' : failed ? (typeof r?.result === 'string' ? r.result : 'claude reported an error') : outcome.error,
      usage: fromClaudeUsage(r?.usage),
      cost: typeof r?.total_cost_usd === 'number' ? { usd: r.total_cost_usd, source: 'provider', note: 'total_cost_usd reported by Claude Code' } : undefined,
    });
  }
}

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** Translates claude's stream-json messages (with --include-partial-messages) into AI SDK UI message chunks. */
export class ClaudeStreamTranslator {
  sessionId: string | undefined;
  #started = false;
  #n = 0;
  #open = new Map<number, string>();
  #toolAtIndex = new Map<number, string>();
  #streamedText = new Set<string>();
  #currentMessage = '';
  #toolsSeen = new Set<string>();
  #toolsAvailable = new Set<string>();
  #errored = false;

  /** The `start` chunk, carrying the answer's metadata; emit it first. */
  start(messageMetadata?: unknown): UIMessageChunk[] {
    if (this.#started) return [];
    this.#started = true;
    return [messageMetadata === undefined ? { type: 'start' } : { type: 'start', messageMetadata }];
  }

  push(msg: StreamMessage): UIMessageChunk[] {
    if (typeof msg.session_id === 'string') this.sessionId ??= msg.session_id;
    if (msg.parent_tool_use_id) return []; // sub-agent traffic
    const out: UIMessageChunk[] = [];
    switch (msg.type) {
      case 'stream_event':
        this.#streamEvent(msg.event as { type: string; index?: number; message?: { id?: string }; content_block?: Block; delta?: { type: string; text?: string; partial_json?: string } }, out);
        break;
      case 'assistant': {
        const message = msg.message as { id?: string; content?: Block[] } | undefined;
        for (const b of message?.content ?? []) {
          if (b.type === 'text' && b.text && !this.#streamedText.has(message?.id ?? '')) {
            const id = `text-${this.#n++}`;
            out.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: b.text }, { type: 'text-end', id });
          } else if (b.type === 'tool_use' && b.id && b.name) {
            if (!this.#toolsAvailable.has(b.id)) {
              this.#toolsAvailable.add(b.id);
              out.push({ type: 'tool-input-available', toolCallId: b.id, toolName: b.name, input: b.input ?? {} });
            }
          }
        }
        break;
      }
      case 'user': {
        const content = (msg.message as { content?: Block[] | string } | undefined)?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type !== 'tool_result' || !b.tool_use_id || !this.#toolsAvailable.has(b.tool_use_id)) continue;
          const text = toolResultText(b.content);
          if (b.is_error) out.push({ type: 'tool-output-error', toolCallId: b.tool_use_id, errorText: text || 'tool error' });
          else out.push({ type: 'tool-output-available', toolCallId: b.tool_use_id, output: text });
        }
        break;
      }
      case 'result':
        if (msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))) {
          this.#errored = true;
          out.push({ type: 'error', errorText: typeof msg.result === 'string' && msg.result ? msg.result : 'claude reported an error' });
        }
        break;
    }
    return out;
  }

  #streamEvent(
    ev: { type: string; index?: number; message?: { id?: string }; content_block?: Block; delta?: { type: string; text?: string; partial_json?: string } },
    out: UIMessageChunk[],
  ): void {
    if (!ev) return;
    switch (ev.type) {
      case 'message_start':
        this.#currentMessage = ev.message?.id ?? '';
        out.push({ type: 'start-step' });
        break;
      case 'content_block_start': {
        const b = ev.content_block;
        if (ev.index === undefined || !b) break;
        if (b.type === 'text') {
          const id = `text-${this.#n++}`;
          this.#open.set(ev.index, id);
          this.#streamedText.add(this.#currentMessage);
          out.push({ type: 'text-start', id });
        } else if (b.type === 'tool_use' && b.id && b.name) {
          this.#toolAtIndex.set(ev.index, b.id);
          this.#toolsSeen.add(b.id);
          out.push({ type: 'tool-input-start', toolCallId: b.id, toolName: b.name });
        }
        break;
      }
      case 'content_block_delta': {
        if (ev.index === undefined || !ev.delta) break;
        if (ev.delta.type === 'text_delta' && ev.delta.text) {
          const id = this.#open.get(ev.index);
          if (id) out.push({ type: 'text-delta', id, delta: ev.delta.text });
        } else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
          const toolCallId = this.#toolAtIndex.get(ev.index);
          if (toolCallId) out.push({ type: 'tool-input-delta', toolCallId, inputTextDelta: ev.delta.partial_json });
        }
        break;
      }
      case 'content_block_stop': {
        if (ev.index === undefined) break;
        const id = this.#open.get(ev.index);
        if (id) {
          this.#open.delete(ev.index);
          out.push({ type: 'text-end', id });
        }
        this.#toolAtIndex.delete(ev.index);
        break;
      }
      case 'message_stop':
        out.push({ type: 'finish-step' });
        break;
    }
  }

  /** Close anything still open and emit `finish`. */
  finish(): UIMessageChunk[] {
    const out: UIMessageChunk[] = [];
    for (const id of this.#open.values()) out.push({ type: 'text-end', id });
    this.#open.clear();
    out.push({ type: 'finish', finishReason: this.#errored ? 'error' : 'stop' });
    return out;
  }
}

/** Plain text of the last user message. */
export function lastUserText(messages: Array<{ role?: string; parts?: Array<{ type: string; text?: string }> }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    return (m.parts ?? []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n').trim();
  }
  return '';
}

export function buildChatPrompt(opts: { workspacePath: string; adrsDir: string; branch: string; model: string; c4ModellerDir: string; text: string }): string {
  return (
    `You are working on branch "${opts.branch}" of the C4 model "${opts.model}" in C4 Studio.\n` +
    `The workspace file is ${opts.workspacePath} (Structurizr DSL). ` +
    `Use the c4-modeller skill at ${opts.c4ModellerDir} for model changes; keep identifiers and view keys stable. ` +
    `Make model changes in that workspace file, and validate with ${opts.c4ModellerDir}/scripts/validate.sh.\n` +
    `Architecture decision records are the files ${opts.adrsDir}/NNNN-<slug>.md: YAML frontmatter (id, title, status: proposed|accepted|rejected|deprecated|superseded, date, elements: [element ids], optional supersedes and supersededBy) ` +
    `and the sections "## Context", "## Decision" and "## Consequences". You may create, edit and delete them.\n` +
    `${ADR_RULES}\n\n` +
    opts.text
  );
}

export class ChatError extends Error {
  status: 400 | 404 | 500;
  constructor(message: string, status: 400 | 404 | 500 = 400) {
    super(message);
    this.status = status;
  }
}

/** Run a headless claude for one chat turn and stream it as a UI message stream. */
export function claudeCodeChat(
  ctx: StudioContext,
  req: {
    model: string;
    branch: string;
    chatId: string;
    modelId: string;
    /** Session to resume; a new one is started without it */
    resume?: string;
    /** The chat so far, ending with the new prompt */
    messages: UIMessage[];
    meta: (runId: string) => ChatMessageMeta;
  },
  signal?: AbortSignal,
): Response {
  const bin = resolveClaudeBinary();
  if (!bin) throw new ChatError('claude binary not found on PATH (set C4_STUDIO_CLAUDE)', 400);
  const c4 = findC4Modeller(ctx.projectRoot, ctx.skillDir);
  if (!c4) throw new ChatError('c4-modeller skill not found', 400);
  const text = lastUserText(req.messages as Parameters<typeof lastUserText>[0]);
  if (!text) throw new ChatError('no user message', 400);

  const { model, branch, chatId, modelId, resume } = req;
  const sessionId = resume ?? randomUUID();
  const paths = ctx.store.branchPaths(model, branch);
  const prompt = buildChatPrompt({ workspacePath: paths.workspace, adrsDir: paths.adrs, branch, model, c4ModellerDir: c4, text });
  const argv = buildChatArgv({
    config: ctx.config.claude,
    prompt,
    modelsDir: ctx.modelsDir,
    extraDirs: isInside(ctx.projectRoot, c4) ? [] : [c4],
    model: modelId,
    resume,
    sessionId: resume ? undefined : sessionId,
  });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const tr = new ClaudeStreamTranslator();
      const rec = new RunRecorder(ctx, { model, branch, chatId, provider: 'claude-code', modelId, prompt: text, sessionId });
      rec.setMeta('argv', argv.map((a) => (a === prompt ? '<prompt>' : a)));
      const tracker = new ClaudeRunTracker(rec);
      let exitError: string | undefined;
      for (const c of tr.start(req.meta(rec.run.id))) writer.write(c);
      const jobId = `chat-${sessionId}`;
      await ctx.state.setBusy(model, branch, { jobId, label: `chat: ${text.slice(0, 80)}` });
      try {
        const run = spawnClaude({
          bin,
          argv,
          cwd: ctx.projectRoot,
          env: process.env,
          onLine: (line) => {
            const msg = parseStreamLine(line);
            if (!msg) return;
            tracker.push(msg);
            for (const c of tr.push(msg)) writer.write(c);
          },
        });
        signal?.addEventListener('abort', () => run.cancel(), { once: true });
        const exit = await run.done;
        if (exit.code !== 0 && !signal?.aborted) {
          const tail = exit.stderr.trim().split('\n').slice(-5).join('\n');
          exitError = tail || `claude exited with code ${exit.code}`;
          writer.write({ type: 'error', errorText: exitError });
        }
        for (const c of tr.finish()) writer.write(c);
      } finally {
        await tracker.finish({ aborted: !!signal?.aborted, error: exitError });
        try {
          await ctx.store.snapshot(model, branch, { source: 'agent', message: `chat: ${text.slice(0, 80)}` });
        } catch {
          // branch may have been deleted
        }
        await ctx.state.setBusy(model, branch, null);
      }
    },
    originalMessages: req.messages,
    generateId,
    onEnd: ({ messages }) => saveChat(ctx.modelsDir, model, { id: chatId, messages, sessionId }).then(() => undefined, () => undefined),
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });
  return createUIMessageStreamResponse({ stream });
}
