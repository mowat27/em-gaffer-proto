// Records one assistant turn (an "agent run") for the agent history: every model step, tool call
// with input, output and timing, token counts, cost and provider metadata.
import { randomBytes } from 'node:crypto';
import type { AgentCost, AgentRun, AgentStep, AgentToolCall, AgentUsage, ChatProviderId } from '../../shared/types.ts';
import { appendRun, summarise } from '../../core/agentlog.ts';
import type { StudioContext } from '../service.ts';
import { estimateCost } from './pricing.ts';

const MAX_OUTPUT_CHARS = 20_000;

/** Keep stored tool outputs bounded; large file reads would otherwise bloat runs.jsonl. */
function bounded(v: unknown): unknown {
  if (v === undefined) return undefined;
  let text: string;
  try {
    text = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
  if (text.length <= MAX_OUTPUT_CHARS) return typeof v === 'string' ? v : JSON.parse(text);
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated (${text.length} characters in total)`;
}

export function addUsage(a: AgentUsage, b: AgentUsage | undefined): AgentUsage {
  if (!b) return a;
  const out: AgentUsage = { ...a };
  for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!;
  }
  return out;
}

export class RunRecorder {
  readonly run: AgentRun;
  readonly #ctx: StudioContext;
  readonly #t0 = Date.now();
  readonly #tools = new Map<string, AgentToolCall>();
  #done = false;

  constructor(ctx: StudioContext, init: { model: string; branch: string; chatId?: string; provider: ChatProviderId; modelId: string; prompt: string; sessionId?: string }) {
    this.#ctx = ctx;
    this.run = {
      id: `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      model: init.model,
      branch: init.branch,
      ...(init.chatId ? { chatId: init.chatId } : {}),
      provider: init.provider,
      modelId: init.modelId,
      startedAt: new Date(this.#t0).toISOString(),
      status: 'running',
      prompt: init.prompt,
      usage: {},
      cost: { usd: null, source: 'unknown' },
      steps: [],
      ...(init.sessionId ? { sessionId: init.sessionId } : {}),
    };
  }

  /** Note a tool call starting; returns the record so the caller can fill in the outcome. */
  toolStart(id: string, name: string, input: unknown): AgentToolCall {
    const existing = this.#tools.get(id);
    if (existing) return existing;
    const call: AgentToolCall = { id, name, input: bounded(input), startedAt: new Date().toISOString() };
    this.#tools.set(id, call);
    return call;
  }

  toolEnd(id: string, outcome: { output?: unknown; error?: string }): void {
    const call = this.#tools.get(id);
    if (!call) return;
    if (outcome.error !== undefined) call.error = outcome.error;
    else call.output = bounded(outcome.output);
    if (call.startedAt) call.durationMs = Date.now() - Date.parse(call.startedAt);
  }

  tool(id: string): AgentToolCall | undefined {
    return this.#tools.get(id);
  }

  /** Wrap AI SDK tools so each execution is timed and its output or error recorded. */
  wrapTools<T extends Record<string, { execute?: (...args: never[]) => unknown }>>(tools: T): T {
    const out: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(tools)) {
      const execute = t.execute as ((input: unknown, options: { toolCallId: string }) => unknown) | undefined;
      out[name] = !execute
        ? t
        : {
            ...t,
            execute: async (input: unknown, options: { toolCallId: string }) => {
              this.toolStart(options.toolCallId, name, input);
              try {
                const result = await execute(input, options);
                const failed = result && typeof result === 'object' && (result as { ok?: unknown }).ok === false;
                this.toolEnd(options.toolCallId, failed ? { output: result, error: String((result as { error?: unknown }).error ?? 'tool reported an error') } : { output: result });
                return result;
              } catch (err) {
                this.toolEnd(options.toolCallId, { error: err instanceof Error ? err.message : String(err) });
                throw err;
              }
            },
          };
    }
    return out as T;
  }

  addStep(step: Omit<AgentStep, 'index'>): void {
    this.run.steps.push({ index: this.run.steps.length, ...step });
  }

  setMeta(key: string, value: unknown): void {
    if (value === undefined) return;
    this.run.meta = { ...(this.run.meta ?? {}), [key]: value };
  }

  /** Finish the run once: total usage, cost, save to runs.jsonl and tell open browsers. */
  async finish(outcome: { status: AgentRun['status']; finishReason?: string; error?: string; usage?: AgentUsage; cost?: AgentCost }): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    const run = this.run;
    run.status = outcome.status;
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - this.#t0;
    if (outcome.finishReason) run.finishReason = outcome.finishReason;
    if (outcome.error) run.error = outcome.error;
    run.usage = outcome.usage ?? run.steps.reduce<AgentUsage>((u, s) => addUsage(u, s.usage), {});
    // Tool calls that never reached a step (an abort mid-turn) still belong in the record.
    const inSteps = new Set(run.steps.flatMap((s) => s.toolCalls.map((t) => t.id)));
    const orphans = [...this.#tools.values()].filter((t) => !inSteps.has(t.id));
    if (orphans.length) this.addStep({ toolCalls: orphans, finishReason: 'incomplete' });
    run.cost = outcome.cost ?? (await estimateCost(run.provider, run.modelId, run.usage));
    try {
      await appendRun(this.#ctx.modelsDir, run);
      this.#ctx.hub.broadcast({ type: 'agent-run', run: summarise(run) });
    } catch {
      // the branch may have been deleted; the run is lost, the chat is not
    }
  }
}

/** AI SDK usage -> AgentUsage */
export function fromSdkUsage(u: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
} | undefined): AgentUsage | undefined {
  if (!u) return undefined;
  const out: AgentUsage = {};
  if (u.inputTokens !== undefined) out.inputTokens = u.inputTokens;
  if (u.outputTokens !== undefined) out.outputTokens = u.outputTokens;
  if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens;
  if (u.inputTokenDetails?.cacheReadTokens !== undefined) out.cacheReadTokens = u.inputTokenDetails.cacheReadTokens;
  if (u.inputTokenDetails?.cacheWriteTokens !== undefined) out.cacheWriteTokens = u.inputTokenDetails.cacheWriteTokens;
  if (u.outputTokenDetails?.reasoningTokens !== undefined) out.reasoningTokens = u.outputTokenDetails.reasoningTokens;
  return out;
}
