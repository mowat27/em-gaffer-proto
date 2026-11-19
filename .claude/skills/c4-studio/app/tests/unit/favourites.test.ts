import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, saveFavourites } from '../../src/core/config.ts';

describe('chat model favourites', () => {
  it('saves per provider, keeps other config keys, and loads back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fav-'));
    fs.mkdirSync(path.join(root, 'c4-studio'));
    const file = path.join(root, 'c4-studio', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ port: 5000, custom: { keep: true }, chat: { provider: 'fireworks' } }));
    saveFavourites(root, 'openrouter', ['a/b', 'c/d', 'a/b']);
    saveFavourites(root, 'fireworks', ['x']);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.custom).toEqual({ keep: true });
    expect(raw.port).toBe(5000);
    expect(raw.chat.provider).toBe('fireworks');
    const cfg = loadConfig(root);
    expect(cfg.chat.favourites).toEqual({ openrouter: ['a/b', 'c/d'], fireworks: ['x'] });
  });

  it('creates the config file when missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fav-'));
    saveFavourites(root, 'anthropic', ['claude-sonnet-5-5']);
    expect(loadConfig(root).chat.favourites).toEqual({ anthropic: ['claude-sonnet-5-5'] });
  });
});

describe('chat selection', () => {
  it('saves the provider and its model as defaults, alongside favourites', async () => {
    const { saveChatSelection } = await import('../../src/core/config.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-sel-'));
    saveFavourites(root, 'openrouter', ['a/b']);
    saveChatSelection(root, 'openrouter', 'google/gemini-3.8-flash');
    saveChatSelection(root, 'fireworks', 'accounts/fireworks/models/kimi-k3');
    const cfg = loadConfig(root);
    expect(cfg.chat.provider).toBe('fireworks');
    expect(cfg.chat.models.openrouter).toBe('google/gemini-3.8-flash');
    expect(cfg.chat.models.fireworks).toBe('accounts/fireworks/models/kimi-k3');
    expect(cfg.chat.favourites).toEqual({ openrouter: ['a/b'] });
  });
});
