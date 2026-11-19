/**
 * The scaffold's golden files: every case in test/golden/ renders to exactly its files/ and report.json, and every
 * sample dispatch whose kind has a template set has a case. How to add one: test/harness/scaffold.ts and
 * agentics/builders/supabase-api/templates/README.md. UPDATE_GOLDEN=1 rewrites them from what the scaffold renders.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { caseDispatch, checkGolden, dispatchNames, goldenCases, loadDispatch, readTree, setFor } from "../harness/scaffold.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-golden-unit");
after(() => tmp.remove());

describe("scaffold goldens", () => {
  it("the harness: renders a case from _base/ and before/, compares files/ and report.json, and UPDATE_GOLDEN writes them", () => {
    const templates = writeTree(join(tmp.dir, "templates"), {
      "state-change/src/slices/{{context}}/{{pascal slice}}/{{pascal slice}}.ts.hbs": "// {{verdict}} {{slice}}\n// BUILD: everything\n",
      "state-change/src/slices/{{context}}/{{pascal slice}}/kept.ts.hbs": "never written\n",
      "state-change/injections/index.hbs": "---\ntarget: 'src/index.ts'\nanchor: '// slices'\nkey: '{{pascal slice}}'\n---\nimport './slices/{{context}}/{{pascal slice}}/{{pascal slice}}';\n",
    });
    const golden = writeTree(join(tmp.dir, "golden"), {
      "_base/src/index.ts": "// slices\n",
      "my-case/case.json": JSON.stringify({ dispatch: "createclient-new" }),
      "my-case/before/src/slices/Invoicing/CreateClient/kept.ts": "the earlier build\n",
    });
    const o = { golden, templates };
    assert.deepEqual(goldenCases(o), ["my-case"]);
    assert.equal(caseDispatch("my-case", o), "createclient-new");

    const missing = checkGolden("my-case", o);
    assert.deepEqual(missing.diffs.slice(0, 3), [
      "src/index.ts: created or changed by the scaffold, but not in files/",
      "src/slices/Invoicing/CreateClient/CreateClient.ts: created or changed by the scaffold, but not in files/",
      "report.json: missing",
    ]);

    checkGolden("my-case", { ...o, update: true });
    assert.deepEqual(readTree(join(golden, "my-case", "files")), {
      "src/index.ts": "// slices\nimport './slices/Invoicing/CreateClient/CreateClient';\n",
      "src/slices/Invoicing/CreateClient/CreateClient.ts": "// NEW CreateClient\n// BUILD: everything\n",
    });
    const report = JSON.parse(readFileSync(join(golden, "my-case", "report.json"), "utf8"));
    assert.deepEqual(report.files, [
      { path: "src/slices/Invoicing/CreateClient/CreateClient.ts", action: "created" },
      { path: "src/slices/Invoicing/CreateClient/kept.ts", action: "kept" },
    ]);
    assert.deepEqual(checkGolden("my-case", o).diffs, [], "a fresh golden matches");

    writeTree(golden, { "my-case/files/src/index.ts": "// slices\nsomething else\n" });
    assert.match(checkGolden("my-case", o).diffs[0], /^src\/index\.ts: differs at line 2: expected "something else", got "import /);
  });

  for (const name of goldenCases()) {
    it(`${name} renders its golden files and report`, () => {
      const { diffs, rendered } = checkGolden(name);
      assert.deepEqual(diffs, [], `${rendered.dispatch} (${rendered.classification.kind}, ${rendered.classification.verdict}):\n${diffs.join("\n")}`);
      assert.equal(rendered.report.skipped, undefined, `the scaffold skipped: ${rendered.report.skipped?.reason}`);
    });
  }

  it("every sample dispatch whose kind has a template set has a golden case", () => {
    const covered = new Set(goldenCases().map((c) => caseDispatch(c)));
    const missing = dispatchNames().filter((name) => setFor(loadDispatch(name)).ready && !covered.has(name));
    assert.deepEqual(missing, [], `add test/golden/<dispatch>/ for: ${missing.join(", ")}`);
  });
});
