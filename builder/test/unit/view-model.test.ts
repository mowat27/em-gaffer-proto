/** The supabase-api view model's dispatcher and shared parts: the input it gathers, the kind it picks, names, migrations. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { names, nextMigrationNumber } from "../../agentics/builders/supabase-api/view-model/common.ts";
import { modelFor, viewModelInput } from "../../agentics/builders/supabase-api/view-model.ts";
import { classifyDispatch } from "../../engine/steps/classify.ts";
import { loadDispatch } from "../harness/scaffold.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-view-model");
after(() => tmp.remove());

describe("view model", () => {
  it("gathers the input: the slice, changes, source events, the context folder as it exists, the migrations", () => {
    const d = loadDispatch("clients-new");
    const c = classifyDispatch(d);
    const app = writeTree(join(tmp.dir, "app"), {
      "src/slices/invoicing/Other/x.ts": "",
      "supabase/migrations/V2__b.sql": "",
      "supabase/migrations/_V0__supabase_stubs.sql": "",
      "supabase/migrations/V1__schema.sql.example": "",
    });
    const input = viewModelInput(c, d, app);
    assert.equal(input.context, "invoicing", "the existing folder's spelling wins over the dispatch's Invoicing");
    assert.deepEqual(input.existingMigrations, ["V1__schema.sql.example", "V2__b.sql", "_V0__supabase_stubs.sql"]);
    assert.equal(input.slice, d.slice);
    assert.equal(input.changes?.verdict, "NEW");
    assert.equal(input.sourceEvents.length, (d.sourceEvents ?? []).length);
    assert.ok(input.sourceEvents.length > 0);
    assert.equal(input.verdict, "NEW");

    const bare = join(tmp.dir, "bare");
    mkdirSync(bare);
    const cc = loadDispatch("createclient-changed");
    const i2 = viewModelInput(classifyDispatch(cc), cc, bare);
    assert.equal(i2.context, "Invoicing", "no folder yet: the dispatch's context");
    assert.deepEqual(i2.existingMigrations, []);
    assert.deepEqual(i2.sourceEvents, [], "a state-change dispatch has none");
    assert.equal(i2.verdict, "CHANGED");
    assert.equal(viewModelInput(classifyDispatch(cc), { slice: cc.slice }, bare).changes, null);
  });

  it("gathers the slice folder ignoring case, the context folder's files and the app's modeled endpoints", () => {
    const d = loadDispatch("createinvoice-new");
    const c = classifyDispatch(d);
    const app = writeTree(join(tmp.dir, "app2"), {
      "src/slices/invoicing/createinvoice/routes.ts": "",
      "src/slices/invoicing/invoicingEvents.ts": "",
      "src/slices/invoicing/README.md": "",
      "src/common/modeledEndpoints.ts": "// 'POST commented'\nexport const MODELED_ENDPOINTS: string[] = [\n    'GET query/invoices-collection',\n    // 'POST old',\n    'POST createinvoice',\n];\n",
    });
    const input = viewModelInput(c, d, app);
    assert.equal(input.sliceFolder, "createinvoice", "the existing folder's spelling wins over the dispatch's CreateInvoice");
    assert.deepEqual(input.contextFiles, ["README.md", "invoicingEvents.ts"]);
    assert.deepEqual(input.modeledEndpoints, ["GET query/invoices-collection", "POST createinvoice"]);

    const bare = join(tmp.dir, "bare2");
    mkdirSync(bare);
    const none = viewModelInput(c, d, bare);
    assert.deepEqual([none.sliceFolder, none.contextFiles, none.modeledEndpoints], ["CreateInvoice", [], []], "no folders and no file: the title in PascalCase, nothing listed");
  });

  it("picks the kind's function; kinds without a model throw", () => {
    const d = loadDispatch("createclient-new");
    const c = classifyDispatch(d);
    const input = viewModelInput(c, d, tmp.dir);
    assert.deepEqual(
      { ...modelFor(c, input) },
      { ...modelFor(c, input) },
      "pure",
    );
    const m = modelFor(c, input) as unknown as Record<string, unknown>;
    assert.equal(m.context, "Invoicing");
    assert.equal(m.slice, "CreateClient");
    assert.equal(m.verdict, "NEW");
    for (const kind of ["automation", "webhook", "translation"] as const) assert.throws(() => modelFor({ ...c, kind }, input), new RegExp(`no view model for ${kind} slices`));
  });

  it("names in every case, and the next migration number", () => {
    assert.deepEqual(names("ClientDirectory"), { raw: "ClientDirectory", pascal: "ClientDirectory", camel: "clientDirectory", kebab: "client-directory", snake: "client_directory" });
    assert.equal(nextMigrationNumber([]), 1);
    assert.equal(nextMigrationNumber(["_V0__supabase_stubs.sql", "V1__schema.sql.example"]), 1, "only V{n}__*.sql counts");
    assert.equal(nextMigrationNumber(["V1__clients.sql", "V10__x.sql", "V9__y.sql"]), 11);
  });
});
