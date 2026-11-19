/**
 * Run workspaces. The spec's paths are already absolute (runtime/resolve.ts resolved area:, data: and ~).
 *
 *   empty      a new folder, runs/<id>/workspace, that a workflow fills with clone steps
 *   none       no workspace: the run's own folder is its working directory
 *   dir        a local folder, worked in place (an agent step works in its workflow's workspace)
 *   snapshot   a copy, as the dev loop's dev-workspace.ts made it:
 *              - with a ref: `git archive <ref>` of the repository `from` into a snapshot made once per commit
 *                (<runsDir>/.snapshots/scaffold-<sha12>: npm ci, git init, one commit `scaffold <sha>`), then `into`
 *                is emptied and refilled from it copy-on-write, with node_modules a symlink to the snapshot's
 *              - without a ref: a copy of the folder `from` as it is (uncommitted changes included, .git and
 *                node_modules left out, node_modules linked to the folder's own), then git init and one commit
 *              Either way the workspace is a git repository whose HEAD is that one commit, with .slice.json,
 *              node_modules and .scratch/ excluded, so the done checks measure the agent's changes from HEAD.
 *
 * Pruning keeps the newest few run trees' workspaces (the clones). Everything else in a run's folder is kept for the
 * retention period (runtime/retention.ts).
 */
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readRecord } from "./run.ts";
import { isFinal, type RunRecord, type WorkspaceSpec } from "./types.ts";

export const WORKSPACE_DIR = "workspace";

/** Never committed in a workspace: the slice spec written for the agent, installed dependencies, scratch scripts. */
const EXCLUDES = "\n.slice.json\nnode_modules\n.scratch/\n";

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.trim().slice(-800) || e.message}`);
  }
}

/** git init and one commit of everything in `dir`, as `builder`. */
function commitAll(dir: string, message: string): void {
  run("git", ["init", "-q"], dir);
  run("git", ["config", "user.name", "builder"], dir);
  run("git", ["config", "user.email", "builder@gaffer.local"], dir);
  run("git", ["config", "commit.gpgsign", "false"], dir);
  // `node_modules` without a slash also matches a node_modules symlink.
  appendFileSync(join(dir, ".git", "info", "exclude"), EXCLUDES);
  run("git", ["add", "-A"], dir);
  run("git", ["commit", "-q", "--allow-empty", "-m", message], dir);
}

/** The snapshot of `repo` at `ref`, made when it does not exist yet. */
export function snapshot(repo: string, ref: string, snapshotsDir: string): string {
  const sha = run("git", ["rev-parse", `${ref}^{commit}`], repo);
  const snap = join(snapshotsDir, `scaffold-${sha.slice(0, 12)}`);
  if (existsSync(snap)) return snap;
  const tmp = `${snap}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execSync(`git -C ${sh(repo)} archive ${sha} | tar -x -C ${sh(tmp)}`, { stdio: ["ignore", "ignore", "pipe"] });
  if (existsSync(join(tmp, "package-lock.json"))) run("npm", ["ci"], tmp);
  commitAll(tmp, `scaffold ${sha}`);
  try {
    renameSync(tmp, snap);
  } catch (err) {
    // Another run made it first.
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(snap)) throw err;
  }
  return snap;
}

const COPY = process.platform === "darwin" ? "cp -cR" : "cp -a --reflink=auto";

/** Empty `into` (keeping the folder) and copy `from` into it, leaving out `skip`. */
function refill(from: string, into: string, skip: string[]): void {
  mkdirSync(into, { recursive: true });
  for (const entry of readdirSync(into)) rmSync(join(into, entry), { recursive: true, force: true });
  const entries = readdirSync(from).filter((e) => !skip.includes(e)).map((e) => sh(join(from, e)));
  if (entries.length) execSync(`${COPY} ${entries.join(" ")} ${sh(into)}/`, { stdio: ["ignore", "ignore", "pipe"] });
  // node_modules is linked, not copied: copying it is most of a refill, and the agent never installs.
  if (existsSync(join(from, "node_modules"))) symlinkSync(join(from, "node_modules"), join(into, "node_modules"));
}

export interface PrepareOptions {
  /** Where snapshots are cached (default <runsDir>/.snapshots, given by the run process). */
  snapshotsDir: string;
}

/** Get the run's workspace ready and return the working directory. */
export function prepareWorkspace(runDir: string, spec: WorkspaceSpec, o: PrepareOptions = { snapshotsDir: join(runDir, "..", ".snapshots") }): string {
  if (spec === "empty") {
    const ws = join(runDir, WORKSPACE_DIR);
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    return ws;
  }
  if (spec === "none") return runDir;
  if (typeof spec === "object" && "dir" in spec) {
    const path = spec.dir.path;
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`workspace ${path} is not a directory`);
    return path;
  }
  if (typeof spec === "object" && "snapshot" in spec) {
    const { from, ref } = spec.snapshot;
    const into = spec.snapshot.into ?? join(runDir, WORKSPACE_DIR);
    if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`snapshot source ${from} is not a directory`);
    if (ref) {
      mkdirSync(o.snapshotsDir, { recursive: true });
      refill(snapshot(from, ref, o.snapshotsDir), into, ["node_modules"]);
    } else {
      refill(from, into, ["node_modules", ".git"]);
      commitAll(into, `snapshot of ${from}`);
    }
    return into;
  }
  throw new Error(`workspace ${JSON.stringify(spec)}: one of empty, none, dir, snapshot`);
}

/** The commit a workspace is at, or null when it is not a git repository. */
export function workspaceHead(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Retention of clones (keepWorkspaces): keep the workspaces of the newest `keep` run trees (a root run and the runs
 * below it; `current` counts and comes first) and delete those of the rest. Everything else in their folders (the
 * journal and its blobs, pinned definitions, sessions, the log, context, run.json) stays for the retention period
 * (runtime/retention.ts). A tree with a live run is never touched. Deleting is asynchronous: a workspace holds
 * node_modules, and removing it must not stall the server's HTTP answers.
 */
export function pruneWorkspaces(runsDir: string, keep: number, current: string | null, warn: (msg: string) => void): void {
  try {
    if (!existsSync(runsDir)) return;
    const recs = new Map<string, RunRecord>();
    for (const e of readdirSync(runsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const r = readRecord(runsDir, e.name);
      if (r) recs.set(r.id, r);
    }
    const rootOf = (r: RunRecord): string => {
      let cur = r;
      for (let depth = 0; depth < 32; depth++) {
        const up = cur.parent ? recs.get(cur.parent) : undefined;
        if (!up) return cur.id;
        cur = up;
      }
      return cur.id;
    };
    const trees = new Map<string, RunRecord[]>();
    for (const r of recs.values()) {
      const root = rootOf(r);
      trees.set(root, [...(trees.get(root) ?? []), r]);
    }
    const has = (r: RunRecord, sub: string) => existsSync(join(runsDir, r.id, sub));
    const roots = [...trees.entries()]
      .filter(([root, runs]) => runs.some((r) => has(r, WORKSPACE_DIR)) && (root === current || runs.every((r) => isFinal(r.state))))
      .map(([root]) => recs.get(root)!)
      .sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : b.startedAt.localeCompare(a.startedAt)));
    for (const old of roots.slice(Math.max(0, keep))) {
      for (const r of trees.get(old.id) ?? []) {
        const path = join(runsDir, r.id, WORKSPACE_DIR);
        if (existsSync(path)) void rm(path, { recursive: true, force: true }).catch((err: Error) => warn(`could not delete ${path}: ${err.message}`));
      }
    }
  } catch (err) {
    warn(`could not prune workspaces: ${(err as Error).message}`);
  }
}
