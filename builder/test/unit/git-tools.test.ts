/**
 * The git group (D15) on a throwaway repository laid out like this one (a builder/ folder inside it) with a local
 * bare repository as origin: never this repository, never a real remote. The tools act on the repository that holds
 * ctx.builderRoot and nothing else; commits by an agent carry its run; pushes are never forced.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../../ops/config.ts";
import { cliContext } from "../../ops/core/context.ts";
import { parseStatus } from "../../ops/core/git.ts";
import { callTool, isToolError, type ToolContext } from "../../ops/core/tool.ts";
import { createRuntime } from "../../runtime/run.ts";
import { git, GIT_ENV, tempDir } from "../harness/util.ts";

const tmp = tempDir("builder-git-tools");
const repo = join(tmp.dir, "gaffer");
const origin = join(tmp.dir, "origin.git");
let cli: ToolContext;
let agent: ToolContext;

before(() => {
  // Commits the tools make need an identity, and nothing of this machine's git config may leak in.
  Object.assign(process.env, GIT_ENV, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  mkdirSync(join(repo, "builder"), { recursive: true });
  writeFileSync(join(repo, "builder", "a.txt"), "one\n");
  writeFileSync(join(repo, "README.md"), "repo\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "start"]);
  git(tmp.dir, ["init", "-q", "--bare", origin]);
  git(repo, ["remote", "add", "origin", origin]);
  const none = join(tmp.dir, "absent.yml");
  const config = { ...loadConfig({ packaged: none, userConfig: none, env: {} }), limit: { enable: ["git"], disable: [] } };
  const base = cliContext(config, createRuntime({ runsDir: join(tmp.dir, "runs"), piCommand: "/bin/false" }));
  cli = { ...base, builderRoot: join(repo, "builder") };
  agent = { ...cli, caller: { kind: "agent", agent: "ops", runId: "20261118-000000-abcdef", allowed: cli.caller.allowed } };
});
after(() => tmp.remove());

const call = async <T = any>(name: string, args: Record<string, unknown>, ctx = cli): Promise<T> => (await callTool(name, args, ctx)) as T;
async function failure(name: string, args: Record<string, unknown>, ctx = cli): Promise<{ code: string; message: string }> {
  const err = await callTool(name, args, ctx).catch((e: unknown) => e);
  assert.ok(isToolError(err), `expected a tool error, got ${JSON.stringify(err)}`);
  return err;
}

describe("the git tools", () => {
  it("git_status: the repository that holds builder/, its branch and changed files", async () => {
    const clean = await call("git_status", {});
    assert.deepEqual([clean.root, clean.branch, clean.upstream, clean.clean, clean.files], [git(repo, ["rev-parse", "--show-toplevel"]), "main", null, true, []]);
    writeFileSync(join(repo, "builder", "a.txt"), "two\n");
    writeFileSync(join(repo, "builder", "new file.txt"), "new\n");
    const dirty = await call("git_status", {});
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.files, [
      { status: " M", path: "builder/a.txt" },
      { status: "??", path: "builder/new file.txt" },
    ]);
  });

  it("parseStatus: renames, ahead and behind, and a detached HEAD", () => {
    const s = parseStatus("## main...origin/main [ahead 2, behind 1]\0R  new.txt\0old.txt\0 D gone.txt\0");
    assert.deepEqual(s, { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, files: [{ status: "R ", path: "new.txt", from: "old.txt" }, { status: " D", path: "gone.txt" }] });
    assert.equal(parseStatus("## HEAD (no branch)\0").branch, null);
    assert.equal(parseStatus("## No commits yet on main\0").branch, "main");
  });

  it("git_diff: the working tree, staged, a stat, against a ref; a ref that reads as an option is refused", async () => {
    const d = await call("git_diff", {});
    assert.match(d.diff, /^-one\n\+two$/m);
    assert.equal(d.truncated, false);
    assert.equal((await call("git_diff", { staged: true })).diff, "");
    assert.match((await call("git_diff", { stat: true })).diff, /builder\/a\.txt \| 2 \+-/);
    assert.match((await call("git_diff", { ref: "HEAD", paths: ["builder/a.txt"] })).diff, /\+two/);
    const opt = await failure("git_diff", { ref: "--output=/tmp/x" });
    assert.equal(opt.code, "invalid");
  });

  it("git_commit: nothing staged is refused; paths are staged and committed; an agent's commit carries its run", async () => {
    assert.match((await failure("git_commit", { message: "nothing" })).message, /^nothing to commit/);
    const outside = await failure("git_commit", { message: "outside", paths: ["../elsewhere.txt"] });
    assert.match(outside.message, /outside repository/);
    const c = await call("git_commit", { message: "Change a\n\nWhy it changed.", paths: ["builder/a.txt"] }, agent);
    assert.equal(c.branch, "main");
    assert.equal(c.subject, "Change a");
    assert.deepEqual(c.files, [{ status: "M", path: "builder/a.txt" }]);
    assert.equal(git(repo, ["log", "-1", "--format=%B"]), "Change a\n\nWhy it changed.\n\nBuilder-Agent: ops\nBuilder-Run: 20261118-000000-abcdef");
    assert.deepEqual((await call("git_status", {})).files, [{ status: "??", path: "builder/new file.txt" }], "the other file stays uncommitted");
    const all = await call("git_commit", { message: "Add the new file", all: true });
    assert.equal(git(repo, ["log", "-1", "--format=%B"]), "Add the new file", "a commit from the CLI has no trailers");
    assert.deepEqual(all.files, [{ status: "A", path: "builder/new file.txt" }]);
    assert.equal((await failure("git_commit", { message: "x", all: true, paths: ["a"] })).code, "invalid");
  });

  it("git_log: newest first, limited, by path", async () => {
    const log = await call("git_log", { limit: 2 });
    assert.deepEqual(log.commits.map((c: { subject: string }) => c.subject), ["Add the new file", "Change a"]);
    assert.match(log.commits[0].hash, /^[0-9a-f]{40}$/);
    assert.deepEqual((await call("git_log", { paths: ["README.md"] })).commits.map((c: { subject: string }) => c.subject), ["start"]);
  });

  it("git_branch: list, create from a ref and switch; bad names are refused", async () => {
    const list = await call("git_branch", {});
    assert.deepEqual([list.current, list.branches], ["main", [{ name: "main", current: true }]]);
    const made = await call("git_branch", { name: "ops/fix-1", create: true, from: "HEAD~1" });
    assert.deepEqual([made.current, made.created], ["ops/fix-1", true]);
    assert.equal(git(repo, ["log", "-1", "--format=%s"]), "Change a");
    assert.equal((await call("git_branch", { name: "main" })).current, "main");
    assert.equal((await failure("git_branch", { name: "bad..name", create: true })).code, "invalid");
    assert.equal((await failure("git_branch", { name: "-D" })).code, "invalid");
    assert.equal((await failure("git_branch", { name: "x", from: "main" })).code, "invalid");
    assert.match((await failure("git_branch", { name: "no-such-branch" })).message, /^git switch: /);
  });

  it("git_push: a branch to the local bare origin with its upstream; never forced; unknown remotes and branches fail", async () => {
    await call("git_branch", { name: "ops/fix-1" });
    writeFileSync(join(repo, "builder", "fix.txt"), "fix\n");
    await call("git_commit", { message: "Fix", all: true }, agent);
    const p = await call("git_push", {});
    assert.deepEqual([p.remote, p.branch], ["origin", "ops/fix-1"]);
    assert.equal(git(origin, ["rev-parse", "refs/heads/ops/fix-1"]), p.commit);
    assert.equal((await call("git_status", {})).upstream, "origin/ops/fix-1");
    assert.equal((await call("git_push", { branch: "main" })).commit, git(origin, ["rev-parse", "refs/heads/main"]));

    // Rewrite the pushed branch locally: the remote rejects it and nothing forces it.
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    writeFileSync(join(repo, "builder", "other.txt"), "other\n");
    await call("git_commit", { message: "Other", all: true });
    const rejected = await failure("git_push", {});
    assert.equal(rejected.code, "failed");
    assert.match(rejected.message, /rejected/);
    assert.equal(git(origin, ["log", "-1", "--format=%s", "refs/heads/ops/fix-1"]), "Fix", "the remote is unchanged");
    assert.match((await failure("git_push", { remote: "upstream" })).message, /no remote "upstream"/);
    assert.match((await failure("git_push", { branch: "nope" })).message, /no branch "nope"/);
    assert.equal((await failure("git_push", { remote: "--mirror" })).code, "invalid");
  });

  it("a builder/ outside any git repository: every tool says so", async () => {
    const lone = join(tmp.dir, "lone", "builder");
    mkdirSync(lone, { recursive: true });
    const e = await failure("git_status", {}, { ...cli, builderRoot: lone });
    assert.match(e.message, /is not in a git repository/);
  });
});
