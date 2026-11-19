import fs from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from '../shared/types.ts';

export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Agent',
  'Skill',
  'Bash(bash:*)',
  'Bash(sh:*)',
  'Bash(docker:*)',
  'Bash(structurizr:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(git:*)',
  'Bash(mkdir:*)',
  'Bash(node:*)',
  'Bash(npx:*)',
];

export const DEFAULT_CHAT_MODELS = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  fireworks: 'accounts/fireworks/models/kimi-k3',
  anthropic: 'claude-sonnet-5-5',
  'claude-code': 'opus',
} as const;

export function defaultConfig(): StudioConfig {
  return {
    port: 47145,
    chat: { provider: 'openrouter', models: { ...DEFAULT_CHAT_MODELS } },
    claude: {
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      args: [],
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge a user config over the defaults (objects deep, arrays and scalars replaced). */
export function mergeConfig(base: StudioConfig, user: unknown): StudioConfig {
  if (!isObject(user)) return base;
  const out = structuredClone(base);
  if (typeof user.port === 'number' && Number.isInteger(user.port) && user.port >= 0 && user.port < 65536) out.port = user.port;
  if (isObject(user.chat)) {
    if (typeof user.chat.provider === 'string') out.chat.provider = user.chat.provider as StudioConfig['chat']['provider'];
    if (isObject(user.chat.models)) {
      for (const [k, v] of Object.entries(user.chat.models)) {
        if (typeof v === 'string' && v) (out.chat.models as Record<string, string>)[k] = v;
      }
    }
    if (isObject(user.chat.favourites)) {
      const fav: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(user.chat.favourites)) {
        if (Array.isArray(v)) fav[k] = v.filter((x): x is string => typeof x === 'string' && x !== '');
      }
      out.chat.favourites = fav;
    }
  }
  if (isObject(user.claude)) {
    const c = user.claude;
    if (typeof c.model === 'string' && c.model) out.claude.model = c.model;
    if (typeof c.effort === 'string') out.claude.effort = c.effort as StudioConfig['claude']['effort'];
    if (typeof c.permissionMode === 'string' && c.permissionMode) out.claude.permissionMode = c.permissionMode;
    if (Array.isArray(c.allowedTools)) out.claude.allowedTools = c.allowedTools.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(c.args)) out.claude.args = c.args.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

export function loadConfig(projectRoot: string): StudioConfig {
  const file = path.join(projectRoot, 'c4-studio', 'config.json');
  let user: unknown;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`c4-studio: ignoring unreadable ${file}: ${(err as Error).message}`);
    }
  }
  return mergeConfig(defaultConfig(), user);
}

/**
 * Change <projectRoot>/c4-studio/config.json's `chat` section in place, keeping every other key
 * (including unknown ones) as the user wrote it. Creates the file when missing.
 */
function updateChatConfig(projectRoot: string, change: (chat: Record<string, unknown>) => void): void {
  const file = path.join(projectRoot, 'c4-studio', 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(parsed)) raw = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`cannot update ${file}: ${(err as Error).message}`);
  }
  const chat = isObject(raw.chat) ? raw.chat : {};
  change(chat);
  raw.chat = chat;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Set one provider's favourite models. */
export function saveFavourites(projectRoot: string, provider: string, models: string[]): void {
  updateChatConfig(projectRoot, (chat) => {
    const favourites = isObject(chat.favourites) ? chat.favourites : {};
    favourites[provider] = [...new Set(models.filter((m) => typeof m === 'string' && m))];
    chat.favourites = favourites;
  });
}

/** Remember the chat provider and its model as the defaults the chat panel opens with. */
export function saveChatSelection(projectRoot: string, provider: string, model: string): void {
  updateChatConfig(projectRoot, (chat) => {
    chat.provider = provider;
    const models = isObject(chat.models) ? chat.models : {};
    models[provider] = model;
    chat.models = models;
  });
}
