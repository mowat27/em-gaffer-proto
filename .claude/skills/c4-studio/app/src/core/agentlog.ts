// Chats and agent run history under <modelsDir>/.chat/<model>/. The watcher ignores dot-directories
// at the top of the models directory, so writes here never look like model edits.
//
//   _chats/<id>.json     one file per chat, kept for the model rather than a branch
//   _chats/index.json    the chat list: title, dates and message count, so listing reads no chat
//   <branch>/runs.jsonl  agent history, one finished run per line
//
// Branch names start with a letter or digit, so `_chats` can never be a branch's folder.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRun, AgentRunSummary, Chat, ChatSummary } from '../shared/types.ts';
import { atomicWrite, readJson } from './fsutil.ts';
import { isValidName } from './store.ts';

export class AgentLogError extends Error {
  status = 400 as const;
}

const CHAT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidChatId = (id: unknown): id is string => typeof id === 'string' && CHAT_ID_RE.test(id);

function modelDir(modelsDir: string, model: string): string {
  if (!isValidName(model)) throw new AgentLogError(`invalid model: ${model}`);
  return path.join(modelsDir, '.chat', model);
}

function dirFor(modelsDir: string, model: string, branch: string): string {
  if (!isValidName(branch)) throw new AgentLogError(`invalid branch: ${branch}`);
  return path.join(modelDir(modelsDir, model), branch);
}

const chatsDir = (modelsDir: string, model: string) => path.join(modelDir(modelsDir, model), '_chats');

function chatFile(modelsDir: string, model: string, id: string): string {
  if (!isValidChatId(id)) throw new AgentLogError(`invalid chat id: ${id}`);
  return path.join(chatsDir(modelsDir, model), `${id}.json`);
}

// Chat files and their index are read, changed and written back, so writes for one model take turns.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

interface Part {
  type?: string;
  text?: string;
}
interface Msg {
  id?: string;
  role?: string;
  parts?: Part[];
}

/**
 * Reasoning is dropped from saved chats: the chat never shows it, the Agent history keeps it with
 * each step, and sent back with every later prompt it was most of the tokens.
 */
export function withoutReasoning(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const msg = m as Msg;
    if (msg?.role !== 'assistant' || !Array.isArray(msg.parts) || !msg.parts.some((p) => p?.type === 'reasoning')) return m;
    return { ...msg, parts: msg.parts.filter((p) => p?.type !== 'reasoning') };
  });
}

/** The first line of the first prompt. */
export function chatTitle(messages: unknown[]): string {
  const first = (messages as Msg[]).find((m) => m?.role === 'user');
  const text = (first?.parts ?? [])
    .filter((p) => p?.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? '';
  if (!line) return 'New chat';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const summary = (c: Chat): ChatSummary => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length });
const newest = (a: ChatSummary, b: ChatSummary) => b.updatedAt.localeCompare(a.updatedAt);

async function readChat(modelsDir: string, model: string, id: string): Promise<Chat | null> {
  const c = await readJson<Chat>(chatFile(modelsDir, model, id));
  return c && Array.isArray(c.messages) ? c : null;
}

async function readIndex(modelsDir: string, model: string): Promise<ChatSummary[]> {
  const dir = chatsDir(modelsDir, model);
  const index = await readJson<ChatSummary[]>(path.join(dir, 'index.json')).catch(() => null);
  if (Array.isArray(index)) return index;
  // No index, or a broken one: rebuild it from the chat files.
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ChatSummary[] = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!isValidChatId(id)) continue;
    const c = await readChat(modelsDir, model, id).catch(() => null);
    if (c) out.push(summary(c));
  }
  return out;
}

async function writeChat(modelsDir: string, model: string, input: { id: string; messages: unknown[]; sessionId?: string; createdAt?: string; updatedAt?: string }): Promise<Chat> {
  const prev = await readChat(modelsDir, model, input.id).catch(() => null);
  const now = new Date().toISOString();
  const messages = withoutReasoning(input.messages);
  const sessionId = input.sessionId ?? prev?.sessionId;
  const chat: Chat = {
    id: input.id,
    title: chatTitle(messages),
    createdAt: prev?.createdAt ?? input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...(sessionId ? { sessionId } : {}),
    messages,
  };
  await atomicWrite(chatFile(modelsDir, model, chat.id), `${JSON.stringify(chat)}\n`);
  const index = (await readIndex(modelsDir, model)).filter((s) => s.id !== chat.id);
  index.push(summary(chat));
  await atomicWrite(path.join(chatsDir(modelsDir, model), 'index.json'), `${JSON.stringify(index.sort(newest), null, 1)}\n`);
  return chat;
}

// Chats used to be one conversation.json per branch, overwritten by "New chat". Each one becomes a
// chat of its own; the old file is renamed, not deleted, and so is never migrated twice.
const migrated = new Map<string, Promise<void>>();
function migrate(modelsDir: string, model: string): Promise<void> {
  const base = modelDir(modelsDir, model);
  let done = migrated.get(base);
  if (!done) {
    done = serial(base, async () => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(base, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        if (!e.isDirectory() || !isValidName(e.name)) continue;
        const file = path.join(base, e.name, 'conversation.json');
        const old = await readJson<{ messages?: unknown; sessionId?: unknown; updatedAt?: unknown }>(file).catch(() => null);
        if (!old) continue;
        if (Array.isArray(old.messages) && old.messages.length) {
          const at = typeof old.updatedAt === 'string' ? old.updatedAt : (await fs.stat(file)).mtime.toISOString();
          await writeChat(modelsDir, model, {
            id: randomBytes(12).toString('base64url'),
            messages: old.messages,
            sessionId: typeof old.sessionId === 'string' ? old.sessionId : undefined,
            createdAt: at,
            updatedAt: at,
          });
        }
        await fs.rename(file, path.join(base, e.name, 'conversation.migrated.json'));
      }
    });
    done.catch(() => migrated.delete(base));
    migrated.set(base, done);
  }
  return done;
}

/** Newest first. */
export async function listChats(modelsDir: string, model: string): Promise<ChatSummary[]> {
  await migrate(modelsDir, model);
  return (await readIndex(modelsDir, model)).sort(newest);
}

export async function getChat(modelsDir: string, model: string, id: string): Promise<Chat | null> {
  await migrate(modelsDir, model);
  return readChat(modelsDir, model, id);
}

/** Create or replace a chat's messages; its title, created date and session are kept or derived. */
export async function saveChat(modelsDir: string, model: string, input: { id: string; messages: unknown[]; sessionId?: string }): Promise<Chat> {
  await migrate(modelsDir, model);
  return serial(modelDir(modelsDir, model), () => writeChat(modelsDir, model, input));
}

/** Append a finished run to runs.jsonl (one JSON object per line, oldest first). */
export async function appendRun(modelsDir: string, run: AgentRun): Promise<void> {
  const dir = dirFor(modelsDir, run.model, run.branch);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'runs.jsonl'), `${JSON.stringify(run)}\n`);
}

async function readRuns(modelsDir: string, model: string, branch: string): Promise<AgentRun[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dirFor(modelsDir, model, branch), 'runs.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: AgentRun[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AgentRun);
    } catch {
      // a torn last line from a crash; skip it
    }
  }
  return out;
}

export function summarise(run: AgentRun): AgentRunSummary {
  return {
    id: run.id,
    model: run.model,
    branch: run.branch,
    ...(run.chatId ? { chatId: run.chatId } : {}),
    provider: run.provider,
    modelId: run.modelId,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    status: run.status,
    prompt: run.prompt.slice(0, 300),
    usage: run.usage,
    cost: run.cost,
    steps: run.steps.length,
    toolCalls: run.steps.reduce((n, s) => n + s.toolCalls.length, 0),
  };
}

/** Newest first. */
export async function listRuns(modelsDir: string, model: string, branch: string, limit = 500): Promise<AgentRunSummary[]> {
  const runs = await readRuns(modelsDir, model, branch);
  return runs.reverse().slice(0, limit).map(summarise);
}

export async function getRun(modelsDir: string, model: string, branch: string, id: string): Promise<AgentRun | null> {
  const runs = await readRuns(modelsDir, model, branch);
  return runs.find((r) => r.id === id) ?? null;
}
