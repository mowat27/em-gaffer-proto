import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.ts';
import { loadEnv } from '../core/env.ts';
import { appDir, resolveProjectRoot, skillDir } from '../core/paths.ts';
import { createStudio } from './app.ts';

export interface RunServerOptions {
  port?: number;
  open?: boolean;
  projectRoot?: string;
}

/** Build dist/web with vite when it is missing. Returns false when it could not be built. */
export function ensureWebBuilt(dir: string = appDir): boolean {
  if (fs.existsSync(path.join(dir, 'dist', 'web', 'index.html'))) return true;
  if (!fs.existsSync(path.join(dir, 'src', 'web', 'index.html'))) {
    console.warn('c4-studio: src/web/index.html not found; serving the API only');
    return false;
  }
  console.error('c4-studio: building the web app (first run)...');
  const localVite = path.join(dir, 'node_modules', '.bin', 'vite');
  const res = fs.existsSync(localVite)
    ? spawnSync(localVite, ['build'], { cwd: dir, stdio: ['ignore', 2, 2] })
    : spawnSync('npx', ['--no-install', 'vite', 'build'], { cwd: dir, stdio: ['ignore', 2, 2] });
  if (res.status !== 0) {
    console.error('c4-studio: web build failed; serving the API only');
    return false;
  }
  return true;
}

export async function runServer(opts: RunServerOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? resolveProjectRoot();
  loadEnv(projectRoot);
  const config = loadConfig(projectRoot);
  const envPort = process.env.C4_STUDIO_PORT ? Number(process.env.C4_STUDIO_PORT) : undefined;
  const port = opts.port ?? envPort ?? config.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
  ensureWebBuilt();
  const studio = await createStudio({ projectRoot, config });
  let listening;
  try {
    listening = await studio.listen(port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`port ${port} is in use. Another C4 Studio may be running; use --port or C4_STUDIO_PORT.`);
    }
    throw err;
  }
  console.log(`C4 Studio running at ${listening.url}`);
  console.log(`  project ${projectRoot}`);
  console.log(`  models  ${studio.ctx.modelsDir}`);
  if (opts.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', listening.url] : [listening.url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  }
  const shutdown = () => {
    void studio.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function parseServeArgs(argv: string[]): RunServerOptions {
  const out: RunServerOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--open') out.open = true;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runServer(parseServeArgs(process.argv.slice(2))).catch((err) => {
    console.error(`c4-studio: ${(err as Error).message}`);
    process.exit(1);
  });
}

export { skillDir };
