import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { sha256 } from '../core/hash.ts';
import { TMP_SUFFIX } from '../core/fsutil.ts';
import { StoreError, type Store } from '../core/store.ts';
import { JOB_LOCK, jobLockActive } from '../core/joblock.ts';
import type { EventHub } from './events.ts';
import type { StateManager } from './state.ts';

export interface WatcherOptions {
  modelsDir: string;
  store: Store;
  state: StateManager;
  hub: EventHub;
  /** Delay before a file edit is snapshotted (default 1500 ms) */
  snapshotDebounceMs?: number;
  /** Delay that coalesces bursts of file events before the branch is re-read (default 80 ms) */
  refreshDebounceMs?: number;
}

type Kind = 'dsl' | 'adr' | 'layout';

export class Watcher {
  readonly #o: WatcherOptions;
  #fs: FSWatcher | null = null;
  readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
  readonly #snapshotTimers = new Map<string, NodeJS.Timeout>();
  #modelsTimer: NodeJS.Timeout | null = null;
  #modelsHash = '';
  readonly #pendingKinds = new Map<string, Set<Kind>>();

  constructor(options: WatcherOptions) {
    this.#o = options;
  }

  async start(): Promise<void> {
    const { modelsDir } = this.#o;
    this.#modelsHash = await this.#modelsFingerprint();
    const w = watch(modelsDir, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = path.relative(modelsDir, p);
        if (!rel) return false;
        const parts = rel.split(path.sep);
        const base = parts[parts.length - 1]!;
        if (base.endsWith(TMP_SUFFIX) || base === '.DS_Store' || base === JOB_LOCK) return true;
        if (parts[0]!.startsWith('.')) return true; // .jobs
        if (parts[1] === 'history') return true;
        return false;
      },
    });
    this.#fs = w;
    w.on('all', (event, p) => this.#onEvent(String(event), String(p)));
    w.on('error', () => undefined);
    await new Promise<void>((resolve) => w.once('ready', () => resolve()));
  }

  async close(): Promise<void> {
    for (const t of [...this.#refreshTimers.values(), ...this.#snapshotTimers.values()]) clearTimeout(t);
    if (this.#modelsTimer) clearTimeout(this.#modelsTimer);
    this.#refreshTimers.clear();
    this.#snapshotTimers.clear();
    await this.#fs?.close();
    this.#fs = null;
  }

  async #modelsFingerprint(): Promise<string> {
    try {
      return sha256(JSON.stringify(await this.#o.store.listModels()));
    } catch {
      return '';
    }
  }

  #onEvent(event: string, p: string): void {
    const rel = path.relative(this.#o.modelsDir, p);
    const parts = rel.split(path.sep);
    const [slug, second, branch, file, adrFile] = parts;
    if (!slug) return;
    if (parts.length === 1 || (parts.length === 2 && (second === 'model.json' || second === 'lineage.json'))) {
      this.#scheduleModels();
      // lineage.json also carries every branch's head (a CLI snapshot or relabel changes it), so refresh the branches.
      if (second === 'lineage.json') void this.#refreshAllBranches(slug);
      return;
    }
    if (second !== 'branches' || !branch) return;
    if (parts.length === 3 && (event === 'unlinkDir' || event === 'addDir')) {
      this.#scheduleBranch(slug, branch, 'dsl');
      return;
    }
    let kind: Kind | null = null;
    if (parts.length === 4 && file === 'workspace.dsl') kind = 'dsl';
    else if (parts.length === 4 && file === 'layout.json') kind = 'layout';
    else if (parts.length === 5 && file === 'adrs' && adrFile?.endsWith('.md')) kind = 'adr';
    if (kind) this.#scheduleBranch(slug, branch, kind);
  }

  async #refreshAllBranches(model: string): Promise<void> {
    try {
      const lineage = await this.#o.store.getLineage(model);
      for (const branch of Object.keys(lineage.branches)) this.#scheduleBranch(model, branch, 'layout');
    } catch {
      // model deleted meanwhile
    }
  }

  #scheduleModels(): void {
    if (this.#modelsTimer) clearTimeout(this.#modelsTimer);
    this.#modelsTimer = setTimeout(async () => {
      this.#modelsTimer = null;
      const fp = await this.#modelsFingerprint();
      if (fp !== this.#modelsHash) {
        this.#modelsHash = fp;
        this.#o.hub.broadcast({ type: 'models' });
      }
    }, this.#o.refreshDebounceMs ?? 80);
  }

  #scheduleBranch(model: string, branch: string, kind: Kind): void {
    const key = `${model}/${branch}`;
    const kinds = this.#pendingKinds.get(key) ?? new Set<Kind>();
    kinds.add(kind);
    this.#pendingKinds.set(key, kinds);
    const prev = this.#refreshTimers.get(key);
    if (prev) clearTimeout(prev);
    this.#refreshTimers.set(
      key,
      setTimeout(() => {
        this.#refreshTimers.delete(key);
        const pending = this.#pendingKinds.get(key);
        this.#pendingKinds.delete(key);
        void this.#refresh(model, branch, pending ?? new Set([kind]));
      }, this.#o.refreshDebounceMs ?? 80),
    );
  }

  async #refresh(model: string, branch: string, kinds: Set<Kind>): Promise<void> {
    const { state } = this.#o;
    try {
      const { changed } = await state.refresh(model, branch);
      if (changed && (kinds.has('dsl') || kinds.has('adr'))) this.#scheduleSnapshot(model, branch);
    } catch (err) {
      if (err instanceof StoreError && err.status === 404) {
        if (state.has(model, branch)) state.remove(model, branch);
      }
    }
  }

  #scheduleSnapshot(model: string, branch: string): void {
    const key = `${model}/${branch}`;
    const prev = this.#snapshotTimers.get(key);
    if (prev) clearTimeout(prev);
    this.#snapshotTimers.set(
      key,
      setTimeout(async () => {
        this.#snapshotTimers.delete(key);
        // A running job (in this process or a CLI process holding the lock file) takes its own snapshot when it finishes.
        if (this.#o.state.isBusy(model, branch) || jobLockActive(this.#o.store.branchPaths(model, branch).dir)) return;
        try {
          const v = await this.#o.store.snapshot(model, branch, { source: 'file', message: 'Edited in file' });
          if (v) await this.#o.state.refresh(model, branch, { force: true });
        } catch {
          // branch deleted meanwhile
        }
      }, this.#o.snapshotDebounceMs ?? 1500),
    );
  }
}
