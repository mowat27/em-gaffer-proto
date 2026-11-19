import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** app/ directory (this file lives in app/src/core). */
export const appDir = path.resolve(import.meta.dirname, '../..');
/** The c4-studio skill directory (parent of app/). */
export const skillDir = path.resolve(import.meta.dirname, '../../..');

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** C4_STUDIO_PROJECT, else git toplevel of cwd, else cwd. */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  const fromEnv = process.env.C4_STUDIO_PROJECT;
  if (fromEnv) return path.resolve(fromEnv);
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (out) return out;
  } catch {
    // not a git repository
  }
  return path.resolve(cwd);
}

export interface ProjectPaths {
  projectRoot: string;
  /** <projectRoot>/c4-studio */
  studioDir: string;
  modelsDir: string;
  skillDir: string;
  appDir: string;
}

export function projectPaths(projectRoot: string, skill: string = skillDir): ProjectPaths {
  const studioDir = path.join(projectRoot, 'c4-studio');
  return {
    projectRoot,
    studioDir,
    modelsDir: path.join(studioDir, 'models'),
    skillDir: skill,
    appDir: path.resolve(skill, 'app'),
  };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Directories searched for skills, in order: project, home, repo siblings of this skill. */
export function skillSearchDirs(projectRoot: string, skill: string = skillDir): string[] {
  return [
    path.join(projectRoot, '.claude', 'skills'),
    path.join(homeDir(), '.claude', 'skills'),
    path.resolve(skill, '..'),
  ];
}

/** c4-modeller skill directory: project, then home, then sibling of this skill. null when none exists. */
export function findC4Modeller(projectRoot: string, skill: string = skillDir): string | null {
  for (const base of skillSearchDirs(projectRoot, skill)) {
    const candidate = path.join(base, 'c4-modeller');
    if (isDir(candidate) && fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  return null;
}

/** Find an executable on PATH. */
export function which(bin: string): string | null {
  if (bin.includes(path.sep)) return fs.existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
