#!/usr/bin/env node
// Launcher for the C4 Studio CLI and server. Plain JavaScript so it runs from any
// working directory: it registers the tsx loader from this app's own node_modules,
// then imports the TypeScript entry point.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

if (!existsSync(join(appDir, 'node_modules', 'tsx'))) {
  console.error('c4-studio: installing app dependencies (first run)...');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('c4-studio: npm install failed');
    process.exit(1);
  }
}

const require = createRequire(join(appDir, 'package.json'));
const { register } = require('tsx/esm/api');
register();
const { runCli } = await import(join(appDir, 'src', 'cli', 'main.ts'));
const code = await runCli(process.argv.slice(2));
process.exit(code);
