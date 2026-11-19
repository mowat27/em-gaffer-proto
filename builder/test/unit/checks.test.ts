/** The commit-scope checks' build-markers check: a changed file that still holds a scaffold BUILD: marker is refused. */
import assert from "node:assert/strict";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { allChanges, runChecks } from "../../agentics/builders/supabase-api/checks.ts";
import { markersIn } from "../../engine/markers.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-checks");
after(() => tmp.remove());
let n = 0;

/** A git repository at a base commit, with a stand-in tsc that always passes (node_modules is ignored). */
function repo(): { dir: string; base: string } {
  const dir = writeTree(join(tmp.dir, `repo-${++n}`), {
    ".gitignore": "node_modules/\n",
    "src/common/loadPostgresEventstore.ts": "export {};\n",
    "src/slices/Invoicing/CreateClient/gone.ts": "// BUILD: an old marker in a file the change deletes\n",
    "node_modules/.bin/tsc": "#!/bin/sh\nexit 0\n",
  });
  chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return { dir, base: git(dir, ["rev-parse", "HEAD"]) };
}

describe("build-markers", () => {
  it("markersIn finds BUILD: as a word on any line, 1-based", () => {
    assert.deepEqual(markersIn("a\n  // BUILD: decide\n-- BUILD: columns\nREBUILD: no\nBUILD:x\n"), [
      { line: 2, text: "// BUILD: decide" },
      { line: 3, text: "-- BUILD: columns" },
      { line: 5, text: "BUILD:x" },
    ]);
  });

  it("refuses a changed file that still holds a marker, naming the lines; the learnings file and deleted files are left out", () => {
    const { dir, base } = repo();
    writeTree(dir, {
      "src/slices/Invoicing/CreateClient/CreateClientCommand.ts": "export const decide = () => {\n  // BUILD: decide. Enforce the rules\n  return [];\n};\n// BUILD: evolve\n",
      "src/slices/Invoicing/CreateClient/CreateClient.test.ts": "it('a', () => {});\n",
      "src/common/loadPostgresEventstore.ts": "export {};\n// BUILD: register the projection\n",
      "LEARNINGS.md": "- Fill every BUILD: marker the scaffold leaves.\n",
    });
    rmSync(join(dir, "src/slices/Invoicing/CreateClient/gone.ts"));
    const violations = runChecks(dir, allChanges(dir, base));
    assert.deepEqual(
      violations.map((v) => v.path),
      ["src/common/loadPostgresEventstore.ts", "src/slices/Invoicing/CreateClient/CreateClientCommand.ts"],
      JSON.stringify(violations, null, 2),
    );
    const command = violations.find((v) => v.path.endsWith("CreateClientCommand.ts"))!;
    assert.equal(
      command.reason,
      "[build-markers] 2 BUILD: marker(s) left by the scaffold — write the code each one asks for and remove the marker (line 2: // BUILD: decide. Enforce the rules; line 5: // BUILD: evolve)",
    );
  });

  it("passes once the markers are gone", () => {
    const { dir, base } = repo();
    writeTree(dir, {
      "src/slices/Invoicing/CreateClient/CreateClientCommand.ts": "export const decide = () => [];\n",
      "src/slices/Invoicing/CreateClient/CreateClient.test.ts": "it('a', () => {});\n",
    });
    assert.deepEqual(runChecks(dir, allChanges(dir, base)), []);
  });
});
