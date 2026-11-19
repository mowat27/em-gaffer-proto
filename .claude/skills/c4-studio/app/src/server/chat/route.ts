import { Hono } from 'hono';
import { convertToModelMessages, generateId, stepCountIs, streamText, type UIMessage } from 'ai';
import type { Context } from 'hono';
import type { AgentCost, AgentUsage, ChatMessageMeta, ChatProviderId, ChatRequestBody } from '../../shared/types.ts';
import { listSkillNames, buildTools } from './tools.ts';
import { ChatError, claudeCodeChat, lastUserText } from './claude-code.ts';
import { addUsage, fromSdkUsage, RunRecorder } from './recorder.ts';
import { AgentLogError, getChat, getRun, isValidChatId, listChats, listRuns, saveChat } from '../../core/agentlog.ts';
import { chatProviders, createChatModel, listProviderModels, ProviderError } from './providers.ts';
import { loadEnv } from '../../core/env.ts';
import { saveChatSelection, saveFavourites } from '../../core/config.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { errorResponse, type StudioContext } from '../service.ts';

const PROVIDERS: ChatProviderId[] = ['openrouter', 'fireworks', 'anthropic', 'claude-code'];

function logError(c: Context, err: unknown): Response {
  if (err instanceof AgentLogError) return c.json({ error: err.message }, 400);
  throw err;
}

function userMessage(m: unknown): UIMessage {
  const msg = m as Partial<UIMessage> | null;
  if (!msg || typeof msg !== 'object' || msg.role !== 'user' || typeof msg.id !== 'string' || !msg.id || !Array.isArray(msg.parts)) {
    throw new ChatError('message must be a user message: { id, role: "user", parts: [] }', 400);
  }
  return msg as UIMessage;
}

export function chatRoutes(ctx: StudioContext): Hono {
  const app = new Hono();

  // Re-read c4-studio/.env on each request so keys added while the server runs are picked up.
  app.get('/providers', (c) => {
    loadEnv(ctx.projectRoot);
    return c.json(chatProviders(ctx.config));
  });

  // The provider and model last chosen in the chat panel, saved as its defaults.
  app.put('/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { provider?: unknown; model?: unknown } | null;
    const provider = body?.provider as ChatProviderId;
    if (!PROVIDERS.includes(provider)) return c.json({ error: `unknown provider: ${String(body?.provider)}` }, 400);
    if (typeof body?.model !== 'string' || !body.model.trim()) return c.json({ error: 'model must be a non-empty string' }, 400);
    const model = body.model.trim();
    saveChatSelection(ctx.projectRoot, provider, model);
    ctx.config.chat.provider = provider;
    ctx.config.chat.models = { ...ctx.config.chat.models, [provider]: model };
    return c.json({ provider, model });
  });

  app.put('/favourites/:id', async (c) => {
    const id = c.req.param('id') as ChatProviderId;
    if (!PROVIDERS.includes(id)) return c.json({ error: `unknown provider: ${id}` }, 404);
    const body = (await c.req.json().catch(() => null)) as { models?: unknown } | null;
    if (!body || !Array.isArray(body.models) || !body.models.every((m) => typeof m === 'string')) {
      return c.json({ error: 'body must be { models: string[] }' }, 400);
    }
    const models = [...new Set(body.models as string[])].filter(Boolean);
    saveFavourites(ctx.projectRoot, id, models);
    ctx.config.chat.favourites = { ...(ctx.config.chat.favourites ?? {}), [id]: models };
    return c.json({ provider: id, models });
  });

  // Chats belong to a model, not a branch: the agent works on whichever branch is open when a prompt
  // is sent. The server saves each chat as prompts and answers arrive.
  app.get('/chats/:model', async (c) => {
    try {
      return c.json(await listChats(ctx.modelsDir, c.req.param('model')));
    } catch (err) {
      return logError(c, err);
    }
  });

  app.get('/chats/:model/:id', async (c) => {
    try {
      const chat = await getChat(ctx.modelsDir, c.req.param('model'), c.req.param('id'));
      return chat ? c.json(chat) : c.json({ error: 'chat not found' }, 404);
    } catch (err) {
      return logError(c, err);
    }
  });

  // Agent history: one record per assistant turn.
  app.get('/runs/:model/:branch', async (c) => {
    try {
      const limit = Math.min(Number(c.req.query('limit') ?? 500) || 500, 5000);
      return c.json(await listRuns(ctx.modelsDir, c.req.param('model'), c.req.param('branch'), limit));
    } catch (err) {
      return logError(c, err);
    }
  });

  app.get('/runs/:model/:branch/:id', async (c) => {
    try {
      const run = await getRun(ctx.modelsDir, c.req.param('model'), c.req.param('branch'), c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'run not found' }, 404);
    } catch (err) {
      return logError(c, err);
    }
  });

  app.get('/providers/:id/models', async (c) => {
    const id = c.req.param('id') as ChatProviderId;
    if (!PROVIDERS.includes(id)) return c.json({ error: `unknown provider: ${id}` }, 404);
    loadEnv(ctx.projectRoot);
    return c.json(await listProviderModels(id));
  });

  app.post('/', async (c) => {
    let body: Partial<ChatRequestBody> | null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      if (!body || typeof body !== 'object') throw new ChatError('body must be { model, branch, chatId, message, provider, modelId }', 400);
      const message = userMessage(body.message);
      if (!body.model || !body.branch) throw new ChatError('model and branch are required', 400);
      if (!isValidChatId(body.chatId)) throw new ChatError('chatId is required: 8 to 64 letters, digits, - or _', 400);
      const provider = (body.provider ?? ctx.config.chat.provider) as ChatProviderId;
      if (!PROVIDERS.includes(provider)) throw new ChatError(`unknown provider: ${String(body.provider)}`, 400);
      await ctx.store.requireBranch(body.model, body.branch);
      const { model, branch, chatId } = body;
      const modelId = body.modelId || ctx.config.chat.models[provider] || (provider === 'claude-code' ? ctx.config.claude.model : '');
      const languageModel = provider === 'claude-code' ? undefined : createChatModel(provider, modelId);

      // The saved chat plus the new prompt. A prompt sent again (Retry) replaces itself and the answer after it.
      const chat = await getChat(ctx.modelsDir, model, chatId);
      const saved = (chat?.messages ?? []) as UIMessage[];
      const at = saved.findIndex((m) => m.id === message.id);
      const before = at >= 0 ? saved.slice(0, at) : saved;
      const messages = [...before, message];
      // Saved now, so the prompt is kept even when the answer fails or the server stops.
      await saveChat(ctx.modelsDir, model, { id: chatId, messages });
      const meta = (runId: string): ChatMessageMeta => ({ runId, provider, modelId, branch });

      if (provider === 'claude-code') {
        // Resume the session only while the chat stays with claude-code and the same model: a session
        // started earlier has not seen the answers another provider gave since. Chats saved before
        // answers carried metadata only kept a session when claude-code answered last.
        const prev = before.findLast((m) => m.role === 'assistant')?.metadata as Partial<ChatMessageMeta> | undefined;
        const resume = chat?.sessionId && (!prev || (prev.provider === 'claude-code' && prev.modelId === modelId)) ? chat.sessionId : undefined;
        return claudeCodeChat(ctx, { model, branch, chatId, modelId, resume, messages, meta }, c.req.raw.signal);
      }

      const state = await ctx.service.branchState(model, branch);
      const skills = await listSkillNames(ctx);
      const rec = new RunRecorder(ctx, { model, branch, chatId, provider, modelId, prompt: lastUserText(messages as never) });
      rec.setMeta('messagesInContext', messages.length);
      let providerCost: number | undefined;
      const result = streamText({
        model: languageModel!,
        system: buildSystemPrompt(state, { skills }),
        messages: await convertToModelMessages(messages),
        tools: rec.wrapTools(buildTools(ctx, model, branch)),
        stopWhen: stepCountIs(40),
        abortSignal: c.req.raw.signal,
        onStepFinish: (step) => {
          const cost = (step.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined)?.openrouter?.usage?.cost;
          if (typeof cost === 'number') providerCost = (providerCost ?? 0) + cost;
          rec.addStep({
            modelId: step.response?.modelId,
            responseId: step.response?.id,
            finishReason: step.finishReason,
            usage: fromSdkUsage(step.usage as never),
            text: step.text || undefined,
            reasoning: step.reasoningText || undefined,
            toolCalls: step.toolCalls.map((tc) => {
              const recorded = rec.tool(tc.toolCallId);
              const res = step.toolResults.find((r) => r.toolCallId === tc.toolCallId) as { output?: unknown } | undefined;
              return recorded ?? { id: tc.toolCallId, name: tc.toolName, input: tc.input, output: res?.output };
            }),
            warnings: step.warnings?.length ? (step.warnings as unknown[]) : undefined,
            providerMetadata: step.providerMetadata,
          });
        },
        onFinish: (ev) => {
          const usage = fromSdkUsage(ev.totalUsage as never) ?? rec.run.steps.reduce<AgentUsage>((u, s) => addUsage(u, s.usage), {});
          const cost: AgentCost | undefined = providerCost !== undefined ? { usd: providerCost, source: 'provider', note: 'reported by OpenRouter usage accounting' } : undefined;
          void rec.finish({ status: 'succeeded', finishReason: ev.finishReason, usage, cost });
        },
        onError: ({ error }) => {
          void rec.finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
        },
        onAbort: () => {
          void rec.finish({ status: 'aborted', error: 'stopped by the user' });
        },
      });
      return result.toUIMessageStreamResponse({
        originalMessages: messages,
        generateMessageId: generateId,
        messageMetadata: ({ part }) => (part.type === 'start' ? meta(rec.run.id) : undefined),
        // The chat never shows reasoning; the Agent history records it with each step.
        sendReasoning: false,
        // Saved here rather than in the browser, so the answer is kept even when the page is closed or
        // moves to another chat or model while it streams.
        onEnd: ({ messages: all }) => saveChat(ctx.modelsDir, model, { id: chatId, messages: all }).then(() => undefined, () => undefined),
        onError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
      });
    } catch (err) {
      if (err instanceof ChatError || err instanceof ProviderError || err instanceof AgentLogError) return c.json({ error: err.message }, err.status);
      const { status, body: b } = errorResponse(err);
      return c.json(b, status);
    }
  });

  return app;
}
