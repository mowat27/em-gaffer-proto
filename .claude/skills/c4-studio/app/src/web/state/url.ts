import { useCallback, useSyncExternalStore } from 'react';

export type Page = 'diagram' | 'history' | 'compare' | 'adrs' | 'jobs' | 'agent';
export const PAGES: Page[] = ['diagram', 'history', 'compare', 'adrs', 'jobs', 'agent'];

export interface UrlState {
  model?: string;
  branch?: string;
  page: Page;
  view?: string;
  element?: string;
  /** Selected relationship id (extension to the documented params; edges are not elements). */
  rel?: string;
  left?: string;
  right?: string;
  job?: string;
  adr?: string;
  /** Agent run id on the agent page */
  run?: string;
}

const KEYS = ['model', 'branch', 'view', 'element', 'rel', 'left', 'right', 'job', 'adr', 'run'] as const;

export function parseUrl(search: string): UrlState {
  const p = new URLSearchParams(search);
  const page = p.get('page');
  const state: UrlState = { page: PAGES.includes(page as Page) ? (page as Page) : 'diagram' };
  for (const k of KEYS) {
    const v = p.get(k);
    if (v) state[k] = v;
  }
  return state;
}

export function serializeUrl(s: UrlState): string {
  const p = new URLSearchParams();
  for (const k of ['model', 'branch'] as const) if (s[k]) p.set(k, s[k]!);
  if (s.page !== 'diagram') p.set('page', s.page);
  for (const k of ['view', 'element', 'rel', 'left', 'right', 'job', 'adr', 'run'] as const) if (s[k]) p.set(k, s[k]!);
  const q = p.toString();
  return q ? `?${q}` : '?';
}

const listeners = new Set<() => void>();
let cachedSearch = '';
let cachedState: UrlState = parseUrl('');

function snapshot(): UrlState {
  if (location.search !== cachedSearch) {
    cachedSearch = location.search;
    cachedState = parseUrl(cachedSearch);
  }
  return cachedState;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', fn);
  };
}

export type UrlPatch = { [K in keyof UrlState]?: UrlState[K] | undefined };

/** Merge a patch into the current URL. `undefined` removes a key. pushState by default so back/forward works. */
export function navigateUrl(patch: UrlPatch, opts: { replace?: boolean } = {}): void {
  const next: UrlState = { ...snapshot(), ...patch } as UrlState;
  for (const k of KEYS) if (next[k] === undefined) delete next[k];
  const search = serializeUrl(next);
  if (search === (location.search || '?')) return;
  const url = `${location.pathname}${search === '?' ? '' : search}`;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  listeners.forEach((l) => l());
}

export function useUrlState(): [UrlState, typeof navigateUrl] {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const nav = useCallback(navigateUrl, []);
  return [state, nav];
}
