import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Job, JobEvent, JobRequest, JobType, StudioConfig, Version } from '../shared/types.ts';
import { buildJobArgv, mapStreamMessage, parseStreamLine, resolveClaudeBinary, spawnClaude, type ClaudeRun } from './claude.ts';
import { isInside, readJson, writeJson } from './fsutil.ts';
import { findC4Modeller } from './paths.ts';
import { skeletonDsl, StoreError, type Store } from './store.ts';
import { clearJobLock, writeJobLock } from './joblock.ts';

const MAX_JOBS = 50;
const MAX_EVENTS = 2000;
const TRIM_EVENTS = 50;
const EVENT_THROTTLE_MS = 100;

export interface JobHooks {
  /** A job was created, changed status, or (throttled to 10/s) got new events */
  onJob?(job: Job, reason: 'created' | 'status' | 'event'): void;
  /** Every event, unthrottled and untrimmed (the CLI streams these) */
  onEvent?(job: Job, ev: JobEvent): void;
  /** A branch started or stopped being written by a job */
  onBusy?(model: string, branch: string, busy: { jobId: string; label: string } | null): void;
  /** A job's successful run produced (or deduped) a version */
  onSnapshot?(model: string, branch: string, version: Version | null): void;
}

export interface JobManagerOptions {
  store: Store;
  config: () => StudioConfig;
  projectRoot: string;
  modelsDir: string;
  skillDir: string;
  hooks?: JobHooks;
  /** Override the claude binary (tests) */
  claudeBin?: () => string | null;
  /** Override the spawn function (tests) */
  spawn?: typeof spawnClaude;
  /** Override the c4-modeller lookup (tests) */
  c4Modeller?: () => string | null;
}

export interface PromptContext {
  c4ModellerDir: string;
  workspacePath: string;
  codePath: string;
  /** The branch still holds only the generated skeleton */
  skeleton: boolean;
}

/** Prompt templates, per DESIGN.md. */
export function buildPrompt(req: JobRequest, ctx: PromptContext): string {
  const skill = `the c4-modeller skill at ${ctx.c4ModellerDir}/SKILL.md`;
  const validate = `${ctx.c4ModellerDir}/scripts/validate.sh`;
  switch (req.type) {
    case 'create':
      return (
        `Follow ${skill} in \`model\` mode. Request: ${req.prompt}. ` +
        `Write the workspace to ${ctx.workspacePath} (replace the skeleton there), export JSON beside it only if the skill's recipe says so, ` +
        `validate with ${validate}, and finish with the Model Hand-Off block. Do not write anywhere else.`
      );
    case 'reverse':
      if (ctx.skeleton) {
        return (
          `Follow ${skill} in \`model\` mode on the codebase at ${ctx.codePath} (all levels with evidence). Request: ${req.prompt || 'reverse engineer the codebase'}. ` +
          `Write the workspace to ${ctx.workspacePath} (replace the skeleton there), validate with ${validate}, ` +
          `and finish with the Model Hand-Off block. Do not write anywhere else; the codebase is read-only evidence.`
        );
      }
      return (
        `Follow ${skill} in \`update sync\` mode against the codebase at ${ctx.codePath}, on the workspace at ${ctx.workspacePath}. ` +
        `${req.prompt ? `Request: ${req.prompt}. ` : ''}Validate with ${validate} and finish with the Model Hand-Off block. ` +
        `Do not write anywhere else; the codebase is read-only evidence.`
      );
    case 'update':
      return `Follow ${skill} in \`update\` mode on the workspace at ${ctx.workspacePath}: ${req.prompt}. Validate with ${validate} and finish with the Model Hand-Off block. Do not write anywhere else.`;
    case 'ask':
      return `Follow ${skill} in \`ask\` mode on the workspace at ${ctx.workspacePath}: ${req.prompt}. Do not write any files.`;
  }
}

function newJobId(): string {
  return 'j' + Date.now().toString(36) + Array.from(randomBytes(3), (b) => (b % 36).toString(36)).join('');
}

function trimmed(job: Job): Job {
  return job.events.length > TRIM_EVENTS ? { ...job, events: job.events.slice(-TRIM_EVENTS) } : job;
}

interface Running {
  run?: ClaudeRun;
  cancelled: boolean;
}

export class JobManager {
  readonly #o: JobManagerOptions;
  readonly #jobs = new Map<string, Job>();
  readonly #running = new Map<string, Running>();
  readonly #waiters = new Map<string, Array<(j: Job) => void>>();
  readonly #queues = new Map<string, string[]>();
  readonly #active = new Map<string, string>();
  readonly #timers = new Map<string, { timer: NodeJS.Timeout; dirty: boolean }>();

  constructor(options: JobManagerOptions) {
    this.#o = options;
  }

  get jobsDir(): string {
    return path.join(this.#o.modelsDir, '.jobs');
  }

  /** Load persisted jobs. Jobs that were running when the process died are marked failed. */
  async init(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.jobsDir);
    } catch {
      return;
    }
    const loaded: Job[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const j = await readJson<Job>(path.join(this.jobsDir, n));
        if (j?.id) loaded.push(j);
      } catch {
        // corrupt job file
      }
    }
    loaded.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const j of loaded.slice(-MAX_JOBS)) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed';
        j.error = 'Interrupted: the server stopped while this job was running';
        j.finishedAt = new Date().toISOString();
        await this.#persist(j);
      }
      this.#jobs.set(j.id, j);
    }
    for (const j of loaded.slice(0, -MAX_JOBS)) await fs.rm(path.join(this.jobsDir, `${j.id}.json`), { force: true });
  }

  list(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(trimmed);
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /** Resolves when the job reaches a final state. */
  waitFor(id: string): Promise<Job> {
    const job = this.#jobs.get(id);
    if (!job) return Promise.reject(new StoreError(`job not found: ${id}`, 404));
    if (job.status !== 'queued' && job.status !== 'running') return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.#waiters.get(id) ?? [];
      list.push(resolve);
      this.#waiters.set(id, list);
    });
  }

  async submit(req: JobRequest): Promise<Job> {
    const types: JobType[] = ['create', 'reverse', 'update', 'ask'];
    if (!types.includes(req.type)) throw new StoreError(`invalid job type: ${req.type}`, 400);
    if (typeof req.prompt !== 'string' || (!req.prompt.trim() && req.type !== 'reverse')) throw new StoreError('prompt is required', 400);
    if (req.claudeArgs !== undefined && (!Array.isArray(req.claudeArgs) || req.claudeArgs.some((a) => typeof a !== 'string'))) {
      throw new StoreError('claudeArgs must be an array of strings', 400);
    }
    const lineage = await this.#o.store.getLineage(req.model);
    const branch = req.branch || lineage.defaultBranch;
    await this.#o.store.requireBranch(req.model, branch);
    const job: Job = {
      ...req,
      branch,
      id: newJobId(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      argv: [],
      events: [],
    };
    this.#jobs.set(job.id, job);
    this.#prune();
    await this.#persist(job);
    this.#o.hooks?.onJob?.(trimmed(job), 'created');
    const key = `${req.model}/${branch}`;
    if (this.#active.has(key)) {
      const q = this.#queues.get(key) ?? [];
      q.push(job.id);
      this.#queues.set(key, q);
    } else {
      void this.#start(job, key);
    }
    return job;
  }

  /** Cancel a queued or running job. Returns false when it was not active. */
  cancel(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) throw new StoreError(`job not found: ${id}`, 404);
    if (job.status === 'queued') {
      const key = `${job.model}/${job.branch}`;
      this.#queues.set(key, (this.#queues.get(key) ?? []).filter((x) => x !== id));
      void this.#finish(job, 'cancelled');
      return true;
    }
    const r = this.#running.get(id);
    if (job.status === 'running' && r) {
      r.cancelled = true;
      r.run?.cancel();
      return true;
    }
    return false;
  }

  /** Cancel everything (shutdown). */
  cancelAll(): void {
    for (const id of [...this.#jobs.keys()]) {
      try {
        this.cancel(id);
      } catch {
        // ignore
      }
    }
  }

  // ---- internals ---------------------------------------------------------

  #prune(): void {
    const all = [...this.#jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (all.length > MAX_JOBS) {
      const old = all.shift()!;
      if (old.status === 'queued' || old.status === 'running') continue;
      this.#jobs.delete(old.id);
      void fs.rm(path.join(this.jobsDir, `${old.id}.json`), { force: true });
    }
  }

  async #persist(job: Job): Promise<void> {
    try {
      await writeJson(path.join(this.jobsDir, `${job.id}.json`), job);
    } catch {
      // persistence is best effort
    }
  }

  #notifyEvent(job: Job): void {
    const t = this.#timers.get(job.id);
    if (t) {
      t.dirty = true;
      return;
    }
    this.#o.hooks?.onJob?.(trimmed(job), 'event');
    const entry = { dirty: false, timer: undefined as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(() => {
      this.#timers.delete(job.id);
      if (entry.dirty) this.#notifyEvent(job);
    }, EVENT_THROTTLE_MS);
    entry.timer.unref?.();
    this.#timers.set(job.id, entry);
  }

  #push(job: Job, ev: JobEvent): void {
    job.events.push(ev);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    this.#o.hooks?.onEvent?.(job, ev);
    this.#notifyEvent(job);
  }

  async #finish(job: Job, status: Job['status'], error?: string): Promise<void> {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (error) job.error = error;
    const t = this.#timers.get(job.id);
    if (t) {
      clearTimeout(t.timer);
      this.#timers.delete(job.id);
    }
    await this.#persist(job);
    this.#o.hooks?.onJob?.(trimmed(job), 'status');
    for (const w of this.#waiters.get(job.id) ?? []) w(job);
    this.#waiters.delete(job.id);
  }

  #next(key: string): void {
    this.#active.delete(key);
    const q = this.#queues.get(key) ?? [];
    while (q.length) {
      const id = q.shift()!;
      const job = this.#jobs.get(id);
      if (job && job.status === 'queued') {
        void this.#start(job, key);
        return;
      }
    }
    this.#queues.delete(key);
  }

  async #start(job: Job, key: string): Promise<void> {
    this.#active.set(key, job.id);
    const state: Running = { cancelled: false };
    this.#running.set(job.id, state);
    const model = job.model;
    const branch = job.branch!;
    const writes = job.type !== 'ask';
    let busySet = false;
    try {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      this.#o.hooks?.onJob?.(trimmed(job), 'status');
      if (writes) {
        const label = `${job.type}: ${job.prompt.slice(0, 80)}`;
        this.#o.hooks?.onBusy?.(model, branch, { jobId: job.id, label });
        writeJobLock(this.#o.store.branchPaths(model, branch).dir, { jobId: job.id, label });
        busySet = true;
      }

      const bin = (this.#o.claudeBin ?? resolveClaudeBinary)();
      if (!bin) {
        await this.#finish(job, 'failed', 'claude binary not found on PATH (set C4_STUDIO_CLAUDE to its path)');
        return;
      }
      const c4 = (this.#o.c4Modeller ?? (() => findC4Modeller(this.#o.projectRoot, this.#o.skillDir)))();
      if (!c4) {
        await this.#finish(job, 'failed', 'c4-modeller skill not found (looked in <project>/.claude/skills, ~/.claude/skills and next to the c4-studio skill)');
        return;
      }
      const paths = this.#o.store.branchPaths(model, branch);
      const meta = await this.#o.store.getModel(model);
      const dsl = await fs.readFile(paths.workspace, 'utf8').catch(() => '');
      const codePath = job.codePath ? path.resolve(this.#o.projectRoot, job.codePath) : this.#o.projectRoot;
      const prompt = buildPrompt(job, {
        c4ModellerDir: c4,
        workspacePath: paths.workspace,
        codePath,
        skeleton: dsl === skeletonDsl(meta.name, meta.description),
      });
      const cfg = this.#o.config();
      const extraDirs = isInside(this.#o.projectRoot, c4) ? [] : [c4];
      const argv = buildJobArgv({
        config: cfg.claude,
        prompt,
        modelsDir: this.#o.modelsDir,
        codePath: job.type === 'reverse' && job.codePath ? codePath : undefined,
        extraDirs,
        claudeArgs: job.claudeArgs,
      });
      job.argv = ['claude', ...argv];
      await this.#persist(job);

      let resultSeen: { text: string; isError: boolean } | null = null;
      let lastText = '';
      const spawn = this.#o.spawn ?? spawnClaude;
      const run = spawn({
        bin,
        argv,
        cwd: this.#o.projectRoot,
        env: process.env,
        onLine: (line) => {
          const msg = parseStreamLine(line);
          if (!msg) return;
          const mapped = mapStreamMessage(msg);
          if (mapped.sessionId && !job.sessionId && msg.type === 'system') job.sessionId = mapped.sessionId;
          for (const ev of mapped.events) {
            if (ev.kind === 'text') lastText = ev.text;
            this.#push(job, ev);
          }
          if (mapped.result) {
            resultSeen = mapped.result;
            job.result = mapped.result.text;
          }
        },
        onStderr: (text) => {
          const t = text.trim();
          if (t) this.#push(job, { ts: new Date().toISOString(), kind: 'stderr', text: t });
        },
      });
      state.run = run;
      if (state.cancelled) run.cancel();
      const exit = await run.done;
      job.exitCode = exit.code ?? undefined;
      if (!job.result && lastText) job.result = lastText;

      if (state.cancelled) {
        await this.#finish(job, 'cancelled');
      } else if (exit.code === 0 && !(resultSeen as { isError: boolean } | null)?.isError) {
        if (writes) {
          try {
            const v = await this.#o.store.snapshot(model, branch, { source: 'agent', message: `${job.type}: ${job.prompt.slice(0, 80)}` });
            this.#o.hooks?.onSnapshot?.(model, branch, v);
          } catch (err) {
            this.#push(job, { ts: new Date().toISOString(), kind: 'system', text: `Snapshot failed: ${(err as Error).message}` });
          }
        }
        await this.#finish(job, 'succeeded');
      } else {
        const tail = exit.stderr.trim().split('\n').slice(-5).join('\n');
        const why = (resultSeen as { text: string; isError: boolean } | null)?.isError ? job.result || 'claude reported an error' : tail || `claude exited with code ${exit.code}`;
        await this.#finish(job, 'failed', why);
      }
    } catch (err) {
      await this.#finish(job, 'failed', (err as Error).message);
    } finally {
      this.#running.delete(job.id);
      if (busySet) {
        clearJobLock(this.#o.store.branchPaths(model, branch).dir);
        this.#o.hooks?.onBusy?.(model, branch, null);
      }
      this.#next(key);
    }
  }
}
