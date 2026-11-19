import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Adr,
  BranchInfo,
  Layout,
  Lineage,
  ModelDetail,
  ModelMeta,
  ModelSummary,
  Ref,
  Version,
  VersionSource,
  ViewLayout,
} from '../shared/types.ts';
import { listAdrs } from './adrs.ts';
import { atomicWrite, copyDir, exists, readJson, readText, TMP_SUFFIX, writeJson } from './fsutil.ts';
import { sha256 } from './hash.ts';
import { deleteView, emptyLayout, loadLayout, replaceView, saveLayout } from './layout.ts';
import { KeyedMutex } from './mutex.ts';

export class StoreError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidName(name: string): boolean {
  return typeof name === 'string' && name.length <= 64 && NAME_RE.test(name);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export function newVersionId(): string {
  const rand = Array.from(randomBytes(4), (b) => (b % 36).toString(36)).join('');
  return Date.now().toString(36) + rand;
}

function dslString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function camelIdentifier(name: string): string {
  const words = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'system';
  const id = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return /^[0-9]/.test(id) ? `s${id}` : id;
}

/** The c4-modeller workspace skeleton for an empty model: one software system and two views, so an empty model renders. */
export function skeletonDsl(name: string, description: string): string {
  const n = dslString(name) || 'System';
  const d = dslString(description) || `C4 model of ${n}.`;
  const id = camelIdentifier(name);
  return `workspace "${n}" "${d}" {

    !identifiers hierarchical

    properties {
        "structurizr.inspection.model.softwaresystem.documentation" "ignore"
        "structurizr.inspection.model.softwaresystem.decisions" "ignore"
        "structurizr.inspection.model.relationship[person->softwaresystem].technology" "ignore"
        "structurizr.inspection.model.relationship[person->container].technology" "ignore"
        "structurizr.inspection.model.relationship[person->component].technology" "ignore"
        "structurizr.inspection.model.relationship[component->component].technology" "ignore"
        "structurizr.inspection.model.relationship[softwaresystem->person].technology" "ignore"
        "structurizr.inspection.model.relationship[container->person].technology" "ignore"
        "structurizr.inspection.workspace.scope" "ignore"
    }

    model {
        ${id} = softwareSystem "${n}" "${d}"
    }

    views {
        systemContext ${id} "system-context" "The ${n} and the people and systems around it." {
            include *
        }

        container ${id} "containers" "The applications and data stores inside ${n}." {
            include *
        }
    }
}
`;
}

export interface BranchPaths {
  dir: string;
  workspace: string;
  layout: string;
  adrs: string;
}

export interface SnapshotOptions {
  source: VersionSource;
  message: string;
  /** Write a version even when nothing changed. */
  force?: boolean;
}

export interface VersionContent {
  version: Version;
  dsl: string;
  layout: Layout;
  adrs: Adr[];
}

export interface RefContent {
  ref: Ref;
  version: Version | null;
  dsl: string;
  layout: Layout;
  adrs: Adr[];
}

export class Store {
  readonly modelsDir: string;
  #locks = new KeyedMutex();

  constructor(modelsDir: string) {
    this.modelsDir = modelsDir;
  }

  // ---- paths -------------------------------------------------------------

  modelDir(slug: string): string {
    return path.join(this.modelsDir, slug);
  }

  branchPaths(slug: string, branch: string): BranchPaths {
    const dir = path.join(this.modelDir(slug), 'branches', branch);
    return { dir, workspace: path.join(dir, 'workspace.dsl'), layout: path.join(dir, 'layout.json'), adrs: path.join(dir, 'adrs') };
  }

  historyDir(slug: string, versionId: string): string {
    return path.join(this.modelDir(slug), 'history', versionId);
  }

  /** Run `fn` while holding the model's lock. */
  withLock<T>(slug: string, fn: () => Promise<T> | T): Promise<T> {
    return this.#locks.run(slug, fn);
  }

  // ---- reading -----------------------------------------------------------

  async hasModel(slug: string): Promise<boolean> {
    return isValidName(slug) && exists(path.join(this.modelDir(slug), 'model.json'));
  }

  async #meta(slug: string): Promise<ModelMeta> {
    if (!isValidName(slug)) throw new StoreError(`invalid model name: ${slug}`, 400);
    const meta = await readJson<ModelMeta>(path.join(this.modelDir(slug), 'model.json'));
    if (!meta) throw new StoreError(`model not found: ${slug}`, 404);
    return meta;
  }

  async getLineage(slug: string): Promise<Lineage> {
    if (!isValidName(slug)) throw new StoreError(`invalid model name: ${slug}`, 400);
    const lineage = await readJson<Lineage>(path.join(this.modelDir(slug), 'lineage.json'));
    if (!lineage) throw new StoreError(`model not found: ${slug}`, 404);
    return lineage;
  }

  async #saveLineage(slug: string, lineage: Lineage): Promise<void> {
    await writeJson(path.join(this.modelDir(slug), 'lineage.json'), lineage);
  }

  #summary(meta: ModelMeta, lineage: Lineage): ModelSummary {
    const last = lineage.versions[lineage.versions.length - 1];
    return {
      ...meta,
      defaultBranch: lineage.defaultBranch,
      branches: Object.keys(lineage.branches),
      versionCount: lineage.versions.length,
      updatedAt: last?.createdAt ?? meta.createdAt,
    };
  }

  async listModels(): Promise<ModelSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.modelsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: ModelSummary[] = [];
    for (const name of names) {
      if (!isValidName(name)) continue;
      try {
        out.push(await this.getSummary(name));
      } catch {
        // half-written or foreign directory
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSummary(slug: string): Promise<ModelSummary> {
    return this.#summary(await this.#meta(slug), await this.getLineage(slug));
  }

  async getModel(slug: string): Promise<ModelDetail> {
    const meta = await this.#meta(slug);
    const lineage = await this.getLineage(slug);
    return { ...this.#summary(meta, lineage), lineage };
  }

  async requireBranch(slug: string, branch: string): Promise<BranchInfo> {
    const lineage = await this.getLineage(slug);
    const info = lineage.branches[branch];
    if (!info) throw new StoreError(`branch not found: ${slug}/${branch}`, 404);
    return info;
  }

  async headVersion(slug: string, branch: string): Promise<Version | null> {
    const lineage = await this.getLineage(slug);
    const head = lineage.branches[branch]?.head;
    return head ? (lineage.versions.find((v) => v.id === head) ?? null) : null;
  }

  async readBranch(slug: string, branch: string): Promise<{ dsl: string; layout: Layout; paths: BranchPaths }> {
    await this.requireBranch(slug, branch);
    const paths = this.branchPaths(slug, branch);
    const dsl = (await readText(paths.workspace)) ?? '';
    return { dsl, layout: await loadLayout(paths.layout), paths };
  }

  async listVersions(slug: string, branch: string): Promise<Version[]> {
    const lineage = await this.getLineage(slug);
    return lineage.versions.filter((v) => v.branch === branch).reverse();
  }

  async getVersion(slug: string, versionId: string): Promise<VersionContent> {
    const lineage = await this.getLineage(slug);
    const version = lineage.versions.find((v) => v.id === versionId);
    if (!version) throw new StoreError(`version not found: ${versionId}`, 404);
    const dir = this.historyDir(slug, versionId);
    return {
      version,
      dsl: (await readText(path.join(dir, 'workspace.dsl'))) ?? '',
      layout: await loadLayout(path.join(dir, 'layout.json')),
      adrs: await listAdrs(path.join(dir, 'adrs')),
    };
  }

  /** Content of a ref: a branch head (working copy) or a version snapshot. */
  async readRef(slug: string, ref: Ref): Promise<RefContent> {
    if (ref.version) {
      const v = await this.getVersion(slug, ref.version);
      return { ref, version: v.version, dsl: v.dsl, layout: v.layout, adrs: v.adrs };
    }
    const { dsl, layout, paths } = await this.readBranch(slug, ref.branch);
    return { ref, version: await this.headVersion(slug, ref.branch), dsl, layout, adrs: await listAdrs(paths.adrs) };
  }

  // ---- hashing -----------------------------------------------------------

  /** Hash of the DSL and ADR content in a branch or history directory (layout excluded). */
  async contentHash(dir: string): Promise<string> {
    const dsl = (await readText(path.join(dir, 'workspace.dsl'))) ?? '';
    const parts = [sha256(dsl)];
    let names: string[] = [];
    try {
      names = (await fs.readdir(path.join(dir, 'adrs'))).filter((n) => n.endsWith('.md')).sort();
    } catch {
      // no adrs
    }
    for (const n of names) parts.push(n, sha256((await readText(path.join(dir, 'adrs', n))) ?? ''));
    return sha256(parts.join('\n'));
  }

  // ---- models ------------------------------------------------------------

  async createModel(input: { name: string; description?: string; slug?: string }): Promise<ModelSummary> {
    const name = (input.name ?? '').trim();
    if (!name) throw new StoreError('name is required', 400);
    const description = (input.description ?? '').trim();
    return this.#createWithDsl({ name, description, slug: input.slug, dsl: skeletonDsl(name, description), message: 'Model created' });
  }

  /** Import existing DSL text verbatim as the first version of a new model. */
  async importModel(input: { name: string; description?: string; dsl: string; sourceLabel: string; slug?: string }): Promise<ModelSummary> {
    const name = (input.name ?? '').trim();
    if (!name) throw new StoreError('name is required', 400);
    return this.#createWithDsl({
      name,
      description: (input.description ?? '').trim(),
      slug: input.slug,
      dsl: input.dsl,
      message: `Imported from ${input.sourceLabel}`,
    });
  }

  async #createWithDsl(input: { name: string; description: string; slug?: string; dsl: string; message: string }): Promise<ModelSummary> {
    const slug = input.slug ?? (slugify(input.name) || 'model');
    if (!isValidName(slug)) throw new StoreError(`invalid model name: ${slug}`, 400);
    return this.withLock(slug, async () => {
      await fs.mkdir(this.modelsDir, { recursive: true });
      try {
        await fs.mkdir(this.modelDir(slug));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError(`model already exists: ${slug}`, 409);
        throw err;
      }
      const now = new Date().toISOString();
      const meta: ModelMeta = { slug, name: input.name, description: input.description, createdAt: now };
      const main = 'main';
      const lineage: Lineage = {
        defaultBranch: main,
        branches: { [main]: { name: main, parent: null, forkedFrom: null, head: null, createdAt: now } },
        versions: [],
      };
      const paths = this.branchPaths(slug, main);
      await fs.mkdir(paths.adrs, { recursive: true });
      await atomicWrite(paths.workspace, input.dsl);
      await saveLayout(paths.layout, emptyLayout());
      await fs.mkdir(path.join(this.modelDir(slug), 'history'), { recursive: true });
      await this.#saveLineage(slug, lineage);
      await writeJson(path.join(this.modelDir(slug), 'model.json'), meta);
      await this.#snapshotLocked(slug, main, { source: 'init', message: input.message, force: true });
      return this.getSummary(slug);
    });
  }

  async deleteModel(slug: string): Promise<void> {
    await this.#meta(slug);
    await this.withLock(slug, () => fs.rm(this.modelDir(slug), { recursive: true, force: true }));
  }

  // ---- branches ----------------------------------------------------------

  /** Fork `from` (default: the default branch's working copy) into a new branch. */
  async createBranch(slug: string, input: { name: string; from?: Ref }): Promise<BranchInfo> {
    const name = input.name;
    if (!isValidName(name)) throw new StoreError(`invalid branch name: ${name} (use a-z, 0-9 and -, max 64)`, 400);
    return this.withLock(slug, async () => {
      const lineage = await this.getLineage(slug);
      if (lineage.branches[name]) throw new StoreError(`branch already exists: ${name}`, 409);
      const from: Ref = input.from ?? { branch: lineage.defaultBranch };
      let srcDir: string;
      let forkedFrom: string | null;
      let parent: string | null;
      if (from.version) {
        if (!lineage.versions.some((v) => v.id === from.version)) throw new StoreError(`version not found: ${from.version}`, 404);
        srcDir = this.historyDir(slug, from.version);
        forkedFrom = from.version;
        parent = from.branch || lineage.versions.find((v) => v.id === from.version)!.branch;
      } else {
        const src = lineage.branches[from.branch];
        if (!src) throw new StoreError(`branch not found: ${from.branch}`, 404);
        srcDir = this.branchPaths(slug, from.branch).dir;
        forkedFrom = src.head;
        parent = from.branch;
      }
      const dest = this.branchPaths(slug, name);
      await copyDir(srcDir, dest.dir);
      await fs.mkdir(dest.adrs, { recursive: true });
      if (!(await exists(dest.layout))) await saveLayout(dest.layout, emptyLayout());
      const info: BranchInfo = { name, parent, forkedFrom, head: null, createdAt: new Date().toISOString() };
      lineage.branches[name] = info;
      await this.#saveLineage(slug, lineage);
      const label = from.version ? `${from.branch}@${from.version}` : from.branch;
      await this.#snapshotLocked(slug, name, { source: 'fork', message: `Forked from ${label}`, force: true });
      return (await this.getLineage(slug)).branches[name]!;
    });
  }

  async deleteBranch(slug: string, branch: string): Promise<void> {
    await this.withLock(slug, async () => {
      const lineage = await this.getLineage(slug);
      if (!lineage.branches[branch]) throw new StoreError(`branch not found: ${slug}/${branch}`, 404);
      if (branch === lineage.defaultBranch) throw new StoreError('the default branch cannot be deleted', 400);
      delete lineage.branches[branch];
      await this.#saveLineage(slug, lineage);
      await fs.rm(this.branchPaths(slug, branch).dir, { recursive: true, force: true });
    });
  }

  // ---- writing -----------------------------------------------------------

  /** Run a mutation of the branch's working copy under the model lock, then snapshot (deduped). */
  async mutate<T>(
    slug: string,
    branch: string,
    opts: SnapshotOptions,
    fn: (paths: BranchPaths) => Promise<T> | T,
  ): Promise<{ result: T; version: Version | null }> {
    return this.withLock(slug, async () => {
      await this.requireBranch(slug, branch);
      const result = await fn(this.branchPaths(slug, branch));
      const version = await this.#snapshotLocked(slug, branch, opts);
      return { result, version };
    });
  }

  async writeDsl(slug: string, branch: string, dsl: string, opts: SnapshotOptions): Promise<Version | null> {
    const { version } = await this.mutate(slug, branch, opts, (p) => atomicWrite(p.workspace, dsl));
    return version;
  }

  async setViewLayout(slug: string, branch: string, key: string, view: ViewLayout): Promise<void> {
    await this.withLock(slug, async () => {
      await this.requireBranch(slug, branch);
      const p = this.branchPaths(slug, branch);
      await saveLayout(p.layout, replaceView(await loadLayout(p.layout), key, view));
    });
  }

  async removeViewLayout(slug: string, branch: string, key: string): Promise<void> {
    await this.withLock(slug, async () => {
      await this.requireBranch(slug, branch);
      const p = this.branchPaths(slug, branch);
      await saveLayout(p.layout, deleteView(await loadLayout(p.layout), key));
    });
  }

  /** Record a version of the branch's current working copy. Null when nothing changed. */
  snapshot(slug: string, branch: string, opts: SnapshotOptions): Promise<Version | null> {
    return this.withLock(slug, async () => {
      await this.requireBranch(slug, branch);
      return this.#snapshotLocked(slug, branch, opts);
    });
  }

  async #snapshotLocked(slug: string, branch: string, opts: SnapshotOptions): Promise<Version | null> {
    const lineage = await this.getLineage(slug);
    const info = lineage.branches[branch];
    if (!info) throw new StoreError(`branch not found: ${slug}/${branch}`, 404);
    const paths = this.branchPaths(slug, branch);
    const hash = await this.contentHash(paths.dir);
    if (!opts.force && info.head) {
      const headHash = await this.contentHash(this.historyDir(slug, info.head));
      if (headHash === hash) return null;
    }
    const id = newVersionId();
    const dest = this.historyDir(slug, id);
    const tmp = path.join(path.dirname(dest), `.${id}${TMP_SUFFIX}`);
    await copyDir(paths.dir, tmp);
    await fs.mkdir(path.join(tmp, 'adrs'), { recursive: true });
    if (!(await exists(path.join(tmp, 'layout.json')))) await saveLayout(path.join(tmp, 'layout.json'), emptyLayout());
    await fs.rename(tmp, dest);
    const dsl = (await readText(paths.workspace)) ?? '';
    const version: Version = {
      id,
      branch,
      parent: info.head ?? info.forkedFrom ?? null,
      createdAt: new Date().toISOString(),
      message: opts.message,
      source: opts.source,
      dslHash: sha256(dsl),
    };
    lineage.versions.push(version);
    info.head = id;
    await this.#saveLineage(slug, lineage);
    return version;
  }

  /**
   * Relabel the head version when it was recorded automatically by the watcher (source `file`).
   * Used by `snapshot -m` after a coding agent edited the DSL while the server was running, so the
   * version carries the agent's message instead of "Edited in file". Returns null when the head
   * is not a file snapshot.
   */
  relabelHead(slug: string, branch: string, opts: { message: string; source: VersionSource }): Promise<Version | null> {
    return this.withLock(slug, async () => {
      const lineage = await this.getLineage(slug);
      const info = lineage.branches[branch];
      if (!info) throw new StoreError(`branch not found: ${slug}/${branch}`, 404);
      const v = info.head ? lineage.versions.find((x) => x.id === info.head) : undefined;
      if (!v || v.source !== 'file') return null;
      v.message = opts.message;
      v.source = opts.source;
      await this.#saveLineage(slug, lineage);
      return v;
    });
  }

  /** Restore a version's DSL and ADRs into the branch and record a `rollback` version. */
  async rollback(slug: string, branch: string, versionId: string): Promise<Version | null> {
    return this.withLock(slug, async () => {
      const lineage = await this.getLineage(slug);
      if (!lineage.branches[branch]) throw new StoreError(`branch not found: ${slug}/${branch}`, 404);
      if (!lineage.versions.some((v) => v.id === versionId)) throw new StoreError(`version not found: ${versionId}`, 404);
      const src = this.historyDir(slug, versionId);
      const paths = this.branchPaths(slug, branch);
      await atomicWrite(paths.workspace, (await readText(path.join(src, 'workspace.dsl'))) ?? '');
      await fs.rm(paths.adrs, { recursive: true, force: true });
      await fs.mkdir(paths.adrs, { recursive: true });
      try {
        await fs.cp(path.join(src, 'adrs'), paths.adrs, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return this.#snapshotLocked(slug, branch, { source: 'rollback', message: `Rollback to ${versionId}` });
    });
  }
}
