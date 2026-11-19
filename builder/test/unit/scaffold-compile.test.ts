/**
 * The scaffold compiles before the agent fills it: for every sample dispatch whose kind has a template set, render it
 * into a snapshot workspace of the dev repository (invoice-lite, or $BUILDER_DEV_REPO) at the dispatch's base, with
 * test/golden/<dispatch>/before/ laid over it, and run `npx tsc --noEmit` there. Snapshots come from the runtime's
 * cache (<runsDir>/.snapshots: made once per commit with npm ci). Skipped, with a message, only when the repository is
 * not on this machine; a dispatch whose kind has no template set yet is skipped by name.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { devRepo, dispatchNames, hasCommit, loadDispatch, renderIntoSnapshot, setFor, typecheck } from "../harness/scaffold.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const repo = devRepo();
const tmp = tempDir("builder-scaffold-compile");
after(() => tmp.remove());

describe("scaffold compiles (tsc --noEmit in a snapshot of the dev repository)", { concurrency: 2, timeout: 900_000 }, () => {
  if (!existsSync(repo)) {
    it("the dev repository", { skip: `no dev repository at ${repo}: set $BUILDER_DEV_REPO or check out invoice-lite beside the gaffer repository` }, () => {});
    return;
  }
  it("the harness: a scaffold that compiles passes, one that does not fails with tsc's error", async () => {
    const dispatch = loadDispatch("createclient-new");
    assert.ok(hasCommit(repo, dispatch.repo.base), `${repo} does not have the dispatch's base ${dispatch.repo.base}: fetch it`);
    for (const [what, body, code] of [
      ["good", "export const probe: number = 1;\n", 0],
      ["bad", 'export const probe: number = "one";\n', 2],
    ] as const) {
      const templates = writeTree(join(tmp.dir, `templates-${what}`), { "state-change/src/slices/{{context}}/{{pascal slice}}/probe.ts.hbs": body });
      const { dir, rendered } = renderIntoSnapshot("createclient-new", join(tmp.dir, `harness-${what}`), { repo, templates });
      assert.deepEqual(rendered.report.files, [{ path: "src/slices/Invoicing/CreateClient/probe.ts", action: "created" }]);
      const result = await typecheck(dir);
      assert.equal(result.code, code, `${what}: ${result.output}`);
      if (code) assert.match(result.output, /src\/slices\/Invoicing\/CreateClient\/probe\.ts\(1,14\): error TS2322/);
    }
  });

  for (const name of dispatchNames()) {
    const dispatch = loadDispatch(name);
    const { classification, ready } = setFor(dispatch);
    if (!ready) {
      it(`${name}`, { skip: `no template set for ${classification.kind} yet` }, () => {});
      continue;
    }
    it(`${name} (${classification.kind}, ${classification.verdict}): the scaffold compiles`, async () => {
      assert.ok(hasCommit(repo, dispatch.repo.base), `${repo} does not have the dispatch's base ${dispatch.repo.base}: fetch it`);
      const { dir, rendered } = renderIntoSnapshot(name, tmp.dir, { repo });
      assert.equal(rendered.report.skipped, undefined, `the scaffold skipped: ${rendered.report.skipped?.reason}`);
      const { code, output } = await typecheck(dir);
      assert.equal(code, 0, `tsc --noEmit failed in ${dir} (KEEP_TEST_TMP=1 keeps it):\n${output}`);
    });
  }
});
