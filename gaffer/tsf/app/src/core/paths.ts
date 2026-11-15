import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app directory this process runs from (`skills/tsf/app` or `<project>/tsf/app`), found from this file's location. */
export const ownAppDir: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * True when `app` is a project's own copy (`<project>/tsf/app`: its parent is a `tsf` folder holding `mod.just`).
 * The copy is made by `scripts/install.sh` and recorded in `.tsf-base` (DESIGN 2, "Liquid core").
 */
export function isProjectApp(app: string): boolean {
  const parent = dirname(app);
  return basename(app) === "app" && basename(parent) === "tsf" && existsSync(join(parent, "mod.just"));
}

/** `.tsf-base` of an app copy: where it came from. Undefined when absent or unreadable. */
export function readAppBase(app: string): { appVersion?: string; skillDir?: string; commit?: string; date?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(app, ".tsf-base"), "utf8")) as ReturnType<typeof readAppBase>;
  } catch {
    return undefined;
  }
}

function findSkillDir(): string {
  const fromEnv = process.env.TSF_SKILL_DIR;
  if (fromEnv !== undefined && fromEnv !== "" && existsSync(join(fromEnv, "template"))) return resolve(fromEnv);
  if (isProjectApp(ownAppDir)) {
    const recorded = readAppBase(ownAppDir)?.skillDir;
    if (recorded !== undefined && existsSync(join(recorded, "template"))) return resolve(recorded);
  }
  return dirname(ownAppDir);
}

/** The skill directory (`skills/tsf`): TSF_SKILL_DIR, else the one recorded in a project copy's `.tsf-base`, else the parent of the app. */
export const skillDir: string = findSkillDir();

/** The skill's own app (`<skill>/app`), the source of a project copy and the fallback when a project has none. */
export const skillAppDir: string = existsSync(join(skillDir, "app", "package.json")) ? join(skillDir, "app") : ownAppDir;

/**
 * The app a project runs is always the app this process runs from: the launcher in `tsf/app` runs `tsf/app/src`, and
 * the skill's launcher runs the skill's app. Code, built-in layers and the web source must come from the same tree as
 * the running server (its node_modules live there), so a project copy is never loaded by a skill-run server; it is only
 * reported (`projectAppDir`, `startup.app_mismatch`) so the operator starts the project's own launcher.
 */
export function resolveAppDir(_projectRoot: string): string {
  return ownAppDir;
}

/** `<project>/tsf/app` when the project owns a copy of the app, else undefined. */
export function projectAppDir(projectRoot: string): string | undefined {
  const own = join(resolve(projectRoot), "tsf", "app");
  return existsSync(join(own, "package.json")) ? own : undefined;
}

/** The `appDir` the module exported before projects owned a copy: the app this process runs from. */
export const appDir: string = ownAppDir;

export interface ProjectPaths {
  projectRoot: string;
  tsfDir: string;
  pagesDir: string;
  layersDir: string;
  dataDir: string;
  logsDir: string;
  agentDb: string;
  appDb: string;
  lockFile: string;
  serverState: string;
  envFile: string;
  permissionsFile: string;
  skillDir: string;
  appDir: string;
  builtinLayersDir: string;
  webSrc: string;
  distDir: string;
}

function gitToplevel(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? resolve(out) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project root, in order: `TSF_PROJECT`; the nearest ancestor of `cwd` (cwd included) that holds `tsf/mod.just`;
 * the git toplevel; `cwd` (DESIGN 3 step 1).
 */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  const fromEnv = process.env.TSF_PROJECT;
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "tsf", "mod.just"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitToplevel(cwd) ?? resolve(cwd);
}

export function projectPaths(projectRoot: string): ProjectPaths {
  const root = resolve(projectRoot);
  const tsfDir = join(root, "tsf");
  const dataDir = join(tsfDir, "data");
  const app = resolveAppDir(root);
  return {
    projectRoot: root,
    tsfDir,
    pagesDir: join(tsfDir, "pages"),
    layersDir: join(tsfDir, "layers"),
    dataDir,
    logsDir: join(dataDir, "logs"),
    agentDb: join(dataDir, "agent.sqlite"),
    appDb: join(dataDir, "tsf.sqlite"),
    lockFile: join(dataDir, "agent.sqlite.lock"),
    serverState: join(dataDir, "server.json"),
    envFile: join(tsfDir, ".env"),
    permissionsFile: join(tsfDir, "permissions.json"),
    skillDir,
    appDir: app,
    builtinLayersDir: join(app, "src", "layers"),
    webSrc: join(app, "src", "web"),
    distDir: join(app, "dist"),
  };
}
