import fs from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StudioConfig } from '../shared/types.ts';
import { loadConfig } from '../core/config.ts';
import { JobManager, type JobManagerOptions } from '../core/jobs.ts';
import { appDir as defaultAppDir, projectPaths, skillDir as defaultSkillDir } from '../core/paths.ts';
import { Store } from '../core/store.ts';
import { chatRoutes } from './chat/route.ts';
import { EventHub } from './events.ts';
import { miscRoutes } from './routes/misc.ts';
import { modelRoutes } from './routes/models.ts';
import { errorResponse, Service, type StudioContext } from './service.ts';
import { StateManager } from './state.ts';
import { Watcher } from './watcher.ts';

export interface StudioOptions {
  projectRoot: string;
  /** Defaults to <projectRoot>/c4-studio/models */
  modelsDir?: string;
  skillDir?: string;
  appDir?: string;
  config?: StudioConfig;
  /** Start the file watcher (default true) */
  watch?: boolean;
  /** Directory served as the web app (default <appDir>/dist/web) */
  webRoot?: string;
  snapshotDebounceMs?: number;
  /** Test seams for the job runner */
  jobs?: Pick<JobManagerOptions, 'claudeBin' | 'spawn' | 'c4Modeller'>;
  version?: string;
}

export interface Studio {
  app: Hono;
  ctx: StudioContext;
  watcher: Watcher | null;
  /** Listen on 127.0.0.1. Port 0 picks a free port. */
  listen(port: number): Promise<{ server: Server; port: number; url: string }>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function staticHandler(webRoot: string) {
  const root = path.resolve(webRoot);
  return async (c: { req: { path: string }; body: (b: BodyInit | null, status?: number, headers?: Record<string, string>) => Response; text: (t: string, s?: number) => Response }) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return c.text('bad request', 400);
    }
    let file = path.join(root, rel);
    if (path.relative(root, file).startsWith('..')) return c.text('not found', 404);
    let st = await fs.stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fs.stat(file).catch(() => null);
    }
    if (!st?.isFile()) {
      // asset-looking paths that do not exist are real 404s; everything else is an SPA route
      if (path.extname(rel) && rel.startsWith('/assets/')) return c.text('not found', 404);
      file = path.join(root, 'index.html');
      st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) return c.text('The web app is not built. Run `npm run build:web` in the c4-studio app directory.', 404);
    }
    const ext = path.extname(file).toLowerCase();
    const isIndex = path.basename(file) === 'index.html';
    const cache = isIndex ? 'no-cache' : rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(await fs.readFile(file), 200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cache });
  };
}

export async function createStudio(opts: StudioOptions): Promise<Studio> {
  const skillDir = opts.skillDir ?? defaultSkillDir;
  const paths = projectPaths(opts.projectRoot, skillDir);
  const modelsDir = opts.modelsDir ?? paths.modelsDir;
  const appDir = opts.appDir ?? defaultAppDir;
  const config = opts.config ?? loadConfig(opts.projectRoot);

  const store = new Store(modelsDir);
  const hub = new EventHub();
  const state = new StateManager(store, hub);
  const service = new Service(store, state, hub);
  const jobs = new JobManager({
    store,
    config: () => config,
    projectRoot: opts.projectRoot,
    modelsDir,
    skillDir,
    ...opts.jobs,
    hooks: {
      onJob: (job) => hub.broadcast({ type: 'job', job }),
      onBusy: (model, branch, busy) => void state.setBusy(model, branch, busy),
      onSnapshot: (model, branch) => void state.refresh(model, branch, { force: true }).catch(() => undefined),
    },
  });
  await jobs.init();

  const ctx: StudioContext = {
    projectRoot: opts.projectRoot,
    modelsDir,
    skillDir,
    appDir,
    config,
    store,
    hub,
    state,
    jobs,
    service,
    version: opts.version ?? '0.1.0',
  };

  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = errorResponse(err);
    return c.json(body, status);
  });

  const api = new Hono();
  api.route('/models', modelRoutes(ctx));
  api.route('/chat', chatRoutes(ctx));
  api.route('/', miscRoutes(ctx));
  app.route('/api', api);

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  const serveStatic = staticHandler(opts.webRoot ?? path.join(appDir, 'dist', 'web'));
  app.get('*', (c) => serveStatic(c as never));

  let watcher: Watcher | null = null;
  if (opts.watch !== false) {
    await fs.mkdir(modelsDir, { recursive: true });
    watcher = new Watcher({ modelsDir, store, state, hub, snapshotDebounceMs: opts.snapshotDebounceMs });
    await watcher.start();
  }

  let server: Server | null = null;
  return {
    app,
    ctx,
    watcher,
    listen(port: number) {
      return new Promise((resolve, reject) => {
        const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info: AddressInfo) => {
          server = s as unknown as Server;
          resolve({ server: server, port: info.port, url: `http://127.0.0.1:${info.port}` });
        }) as unknown as Server;
        s.once('error', reject);
      });
    },
    async close() {
      jobs.cancelAll();
      await watcher?.close();
      const s = server as Server | null;
      if (s) {
        (s as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}
