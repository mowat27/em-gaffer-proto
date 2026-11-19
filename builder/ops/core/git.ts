/**
 * git: this repository only (D15). Every tool runs git in the top level of the repository that holds builder/
 * (ctx.builderRoot), never in a run's workspace or any target repository: no tool takes a directory, paths are
 * pathspecs inside this repository, and a ref or name that would read as an option is refused. Commits by an agent
 * carry Builder-Agent and Builder-Run trailers, so a commit leads back to the run's journal. Pushes never force.
 * Nothing prompts: git runs with GIT_TERMINAL_PROMPT=0, so a push without credentials fails instead of waiting.
 *
 *   git_status   branch, upstream, ahead/behind and changed files
 *   git_diff     the working tree, the index (staged) or against a ref; optionally only some paths, or a stat
 *   git_log      recent commits (hash, author, date, subject)
 *   git_branch   list branches; with a name, switch to it, or create it (from a ref) and switch
 *   git_commit   commit what is staged, or the given paths, or everything (all)
 *   git_push     push a branch (default the current one) to a remote (default origin), setting its upstream
 */
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

const MAX_DIFF = 200_000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], timeoutMs = 60_000): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.error) throw new ToolError("failed", `git ${args[0]}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** git in this repository; a non-zero exit is a failed tool call with git's own message. */
function git(top: string, args: string[], timeoutMs?: number): string {
  const r = runGit(top, args, timeoutMs);
  if (r.code !== 0) throw new ToolError("failed", `git ${args[0]}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
  return r.stdout;
}

/** The top level of the repository that holds builder/. */
function repoRoot(ctx: ToolContext): string {
  const r = runGit(ctx.builderRoot, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new ToolError("failed", `${ctx.builderRoot} is not in a git repository: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** A ref, branch or remote given by a caller: never something git would read as an option. */
function name(value: string, what: string): string {
  if (!value.trim() || value.startsWith("-") || /[\0\n]/.test(value)) throw new ToolError("invalid", `${what} "${value}" is not a ${what}`);
  return value;
}

function currentBranch(top: string): string | null {
  const r = runGit(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

const Paths = Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Pathspecs, relative to the repository's top level" }));

export interface StatusFile {
  /** The two-letter porcelain status: index then working tree (`M `, ` M`, `??`, `R `). */
  status: string;
  path: string;
  /** Renames and copies: where it came from. */
  from?: string;
}

/** `git status --porcelain=v1 -b -z`, parsed. */
export function parseStatus(out: string): { branch: string | null; upstream: string | null; ahead: number; behind: number; files: StatusFile[] } {
  const parts = out.split("\0");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: StatusFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("## ")) {
      const head = p.slice(3);
      const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      branch = m && !m[1].startsWith("HEAD (no branch)") ? m[1] : null;
      upstream = m?.[2] ?? null;
      ahead = Number(/ahead (\d+)/.exec(m?.[3] ?? "")?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(m?.[3] ?? "")?.[1] ?? 0);
      continue;
    }
    const status = p.slice(0, 2);
    const path = p.slice(3);
    if (status[0] === "R" || status[0] === "C") files.push({ status, path, from: parts[++i] });
    else files.push({ status, path });
  }
  return { branch, upstream, ahead, behind, files };
}

const gitStatus = defineTool({
  name: "git_status",
  group: "git",
  description: "git status of this repository (the one that holds builder/): the branch, its upstream, commits ahead and behind, and every changed or untracked file.",
  params: Type.Object({}, { additionalProperties: false }),
  run: async (_a: Record<string, never>, ctx: ToolContext) => {
    const top = repoRoot(ctx);
    const s = parseStatus(git(top, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]));
    return { root: top, ...s, clean: s.files.length === 0 };
  },
});

const gitDiff = defineTool({
  name: "git_diff",
  group: "git",
  description: "git diff of this repository: the working tree against the index, the index against HEAD (staged), or the working tree against a ref. Optionally only some paths, or only a stat. Long diffs are cut at maxBytes.",
  params: Type.Object(
    {
      staged: Type.Optional(Type.Boolean({ description: "The index against HEAD (what git_commit would commit)" })),
      ref: Type.Optional(Type.String({ description: "Compare against this commit, branch or tag" })),
      paths: Paths,
      stat: Type.Optional(Type.Boolean({ description: "Only the stat: files and lines changed" })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1000, maximum: 2_000_000, description: `Default ${MAX_DIFF}` })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { staged?: boolean; ref?: string; paths?: string[]; stat?: boolean; maxBytes?: number }, ctx: ToolContext) => {
    const top = repoRoot(ctx);
    const args = ["diff", "--no-color", "--no-ext-diff", ...(a.staged ? ["--cached"] : []), ...(a.stat ? ["--stat"] : []), ...(a.ref ? [name(a.ref, "ref")] : []), "--", ...(a.paths ?? [])];
    const diff = git(top, args);
    const max = a.maxBytes ?? MAX_DIFF;
    const truncated = Buffer.byteLength(diff) > max;
    return { diff: truncated ? Buffer.from(diff).subarray(0, max).toString("utf8") : diff, bytes: Buffer.byteLength(diff), truncated };
  },
});

const gitLog = defineTool({
  name: "git_log",
  group: "git",
  description: "Recent commits of this repository, newest first: hash, author, date and subject. Optionally from a ref and only those touching some paths.",
  params: Type.Object(
    { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Default 20" })), ref: Type.Optional(Type.String({ description: "Start from this commit, branch or tag (default HEAD)" })), paths: Paths },
    { additionalProperties: false },
  ),
  run: async (a: { limit?: number; ref?: string; paths?: string[] }, ctx: ToolContext) => {
    const top = repoRoot(ctx);
    const out = git(top, ["log", "--no-color", `--max-count=${a.limit ?? 20}`, "--format=%H%x1f%an%x1f%aI%x1f%s%x1e", ...(a.ref ? [name(a.ref, "ref")] : []), "--", ...(a.paths ?? [])]);
    const commits = out
      .split("\x1e")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [hash, author, date, subject] = l.split("\x1f");
        return { hash, author, date, subject };
      });
    return { root: top, commits };
  },
});

const gitBranch = defineTool({
  name: "git_branch",
  group: "git",
  description: "Branches of this repository. Without a name: list them, with the current one and each upstream. With a name: switch to that branch, or with create: true create it (from a ref, default HEAD) and switch to it. Uncommitted changes go along, as git switch does; git refuses a switch that would lose them.",
  params: Type.Object(
    {
      name: Type.Optional(Type.String({ minLength: 1, description: "The branch to switch to or create" })),
      create: Type.Optional(Type.Boolean({ description: "Create the branch" })),
      from: Type.Optional(Type.String({ description: "create: the commit, branch or tag to start from (default HEAD)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { name?: string; create?: boolean; from?: string }, ctx: ToolContext) => {
    const top = repoRoot(ctx);
    if (!a.name) {
      if (a.create || a.from) throw new ToolError("invalid", "git_branch: create and from need a name");
      const branches = git(top, ["branch", "--no-color", "--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)"])
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [n, head, upstream] = l.split("\x1f");
          return { name: n, current: head === "*", ...(upstream ? { upstream } : {}) };
        });
      return { root: top, current: currentBranch(top), branches };
    }
    const branch = name(a.name, "branch name");
    if (runGit(top, ["check-ref-format", "--branch", branch]).code !== 0) throw new ToolError("invalid", `"${branch}" is not a valid branch name`);
    if (a.from && !a.create) throw new ToolError("invalid", "git_branch: from needs create: true");
    git(top, a.create ? ["switch", "-c", branch, ...(a.from ? [name(a.from, "ref")] : [])] : ["switch", branch]);
    return { root: top, current: currentBranch(top), created: !!a.create };
  },
});

/** The trailers of a commit an agent makes: the run whose journal holds the calls that led to it. */
function trailers(ctx: ToolContext): string[] {
  const c = ctx.caller;
  if (c.kind !== "agent") return [];
  return [...(c.agent ? [`Builder-Agent: ${c.agent}`] : []), ...(c.runId ? [`Builder-Run: ${c.runId}`] : [])];
}

const gitCommit = defineTool({
  name: "git_commit",
  group: "git",
  description: "Commit to this repository on the current branch: what is staged, or first stage the given paths, or with all: true every change (new files included). Refused when nothing is staged. Hooks run. A commit by an agent carries Builder-Agent and Builder-Run trailers.",
  params: Type.Object(
    {
      message: Type.String({ minLength: 1, description: "The commit message: a subject line, then a blank line and a body if needed" }),
      paths: Paths,
      all: Type.Optional(Type.Boolean({ description: "Stage every change first (git add -A)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { message: string; paths?: string[]; all?: boolean }, ctx: ToolContext) => {
    const top = repoRoot(ctx);
    if (a.all && a.paths?.length) throw new ToolError("invalid", "git_commit: give paths or all, not both");
    if (a.all) git(top, ["add", "-A"]);
    else if (a.paths?.length) git(top, ["add", "-A", "--", ...a.paths]);
    if (runGit(top, ["diff", "--cached", "--quiet"]).code === 0) throw new ToolError("failed", "nothing to commit: nothing is staged (give paths, or all: true)");
    const t = trailers(ctx);
    git(top, ["commit", "-m", a.message.trim(), ...(t.length ? ["-m", t.join("\n")] : [])], 300_000);
    const hash = git(top, ["rev-parse", "HEAD"]).trim();
    const files = git(top, ["show", "--no-color", "--name-status", "--format=", hash])
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status, path: rest[rest.length - 1] };
      });
    return { root: top, commit: hash, branch: currentBranch(top), subject: a.message.trim().split("\n")[0], files };
  },
});

const gitPush = defineTool({
  name: "git_push",
  group: "git",
  description: "Push a branch of this repository (default: the current one) to a remote (default origin) and set it as the branch's upstream. Never forced: a push the remote rejects fails.",
  params: Type.Object(
    { branch: Type.Optional(Type.String({ minLength: 1 })), remote: Type.Optional(Type.String({ minLength: 1, description: "Default origin" })) },
    { additionalProperties: false },
  ),
  run: async (a: { branch?: string; remote?: string }, ctx: ToolContext) => {
    const top = repoRoot(ctx);
    const remote = name(a.remote ?? "origin", "remote");
    const branch = a.branch ? name(a.branch, "branch name") : currentBranch(top);
    if (!branch) throw new ToolError("failed", "HEAD is not on a branch: name the branch to push");
    if (runGit(top, ["remote", "get-url", remote]).code !== 0) throw new ToolError("failed", `this repository has no remote "${remote}"`);
    if (runGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0) throw new ToolError("failed", `no branch "${branch}" in this repository`);
    const r = runGit(top, ["push", "--porcelain", "--set-upstream", remote, `refs/heads/${branch}:refs/heads/${branch}`], 300_000);
    if (r.code !== 0) throw new ToolError("failed", `git push: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
    const commit = git(top, ["rev-parse", `refs/heads/${branch}`]).trim();
    return { root: top, remote, branch, commit, output: r.stdout.trim() };
  },
});

export const tools: ToolDef[] = [gitStatus, gitDiff, gitLog, gitBranch, gitCommit, gitPush];
