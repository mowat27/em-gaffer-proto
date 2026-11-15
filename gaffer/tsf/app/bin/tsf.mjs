#!/usr/bin/env node
// Launcher for the TSF CLI and server. Plain JavaScript so it runs from any working directory:
//   1. installs node modules when package.json, package-lock.json or the Node major changed,
//   2. registers the tsx loader from this app's own node_modules and runs src/main.ts.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgFile = join(appDir, 'package.json');
const lockFile = join(appDir, 'package-lock.json');
const hashFile = join(appDir, 'node_modules', '.tsf-install-hash');

// 1. Install when the inputs changed.
const nodeMajor = process.version.replace(/^v/, '').split('.')[0];
const hash = createHash('sha256')
  .update(readFileSync(pkgFile))
  .update(existsSync(lockFile) ? readFileSync(lockFile) : '')
  .update(nodeMajor)
  .digest('hex');
let installed = '';
try {
  installed = readFileSync(hashFile, 'utf8').trim();
} catch {
  installed = '';
}
if (installed !== hash || !existsSync(join(appDir, 'node_modules', 'tsx'))) {
  console.error('tsf: installing app dependencies...');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir, stdio: ['ignore', 2, 2] });
  if (r.status !== 0) {
    console.error('tsf: npm install failed');
    process.exit(1);
  }
  mkdirSync(dirname(hashFile), { recursive: true });
  // The lock file may have been written by this install, so hash again.
  const after = createHash('sha256')
    .update(readFileSync(pkgFile))
    .update(existsSync(lockFile) ? readFileSync(lockFile) : '')
    .update(nodeMajor)
    .digest('hex');
  writeFileSync(hashFile, `${after}\n`);
}

// 2. Run the TypeScript entry point.
const require = createRequire(pkgFile);
const { register } = require('tsx/esm/api');
register();
const { runCli } = await import(pathToFileURL(join(appDir, 'src', 'main.ts')).href);
const code = await runCli(process.argv.slice(2));
process.exit(code);
