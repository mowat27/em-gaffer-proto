// List prices, used to estimate cost when a provider does not report it. OpenRouter publishes
// per-token prices for its catalogue, which includes Anthropic's models at Anthropic's list price.
import type { AgentCost, AgentUsage, ChatProviderId } from '../../shared/types.ts';

interface Price {
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
}

let cache: { at: number; prices: Map<string, Price> } | null = null;
const DAY_MS = 24 * 60 * 60 * 1000;

async function openRouterPrices(): Promise<Map<string, Price>> {
  if (cache && Date.now() - cache.at < DAY_MS) return cache.prices;
  const headers: Record<string, string> = process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {};
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`openrouter.ai returned ${res.status}`);
  const data = (await res.json()) as { data?: { id: string; pricing?: Record<string, string> }[] };
  const prices = new Map<string, Price>();
  for (const m of data.data ?? []) {
    const p = m.pricing ?? {};
    const num = (k: string) => (p[k] !== undefined && Number.isFinite(Number(p[k])) ? Number(p[k]) : undefined);
    const prompt = num('prompt');
    const completion = num('completion');
    if (prompt === undefined || completion === undefined) continue;
    prices.set(m.id, { prompt, completion, cacheRead: num('input_cache_read'), cacheWrite: num('input_cache_write') });
  }
  cache = { at: Date.now(), prices };
  return prices;
}

/** OpenRouter catalogue id for a provider's model id, when the mapping is known. */
function catalogueId(provider: ChatProviderId, modelId: string): string | undefined {
  if (provider === 'openrouter') return modelId;
  // claude-sonnet-5-5 -> anthropic/claude-sonnet-5.5
  if (provider === 'anthropic') return `anthropic/${modelId.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  return undefined;
}

/** Estimate a cost from list prices; 'unknown' when the model or the token counts are not known. */
export async function estimateCost(provider: ChatProviderId, modelId: string, usage: AgentUsage): Promise<AgentCost> {
  const id = catalogueId(provider, modelId);
  if (!id) return { usd: null, source: 'unknown', note: `${provider} does not report cost and has no published price list here` };
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return { usd: null, source: 'unknown', note: 'no token counts reported' };
  let prices: Map<string, Price>;
  try {
    prices = await openRouterPrices();
  } catch (err) {
    return { usd: null, source: 'unknown', note: `price list unavailable: ${(err as Error).message}` };
  }
  const p = prices.get(id);
  if (!p) return { usd: null, source: 'unknown', note: `no list price for ${id}` };
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const plainInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const usd =
    plainInput * p.prompt + cacheRead * (p.cacheRead ?? p.prompt) + cacheWrite * (p.cacheWrite ?? p.prompt) + (usage.outputTokens ?? 0) * p.completion;
  return { usd, source: 'estimated', note: `from the list price of ${id}` };
}
