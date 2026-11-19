import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

process.env.C4_STUDIO_VALIDATOR = 'none';
vi.mock('../../src/core/dsl/index.ts', async () => await import('./helpers/fake-dsl.ts'));

// Every answer thinks first, then says "Answer <n>".
let answers = 0;
const llm = new MockLanguageModelV4({
  doStream: async () => {
    const n = ++answers;
    return {
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: `a long chain of thought ${n}` },
        { type: 'reasoning-end', id: 'r' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: `Answer ${n}` },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 3, reasoning: 2 } },
        },
      ]),
    };
  },
});
vi.mock('../../src/server/chat/providers.ts', async (orig) => ({ ...(await orig<object>()), createChatModel: () => llm }));
// Cost estimates fetch OpenRouter's price list.
vi.mock('../../src/server/chat/pricing.ts', () => ({ estimateCost: async () => ({ usd: null, source: 'unknown' }) }));

const { createStudio } = await import('../../src/server/app.ts');
const { chatTitle, getChat, listChats, saveChat } = await import('../../src/core/agentlog.ts');

let studio: Awaited<ReturnType<typeof createStudio>>;
let root: string;
let models: string;

beforeAll(async () => {
  root = await tmpDir('c4s-chats-');
  studio = await createStudio({ projectRoot: root, watch: false });
  await studio.ctx.service.createModel({ name: 'Shop' });
  await studio.ctx.service.createModel({ name: 'Old' });
  models = studio.ctx.modelsDir;
});
afterAll(async () => {
  await studio.close();
  await cleanupTmp();
});

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const until = async <T>(fn: () => Promise<T | undefined | null | false>): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};
const texts = (messages: unknown[]) =>
  (messages as { role: string; parts: { type: string; text?: string }[] }[]).map(
    (m) => `${m.role}: ${m.parts.filter((p) => p.type !== 'step-start').map((p) => p.text ?? `[${p.type}]`).join('')}`,
  );

describe('chat storage', () => {
  it('titles a chat with the first line of its first prompt', () => {
    expect(chatTitle([user('1', '\n  Add a   payments service\nand a queue')])).toBe('Add a payments service');
    expect(chatTitle([])).toBe('New chat');
    expect(chatTitle([user('1', 'x'.repeat(100))])).toHaveLength(80);
  });

  it('keeps one file per chat, lists them newest first and drops reasoning', async () => {
    const thought = { id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Yes' }] };
    const first = await saveChat(models, 'shop', { id: 'chat-one-1', messages: [user('u', 'First chat'), thought] });
    expect(first.messages[1]).toEqual({ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Yes' }] });
    await new Promise((r) => setTimeout(r, 5));
    await saveChat(models, 'shop', { id: 'chat-two-2', messages: [user('v', 'Second chat')] });
    expect((await listChats(models, 'shop')).map((c) => [c.title, c.messageCount])).toEqual([
      ['Second chat', 1],
      ['First chat', 2],
    ]);
    // Saving again keeps the created date and moves the chat to the top.
    await new Promise((r) => setTimeout(r, 5));
    const again = await saveChat(models, 'shop', { id: 'chat-one-1', messages: [...first.messages, user('w', 'More')] });
    expect(again.createdAt).toBe(first.createdAt);
    expect((await listChats(models, 'shop'))[0]).toMatchObject({ id: 'chat-one-1', messageCount: 3 });
    // A lost index is rebuilt from the chat files.
    await fs.rm(path.join(models, '.chat', 'shop', '_chats', 'index.json'));
    expect((await listChats(models, 'shop')).map((c) => c.id)).toEqual(['chat-one-1', 'chat-two-2']);
    expect(await getChat(models, 'shop', 'chat-ghost-0')).toBeNull();
    await expect(getChat(models, 'shop', '../../x')).rejects.toThrow(/invalid chat id/);
  });

  it('turns each old per-branch conversation into a chat of its own, once', async () => {
    const dir = path.join(models, '.chat', 'old');
    const old = {
      messages: [user('1', 'Old question'), { id: '2', role: 'assistant', parts: [{ type: 'reasoning', text: 'x'.repeat(1000) }, { type: 'text', text: 'Old answer' }] }],
      sessionId: 'sess-1',
      updatedAt: '2026-10-30T10:00:00.000Z',
    };
    await fs.mkdir(path.join(dir, 'main'), { recursive: true });
    await fs.mkdir(path.join(dir, 'idea'), { recursive: true });
    await fs.writeFile(path.join(dir, 'main', 'conversation.json'), JSON.stringify(old));
    await fs.writeFile(path.join(dir, 'idea', 'conversation.json'), JSON.stringify({ messages: [] }));
    await fs.writeFile(path.join(dir, 'main', 'runs.jsonl'), '');

    const list = await listChats(models, 'old');
    expect(list).toEqual([{ id: expect.any(String), title: 'Old question', createdAt: old.updatedAt, updatedAt: old.updatedAt, messageCount: 2 }]);
    const chat = await getChat(models, 'old', list[0]!.id);
    expect(texts(chat!.messages)).toEqual(['user: Old question', 'assistant: Old answer']);
    expect(chat!.sessionId).toBe('sess-1');
    expect((await fs.readdir(path.join(dir, 'main'))).sort()).toEqual(['conversation.migrated.json', 'runs.jsonl']);
    expect(await fs.readdir(path.join(dir, 'idea'))).toEqual(['conversation.migrated.json']);
    expect(await listChats(models, 'old')).toHaveLength(1);
  });
});

describe('chat route', () => {
  const post = (body: unknown) => studio.app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ask = async (chatId: string, message: unknown, branch = 'main') => {
    const res = await post({ model: 'shop', branch, chatId, message, provider: 'openrouter', modelId: 'test/model' });
    expect(res.status).toBe(200);
    return res.text();
  };

  it('rejects bad requests with JSON errors', async () => {
    const ok = { model: 'shop', branch: 'main', chatId: 'chat-bad-1', message: user('1', 'hi'), provider: 'openrouter' };
    expect((await post({})).status).toBe(400);
    expect((await post({ ...ok, message: { id: '1', role: 'assistant', parts: [] } })).status).toBe(400);
    expect((await post({ ...ok, chatId: '../x' })).status).toBe(400);
    expect((await post({ ...ok, model: 'ghost' })).status).toBe(404);
    expect((await post({ ...ok, provider: 'bogus' })).status).toBe(400);
  });

  it('holds the chat: the browser sends one prompt, the model gets the history without reasoning', async () => {
    const id = 'chat-route-1';
    const stream = await ask(id, user('u1', 'What is in the model?'));
    expect(stream).toContain('Answer 1');
    expect(stream).not.toContain('chain of thought');
    const one = await until(async () => {
      const c = await getChat(models, 'shop', id);
      return c && c.messages.length === 2 && c;
    });
    const answer = one.messages[1] as { parts: { type: string }[]; metadata?: Record<string, unknown> };
    expect(answer.parts.some((p) => p.type === 'reasoning')).toBe(false);
    expect(answer.metadata).toMatchObject({ provider: 'openrouter', modelId: 'test/model', branch: 'main', runId: expect.any(String) });

    // The next prompt, sent alone and on another branch, reaches the model with the chat before it.
    await studio.ctx.service.createBranch('shop', { name: 'idea' });
    await ask(id, user('u2', 'And now?'), 'idea');
    const prompt = JSON.stringify(llm.doStreamCalls.at(-1)!.prompt);
    expect(prompt).toContain('What is in the model?');
    expect(prompt).toContain('Answer 1');
    expect(prompt).toContain('And now?');
    expect(prompt).not.toContain('chain of thought');
    await until(async () => (await getChat(models, 'shop', id))!.messages.length === 4);

    // Sent again (Retry), a prompt replaces itself and the answer after it.
    await ask(id, user('u2', 'And now?'), 'idea');
    const retried = await until(async () => {
      const c = await getChat(models, 'shop', id);
      return c && texts(c.messages).at(-1) === 'assistant: Answer 3' && c;
    });
    expect(texts(retried.messages)).toEqual(['user: What is in the model?', 'assistant: Answer 1', 'user: And now?', 'assistant: Answer 3']);
    expect((await (await studio.app.request('/api/chat/chats/shop')).json())[0]).toMatchObject({ id, title: 'What is in the model?', messageCount: 4 });

    // Runs record the chat and the branch they ran on.
    const runs = await until(async () => {
      const r = (await (await studio.app.request('/api/chat/runs/shop/idea')).json()) as { chatId?: string }[];
      return r.length === 2 && r;
    });
    expect(runs.every((r) => r.chatId === id)).toBe(true);
    expect((await studio.app.request('/api/chat/chats/shop/chat-none-0')).status).toBe(404);
  });
});
