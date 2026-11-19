import type { Adr, BranchState, Layout, ParseError, ValidationResult, Version, Workspace } from '../shared/types.ts';
import { listAdrs, toSummary } from '../core/adrs.ts';
import { parseWorkspace } from '../core/dsl/index.ts';
import { sha256 } from '../core/hash.ts';
import { StoreError, type Store } from '../core/store.ts';
import type { EventHub } from './events.ts';

interface Entry {
  state: BranchState;
  /** hash over dsl + layout + adrs + head, used to skip no-op refreshes */
  fingerprint: string;
}

function key(model: string, branch: string): string {
  return `${model}/${branch}`;
}

export function safeParse(dsl: string): { workspace: Workspace | null; parseError: ParseError | null; parseMs: number } {
  try {
    const res = parseWorkspace(dsl);
    if (res.ok) return { workspace: res.workspace, parseError: null, parseMs: res.parseMs };
    return { workspace: null, parseError: res.error, parseMs: res.parseMs };
  } catch (err) {
    return { workspace: null, parseError: { line: 0, message: (err as Error).message }, parseMs: 0 };
  }
}

/** Cache of BranchState per model/branch plus busy flags and last validation. */
export class StateManager {
  readonly #store: Store;
  readonly #hub: EventHub;
  readonly #entries = new Map<string, Entry>();
  readonly #busy = new Map<string, { jobId: string; label: string }>();
  readonly #validation = new Map<string, ValidationResult>();
  #revision = 0;

  constructor(store: Store, hub: EventHub) {
    this.#store = store;
    this.#hub = hub;
  }

  get revision(): number {
    return this.#revision;
  }

  async #build(model: string, branch: string): Promise<Entry> {
    const { dsl, layout, paths } = await this.#store.readBranch(model, branch);
    const adrs: Adr[] = await listAdrs(paths.adrs);
    const head: Version | null = await this.#store.headVersion(model, branch);
    const fingerprint = sha256(JSON.stringify([dsl, layout, adrs.map((a) => [a.file, a.status, a.title, a.date, a.elements, a.supersedes, a.supersededBy]), head?.id ?? null]));
    const prev = this.#entries.get(key(model, branch));
    const parsed =
      prev && prev.state.dsl === dsl
        ? { workspace: prev.state.workspace, parseError: prev.state.parseError, parseMs: prev.state.parseMs }
        : safeParse(dsl);
    const state: BranchState = {
      model,
      branch,
      dsl,
      workspace: parsed.workspace,
      parseError: parsed.parseError,
      parseMs: parsed.parseMs,
      layout: layout as Layout,
      adrs: adrs.map(toSummary),
      head,
      revision: prev?.state.revision ?? 0,
      validation: this.#validation.get(key(model, branch)) ?? null,
      busy: this.#busy.get(key(model, branch)) ?? null,
    };
    return { state, fingerprint };
  }

  /** Current state (cached; built on first use). */
  async get(model: string, branch: string): Promise<BranchState> {
    const cached = this.#entries.get(key(model, branch));
    if (cached) return cached.state;
    const entry = await this.#build(model, branch);
    entry.state.revision = ++this.#revision;
    this.#entries.set(key(model, branch), entry);
    return entry.state;
  }

  /**
   * Re-read the branch from disk. When anything changed (or `force`), bump the revision and broadcast `branch`.
   * Returns the new state and whether it changed.
   */
  async refresh(model: string, branch: string, opts: { force?: boolean } = {}): Promise<{ state: BranchState; changed: boolean }> {
    const prev = this.#entries.get(key(model, branch));
    const entry = await this.#build(model, branch);
    const changed = !prev || prev.fingerprint !== entry.fingerprint || !!opts.force;
    if (!changed && prev) {
      prev.state.busy = entry.state.busy;
      return { state: prev.state, changed: false };
    }
    entry.state.revision = ++this.#revision;
    this.#entries.set(key(model, branch), entry);
    this.#hub.broadcast({ type: 'branch', model, branch, state: entry.state });
    return { state: entry.state, changed: true };
  }

  /** Drop a branch from the cache (branch deleted) and tell clients. */
  remove(model: string, branch: string): void {
    this.#entries.delete(key(model, branch));
    this.#validation.delete(key(model, branch));
    this.#busy.delete(key(model, branch));
    this.#hub.broadcast({ type: 'branch-removed', model, branch });
  }

  removeModel(model: string): void {
    for (const k of [...this.#entries.keys()]) if (k.startsWith(`${model}/`)) this.#entries.delete(k);
    for (const k of [...this.#validation.keys()]) if (k.startsWith(`${model}/`)) this.#validation.delete(k);
    for (const k of [...this.#busy.keys()]) if (k.startsWith(`${model}/`)) this.#busy.delete(k);
  }

  has(model: string, branch: string): boolean {
    return this.#entries.has(key(model, branch));
  }

  isBusy(model: string, branch: string): boolean {
    return this.#busy.has(key(model, branch));
  }

  async setBusy(model: string, branch: string, busy: { jobId: string; label: string } | null): Promise<void> {
    if (busy) this.#busy.set(key(model, branch), busy);
    else this.#busy.delete(key(model, branch));
    try {
      await this.refresh(model, branch, { force: true });
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
    }
  }

  setValidation(model: string, branch: string, result: ValidationResult): void {
    this.#validation.set(key(model, branch), result);
    const entry = this.#entries.get(key(model, branch));
    if (entry) {
      entry.state = { ...entry.state, validation: result };
    }
    this.#hub.broadcast({ type: 'validation', model, branch, result });
  }
}
