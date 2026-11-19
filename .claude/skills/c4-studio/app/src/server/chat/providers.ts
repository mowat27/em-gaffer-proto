import { createAnthropic } from '@ai-sdk/anthropic';
import { createFireworks } from '@ai-sdk/fireworks';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { ChatProviderId, ChatProviderInfo, StudioConfig } from '../../shared/types.ts';
import { DEFAULT_CHAT_MODELS } from '../../core/config.ts';
import { resolveClaudeBinary } from '../../core/claude.ts';

/** Fallback list shown when a provider's live model list cannot be fetched. */
export const SUGGESTED_MODELS: Record<ChatProviderId, string[]> = {
  openrouter: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5', 'openai/gpt-5.6-sol', 'google/gemini-3.8-flash', 'moonshotai/kimi-k2.7-code'],
  fireworks: ['accounts/fireworks/models/kimi-k3', 'accounts/fireworks/models/glm-5p3', 'accounts/fireworks/models/deepseek-v4p1-flash', 'accounts/fireworks/models/gpt-oss-120b'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  'claude-code': ['opus', 'sonnet', 'haiku', 'fable'],
};

export interface ProviderModels {
  provider: ChatProviderId;
  models: string[];
  /** 'live' from the provider's API, 'fallback' when the key is missing or the call failed */
  source: 'live' | 'fallback';
  error?: string;
}

const MODEL_CACHE = new Map<ChatProviderId, { at: number; value: ProviderModels }>();
const CACHE_MS = 10 * 60 * 1000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

const ids = (data: unknown): string[] =>
  Array.isArray((data as { data?: unknown[] })?.data) ? ((data as { data: { id?: unknown }[] }).data.map((m) => m.id).filter((x): x is string => typeof x === 'string')) : [];

/** Chat-capable model ids for a provider, fetched live with the user's key and cached for 10 minutes. */
export async function listProviderModels(provider: ChatProviderId, env: NodeJS.ProcessEnv = process.env): Promise<ProviderModels> {
  const fallback = (error?: string): ProviderModels => ({ provider, models: SUGGESTED_MODELS[provider], source: 'fallback', ...(error ? { error } : {}) });
  if (provider === 'claude-code') return fallback();
  const key = env[KEY_ENV[provider]];
  if (!key) return fallback(`${KEY_ENV[provider]} is not set`);
  const cached = MODEL_CACHE.get(provider);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  try {
    let models: string[] = [];
    if (provider === 'openrouter') {
      const data = (await getJson('https://openrouter.ai/api/v1/models', { Authorization: `Bearer ${key}` })) as {
        data?: { id: string; architecture?: { output_modalities?: string[] } }[];
      };
      models = (data.data ?? [])
        .filter((m) => !m.id.endsWith(':batch') && (m.architecture?.output_modalities ?? ['text']).includes('text'))
        .map((m) => m.id);
    } else if (provider === 'fireworks') {
      models = ids(await getJson('https://api.fireworks.ai/inference/v1/models', { Authorization: `Bearer ${key}` })).filter(
        (id) => !/embed|rerank|whisper|flux|stable-diffusion|image/i.test(id),
      );
    } else {
      models = ids(await getJson('https://api.anthropic.com/v1/models?limit=1000', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }));
    }
    if (models.length === 0) return fallback('the provider returned no models');
    const value: ProviderModels = { provider, models: [...new Set(models)].sort(), source: 'live' };
    MODEL_CACHE.set(provider, { at: Date.now(), value });
    return value;
  } catch (err) {
    return fallback((err as Error).message);
  }
}

const KEY_ENV: Record<Exclude<ChatProviderId, 'claude-code'>, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const LABELS: Record<ChatProviderId, string> = {
  openrouter: 'OpenRouter',
  fireworks: 'Fireworks',
  anthropic: 'Anthropic',
  'claude-code': 'Claude Code (headless)',
};

export function chatProviders(config: StudioConfig, env: NodeJS.ProcessEnv = process.env): ChatProviderInfo[] {
  const ids: ChatProviderId[] = ['openrouter', 'fireworks', 'anthropic', 'claude-code'];
  return ids.map((id) => {
    const defaultModel = config.chat.models[id] ?? (id === 'claude-code' ? config.claude.model : DEFAULT_CHAT_MODELS[id]);
    const suggested = [defaultModel, ...SUGGESTED_MODELS[id].filter((m) => m !== defaultModel)];
    if (id === 'claude-code') {
      const bin = resolveClaudeBinary();
      return { id, label: LABELS[id], available: !!bin, ...(bin ? {} : { reason: 'claude binary not found on PATH (set C4_STUDIO_CLAUDE)' }), defaultModel, suggestedModels: suggested };
    }
    const keyName = KEY_ENV[id];
    const has = !!env[keyName];
    return { id, label: LABELS[id], available: has, ...(has ? {} : { reason: `Set ${keyName} in c4-studio/.env` }), defaultModel, suggestedModels: suggested };
  });
}

export class ProviderError extends Error {
  status = 400 as const;
}

/** Build an AI SDK language model. Keys come from the environment; the environment handles any proxying. */
export function createChatModel(provider: Exclude<ChatProviderId, 'claude-code'>, modelId: string, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const keyName = KEY_ENV[provider];
  const apiKey = env[keyName];
  if (!apiKey) throw new ProviderError(`${keyName} is not set. Add it to c4-studio/.env or the environment.`);
  switch (provider) {
    case 'openrouter':
      // Usage accounting makes OpenRouter report each call's cost in the provider metadata.
      return createOpenRouter({ apiKey }).chat(modelId, { usage: { include: true } }) as unknown as LanguageModel;
    case 'fireworks':
      return createFireworks({ apiKey })(modelId) as unknown as LanguageModel;
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId) as unknown as LanguageModel;
  }
}
