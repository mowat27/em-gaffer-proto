/**
 * input.repos: a workflow run's clone sources. resolveRepos (a path, area:, data:, or { from, ref } with the ref's
 * commit), resolve() pinning them for a workflow run started by an agent, and real workflow runs whose clone step
 * clones the app from a local repository: at the dispatch's base, or at a ref that becomes the job's base.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveRepos } from "../../runtime/repos.ts";
import { resolve } from "../../runtime/resolve.ts";
import { BUILDER_ROOT } from "../../runtime/root.ts";
import { createRuntime } from "../../runtime/run.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { createFixtureRepo } from "../harness/fixture-repo.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-repos");
after(() => tmp.remove());
const NO_LIMIT = { limit: { enable: ["*"], disable: [] } };

const repo = createFixtureRepo(tmp.dir, { name: "app" });
const firstBase = repo.base;
writeFileSync(join(repo.url, "src", "second.ts"), "export const second = 2;\n");
git(repo.url, ["add", "-A"]);
git(repo.url, ["commit", "-q", "-m", "A second commit"]);
const secondHead = git(repo.url, ["rev-parse", "HEAD"]).trim();

const agentics = writeTree(join(tmp.dir, "agentics"), { "agents/lab/data/repos/README.md": "x\n", "agents/lab/agent.yml": "description: a lab\n" });
const labDir = join(agentics, "agents", "lab");

describe("resolveRepos", () => {
  it("a path, area: and data: sources resolve to absolute paths; { from, ref } adds the commit the ref names now", () => {
    const c = { areas: { apps: { path: tmp.dir, write: false } }, agentDir: labDir, agentics, cwd: tmp.dir };
    assert.equal(resolveRepos(undefined, c), undefined);
    assert.deepEqual(resolveRepos({ app: repo.url }, c), { app: { from: repo.url, path: repo.url } });
    assert.deepEqual(resolveRepos({ app: "app" }, c), { app: { from: "app", path: repo.url } }, "relative to cwd");
    assert.deepEqual(resolveRepos({ app: "area:apps/app" }, c), { app: { from: "area:apps/app", path: repo.url } });
    assert.deepEqual(resolveRepos({ docs: "data:repos" }, c), { docs: { from: "data:repos", path: join(labDir, "data", "repos") } });
    assert.deepEqual(resolveRepos({ app: { from: repo.url, ref: "HEAD" } }, c), { app: { from: repo.url, path: repo.url, ref: "HEAD", base: secondHead } });
    assert.deepEqual(resolveRepos({ app: { from: repo.url, ref: firstBase.slice(0, 10) } }, c)?.app.base, firstBase);
  });

  it("says what is wrong, naming the repository", () => {
    const c = { areas: {}, cwd: tmp.dir };
    assert.throws(() => resolveRepos([] as never, c), /input\.repos: a map from repository name/);
    assert.throws(() => resolveRepos({ "a b": repo.url }, c), /input\.repos\.a b: a repository name/);
    assert.throws(() => resolveRepos({ app: 3 } as never, c), /input\.repos\.app: a path, or \{ from: <path>, ref\?/);
    assert.throws(() => resolveRepos({ app: { from: repo.url, branch: "main" } } as never, c), /input\.repos\.app: a path, or/);
    assert.throws(() => resolveRepos({ app: join(tmp.dir, "missing") }, c), /input\.repos\.app: .*missing is not a directory/);
    assert.throws(() => resolveRepos({ app: "area:apps/app" }, { ...c, owner: "agent lab" }), /input\.repos\.app: area:apps\/app: area apps is not declared by agent lab/);
    assert.throws(() => resolveRepos({ app: { from: repo.url, ref: "no-such-branch" } }, c), /input\.repos\.app: no-such-branch is not a commit in /);
  });

  it("resolve() pins them for a workflow run, with the starting agent's areas", () => {
    const parent: RunRecord = {
      id: "20261118-130000-00000a",
      parent: null,
      kind: "agent",
      spec: { agent: "lab" },
      state: "running",
      pid: 1,
      startedAt: new Date().toISOString(),
      resolved: { agent: { id: "lab", dir: labDir, ymlHash: "", defaults: [] }, mode: "interactive", cwd: tmp.dir, workspace: "none", tools: [], resources: [], argv: [], env: {}, areas: { apps: { path: tmp.dir, write: false } }, mayStart: ["*"] },
      ceiling: [],
    };
    const r = resolve({ workflow: "supabase-api-verified", input: { repos: { app: { from: "area:apps/app", ref: "HEAD" } } } }, { config: NO_LIMIT, parent, runDir: "/runs/w", agentics });
    assert.deepEqual(r.repos, { app: { from: "area:apps/app", path: repo.url, ref: "HEAD", base: secondHead } });
    assert.equal(resolve({ workflow: "supabase-api-verified" }, { config: NO_LIMIT, runDir: "/runs/w" }).repos, undefined);
  });
});

describe("the clone step with input.repos, in real workflow runs", { concurrency: true }, () => {
  const runsDir = join(tmp.dir, "runs");
  const url = (p: string) => JSON.stringify(pathToFileURL(join(BUILDER_ROOT, p)).href);
  const mod = join(tmp.dir, "clone-and-look.mts");
  writeFileSync(
    mod,
    `import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clone } from ${url("engine/steps/clone.ts")};
import { code, defineBuilder } from ${url("engine/workflow.ts")};
const head = (dir) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
export default defineBuilder({ name: "clone-and-look", provides: [], steps: [
  code("clone", clone({ repo: "app" })),
  code("look", async (ctx) => ({ base: ctx.job.dispatch.repo.base, head: head(ctx.dir), second: existsSync(join(ctx.dir, "src", "second.ts")) })),
] });
`,
  );
  const dispatch = {
    requires: [],
    repo: { url: join(tmp.dir, "not-a-repository"), base: firstBase },
    task: { sliceId: "s1", title: "CreateThing", context: "Billing", handover: false, attempt: 1 },
    slice: null,
    callback: "http://127.0.0.1:9/jobs/job-repos",
  };
  const rt = createRuntime({ runsDir, piCommand: "/bin/false" });
  const output = (id: string, step: string) => JSON.parse(readFileSync(join(runsDir, id, "context", "outputs", `${step}.json`), "utf8"));
  const jobJson = (id: string) => JSON.parse(readFileSync(join(runsDir, id, "context", "job.json"), "utf8"));

  it("a path: the app is cloned from it at the dispatch's base, instead of the dispatch's url", async () => {
    const rec = await rt.start({ workflow: mod, input: { dispatch, repos: { app: repo.url } } });
    assert.deepEqual(rec.resolved?.repos, { app: { from: repo.url, path: repo.url } });
    assert.deepEqual(await rt.wait(rec.id), { outcome: "done" });
    assert.deepEqual(output(rec.id, "clone"), { repo: "app", url: repo.url, base: firstBase, into: ".", from: repo.url });
    assert.deepEqual(output(rec.id, "look"), { base: firstBase, head: firstBase, second: false });
    assert.equal(jobJson(rec.id).dispatch.repo.base, firstBase);
    assert.deepEqual(jobJson(rec.id).repos, { app: { from: repo.url, path: repo.url } });
  });

  it("{ from, ref: HEAD }: built on what the source has committed; the job's base is that commit for every step", async () => {
    const rec = await rt.start({ workflow: mod, input: { dispatch, repos: { app: { from: repo.url, ref: "HEAD" } } } });
    assert.deepEqual(await rt.wait(rec.id), { outcome: "done" });
    assert.deepEqual(output(rec.id, "look"), { base: secondHead, head: secondHead, second: true });
    assert.equal(output(rec.id, "clone").base, secondHead);
    assert.equal(jobJson(rec.id).dispatch.repo.base, secondHead);
    assert.match(readFileSync(join(runsDir, rec.id, "log"), "utf8"), new RegExp(`base ${secondHead}`));
  });

  it("without input.repos the dispatch's url is cloned, as before; a bad source starts no run", async () => {
    const rec = await rt.start({ workflow: mod, input: { dispatch } });
    const r = await rt.wait(rec.id);
    assert.equal(r.outcome, "failed");
    assert.match((r as { reason: string }).reason, /git clone -q .*not-a-repository/);
    await assert.rejects(rt.start({ workflow: mod, input: { dispatch, repos: { app: { from: repo.url, ref: "nope" } } } }), /input\.repos\.app: nope is not a commit/);
  });
});
