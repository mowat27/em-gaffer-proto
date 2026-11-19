import type {
  Adr,
  AdrInput,
  BranchInfo,
  BranchState,
  EditOp,
  EditResult,
  ModelSummary,
  ParseError,
  Ref,
  StudioConfig,
  ValidationResult,
  Version,
  VersionSource,
  ViewLayout,
} from '../shared/types.ts';
import { AdrError, createAdr, deleteAdr, getAdr, listAdrs, updateAdr } from '../core/adrs.ts';
import { applyEdits, parseWorkspace } from '../core/dsl/index.ts';
import { atomicWrite, readText } from '../core/fsutil.ts';
import { validateViewLayout } from '../core/layout.ts';
import { Store, StoreError } from '../core/store.ts';
import { validateWorkspace } from '../core/validate.ts';
import type { JobManager } from '../core/jobs.ts';
import type { EventHub } from './events.ts';
import type { StateManager } from './state.ts';

/** Error with an HTTP status and optional parse error, mapped to `{ error, parseError? }` by the app. */
export class HttpError extends Error {
  status: 400 | 404 | 409 | 500;
  parseError?: ParseError;
  constructor(message: string, status: 400 | 404 | 409 | 500 = 400, parseError?: ParseError) {
    super(message);
    this.status = status;
    this.parseError = parseError;
  }
}

/** Everything the routes and chat tools share. */
export interface StudioContext {
  projectRoot: string;
  modelsDir: string;
  skillDir: string;
  appDir: string;
  config: StudioConfig;
  store: Store;
  hub: EventHub;
  state: StateManager;
  jobs: JobManager;
  service: Service;
  version: string;
}

export interface WriteOptions {
  source?: VersionSource;
  message?: string;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function describeOps(ops: EditOp[]): string {
  const parts = ops.map((o) => {
    switch (o.op) {
      case 'addElement':
        return `Add ${o.kind} "${o.name}"`;
      case 'setElement':
        return `Edit ${o.id}`;
      case 'removeElement':
        return `Remove ${o.id}`;
      case 'addRelationship':
        return `Add relationship ${o.source} -> ${o.destination}`;
      case 'setRelationship':
        return `Edit relationship ${o.id}`;
      case 'removeRelationship':
        return `Remove relationship ${o.id}`;
      case 'addView':
        return `Add view ${o.key}`;
      case 'removeView':
        return `Remove view ${o.key}`;
    }
  });
  return clip(parts.join('; ') || 'Edit', 120);
}

export class Service {
  readonly #store: Store;
  readonly #state: StateManager;
  readonly #hub: EventHub;

  constructor(store: Store, state: StateManager, hub: EventHub) {
    this.#store = store;
    this.#state = state;
    this.#hub = hub;
  }

  // ---- models ------------------------------------------------------------

  async createModel(input: { name: string; description?: string }): Promise<ModelSummary> {
    const m = await this.#store.createModel(input);
    this.#hub.broadcast({ type: 'models' });
    return m;
  }

  /** Check DSL text parses; throws HttpError(400) with the parse error otherwise. */
  checkParses(dsl: string): { name: string; warnings: string[] } {
    let res;
    try {
      res = parseWorkspace(dsl);
    } catch (err) {
      throw new HttpError(`parser failed: ${(err as Error).message}`, 500);
    }
    if (!res.ok) throw new HttpError(`DSL does not parse: line ${res.error.line}: ${res.error.message}`, 400, res.error);
    return { name: res.workspace.name, warnings: res.workspace.warnings.map((w) => (w.line ? `line ${w.line}: ${w.message}` : w.message)) };
  }

  async importModel(input: { name: string; description?: string; dsl: string; sourceLabel: string }): Promise<ModelSummary> {
    const m = await this.#store.importModel(input);
    this.#hub.broadcast({ type: 'models' });
    return m;
  }

  async deleteModel(slug: string): Promise<void> {
    await this.#store.deleteModel(slug);
    this.#state.removeModel(slug);
    this.#hub.broadcast({ type: 'models' });
  }

  async createBranch(model: string, input: { name: string; from?: Ref }): Promise<BranchInfo> {
    const info = await this.#store.createBranch(model, input);
    await this.#state.refresh(model, info.name);
    this.#hub.broadcast({ type: 'models' });
    return info;
  }

  async deleteBranch(model: string, branch: string): Promise<void> {
    await this.#store.deleteBranch(model, branch);
    this.#state.remove(model, branch);
    this.#hub.broadcast({ type: 'models' });
  }

  // ---- branch content ----------------------------------------------------

  async branchState(model: string, branch: string): Promise<BranchState> {
    await this.#store.requireBranch(model, branch);
    return this.#state.get(model, branch);
  }

  async setDsl(model: string, branch: string, dsl: string, opts: WriteOptions = {}): Promise<BranchState> {
    if (typeof dsl !== 'string') throw new HttpError('dsl must be a string', 400);
    this.checkParses(dsl);
    await this.#store.writeDsl(model, branch, dsl, { source: opts.source ?? 'ui', message: opts.message || 'Edited DSL' });
    return (await this.#state.refresh(model, branch)).state;
  }

  async edit(model: string, branch: string, ops: EditOp[], opts: WriteOptions = {}): Promise<{ state: BranchState; created: string[]; version: Version | null }> {
    if (!Array.isArray(ops) || ops.length === 0) throw new HttpError('ops must be a non-empty array', 400);
    const { result, version } = await this.#store.mutate(
      model,
      branch,
      { source: opts.source ?? 'ui', message: opts.message || describeOps(ops) },
      async (p): Promise<EditResult> => {
        const dsl = (await readText(p.workspace)) ?? '';
        const r = applyEdits(dsl, ops);
        if (r.ok) await atomicWrite(p.workspace, r.dsl);
        return r;
      },
    );
    if (!result.ok) throw new HttpError(result.error, 400, result.parseError);
    const { state } = await this.#state.refresh(model, branch);
    return { state, created: result.created, version };
  }

  async setLayout(model: string, branch: string, viewKey: string, layout: ViewLayout): Promise<void> {
    if (!validateViewLayout(layout)) throw new HttpError('invalid ViewLayout: expected { elements: { id: { x, y } } }', 400);
    await this.#store.setViewLayout(model, branch, viewKey, layout);
    await this.#state.refresh(model, branch);
  }

  async deleteLayout(model: string, branch: string, viewKey: string): Promise<void> {
    await this.#store.removeViewLayout(model, branch, viewKey);
    await this.#state.refresh(model, branch);
  }

  async rollback(model: string, branch: string, version: string): Promise<BranchState> {
    if (typeof version !== 'string' || !version) throw new HttpError('version is required', 400);
    await this.#store.rollback(model, branch, version);
    return (await this.#state.refresh(model, branch, { force: true })).state;
  }

  async snapshot(model: string, branch: string, message: string, source: VersionSource = 'cli'): Promise<Version | null> {
    const v = await this.#store.snapshot(model, branch, { source, message: message || 'Snapshot' });
    if (v) await this.#state.refresh(model, branch, { force: true });
    return v;
  }

  async validate(model: string, branch: string): Promise<ValidationResult> {
    await this.#store.requireBranch(model, branch);
    const result = await validateWorkspace(this.#store.branchPaths(model, branch).workspace);
    this.#state.setValidation(model, branch, result);
    return result;
  }

  // ---- ADRs --------------------------------------------------------------

  async listAdrs(model: string, branch: string): Promise<Adr[]> {
    await this.#store.requireBranch(model, branch);
    return listAdrs(this.#store.branchPaths(model, branch).adrs);
  }

  async getAdr(model: string, branch: string, id: string): Promise<Adr> {
    await this.#store.requireBranch(model, branch);
    return getAdr(this.#store.branchPaths(model, branch).adrs, id);
  }

  async createAdr(model: string, branch: string, input: AdrInput, opts: WriteOptions = {}): Promise<Adr> {
    const { result } = await this.#store.mutate(model, branch, { source: opts.source ?? 'ui', message: opts.message || `Add ADR: ${clip(String(input?.title ?? ''), 80)}` }, (p) => createAdr(p.adrs, input));
    await this.#state.refresh(model, branch);
    return result;
  }

  async updateAdr(model: string, branch: string, id: string, input: AdrInput, opts: WriteOptions = {}): Promise<Adr> {
    const { result } = await this.#store.mutate(model, branch, { source: opts.source ?? 'ui', message: opts.message || `Update ADR ${id}` }, (p) => updateAdr(p.adrs, id, input));
    await this.#state.refresh(model, branch);
    return result;
  }

  async deleteAdr(model: string, branch: string, id: string, opts: WriteOptions = {}): Promise<void> {
    await this.#store.mutate(model, branch, { source: opts.source ?? 'ui', message: opts.message || `Delete ADR ${id}` }, (p) => deleteAdr(p.adrs, id));
    await this.#state.refresh(model, branch);
  }
}

/** Map any known error to an HTTP status and body. */
export function errorResponse(err: unknown): { status: 400 | 404 | 409 | 500; body: { error: string; parseError?: ParseError } } {
  if (err instanceof HttpError) {
    return { status: err.status, body: err.parseError ? { error: err.message, parseError: err.parseError } : { error: err.message } };
  }
  if (err instanceof StoreError || err instanceof AdrError) return { status: err.status, body: { error: err.message } };
  const st = (err as { status?: unknown })?.status;
  if ((st === 400 || st === 404 || st === 409) && err instanceof Error) return { status: st, body: { error: err.message } };
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}
