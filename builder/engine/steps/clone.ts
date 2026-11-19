/**
 * clone: the dispatch's repository at `repo.base` into the workspace root. Each clone names its repository; P1 has
 * one, `app`, and its patch becomes the contract's `patch`.
 *
 * A run spec's `input.repos.<name>` (runtime/repos.ts) is cloned instead of the dispatch's url: a local folder, a data:
 * folder or the previous run's workspace (git clone takes local paths, and only committed work). At the dispatch's
 * base, or at the commit its `ref` named when the run started.
 */
import { spawnSync } from "node:child_process";
import type { StepContext } from "../types.ts";

/** `git@github.com:org/app.git` or `https://github.com/org/app.git` -> `github.com/org/app`. */
export function repoKey(url: string): string {
  let s = url.trim().replace(/\.git$/, "");
  const ssh = /^[^@]+@([^:]+):(.+)$/.exec(s);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.replace(/^[^@]+@/, "");
  return s;
}

export function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout || "").trim().slice(0, 500)}`);
  return (res.stdout || "").trim();
}

export interface CloneOutput {
  repo: string;
  url: string;
  base: string;
  /** Where the repository is, relative to the workspace root ("." = the root). */
  into: string;
  /** The run spec's input.repos source, as written, when it replaced the dispatch's url. */
  from?: string;
}

export function clone(o: { repo: "app" }): (ctx: StepContext) => Promise<CloneOutput> {
  return async (ctx) => {
    const source = ctx.job.repos?.[o.repo];
    const url = source?.path ?? ctx.job.dispatch.repo.url;
    const base = source?.base ?? ctx.job.dispatch.repo.base;
    const where = source ? `${o.repo} from ${source.from}${source.from === url ? "" : ` (${url})`}` : repoKey(url);
    ctx.emit("clone", `cloning ${where} at ${base.slice(0, 12)}`);
    git(ctx.dir, ["clone", "-q", url, "."]);
    try {
      git(ctx.dir, ["checkout", "-q", base]);
    } catch (err) {
      throw new Error(`base ${base} is not in the repository: ${(err as Error).message}`);
    }
    return { repo: o.repo, url, base, into: ".", ...(source ? { from: source.from } : {}) };
  };
}
