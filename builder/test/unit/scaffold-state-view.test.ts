/**
 * The state-view scaffold: its view model (names, columns, types, the upsert or a marker per event, the tests wired
 * from the specifications, the migration for NEW and CHANGED), determinism, its injections on an events file another
 * build wrote, and the CHANGED dispatches rendered at their base (no earlier build) compiling in a snapshot of the dev
 * repository. The goldens (test/golden/{clients,clientdirectory,invoices}-*) and the per-dispatch compile test cover
 * the rendered files.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { templatesDir } from "../../agentics/builders/supabase-api/builder.ts";
import type { Slice, ViewModelInput } from "../../agentics/builders/supabase-api/view-model/common.ts";
import { stateViewModel, tsLiteral } from "../../agentics/builders/supabase-api/view-model/state-view.ts";
import { modelFor, viewModelInput } from "../../agentics/builders/supabase-api/view-model.ts";
import { classifyDispatch } from "../../engine/steps/classify.ts";
import { renderSet } from "../../engine/templates.ts";
import { devRepo, dispatchNames, GOLDEN, hasCommit, loadDispatch, readTree, renderIntoSnapshot, typecheck } from "../harness/scaffold.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-state-view");
after(() => tmp.remove());
let n = 0;
const fresh = (files: Record<string, string> = {}) => writeTree(join(tmp.dir, `ws-${++n}`), files);

/** The model of a sample dispatch built in an empty workspace (or with these migrations). */
function modelOf(name: string, existingMigrations: string[] = []) {
  const d = loadDispatch(name);
  return stateViewModel({ ...viewModelInput(classifyDispatch(d), d, join(tmp.dir, "none")), existingMigrations });
}

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, cardinality: "Single", ...extra });
/** A one-read-model slice projecting one event, with these read model fields and specifications. */
function input(fields: ReturnType<typeof field>[], specifications: unknown[] = [], extra: Partial<ViewModelInput> = {}): ViewModelInput {
  const slice = {
    id: "s1",
    title: "Things",
    sliceType: "STATE_VIEW",
    readmodels: [{ id: "rm1", title: "Things", fields }],
    specifications,
  } as unknown as Slice;
  return {
    slice,
    changes: null,
    sourceEvents: [{ owner: { sliceId: "s0", title: "AddThing" }, event: { id: "e1", title: "ThingAdded", fields } }],
    context: "Stock",
    existingMigrations: [],
    verdict: "NEW",
    ...extra,
  };
}

const STATE_VIEW = dispatchNames().filter((name) => classifyDispatch(loadDispatch(name)).kind === "state-view");

describe("state-view view model", () => {
  it("names, the table and its columns, the route, and an upsert for an event that carries every field", () => {
    const m = modelOf("clients-new");
    assert.equal(m.context, "Invoicing");
    assert.equal(m.names.pascal, "Clients");
    assert.equal(m.sliceFolder, "Clients");
    assert.equal(m.eventsType, "InvoicingEvents");
    assert.equal(m.eventsModule, "InvoicingEvents");
    assert.equal(m.table, "clients");
    assert.equal(m.endpoint, "/api/query/clients-collection");
    assert.equal(m.readModel.type, "ClientsReadModel");
    assert.deepEqual(
      m.fields.map((f) => [f.prop, f.column, f.ts, f.sql, f.key, f.columnDef, f.select]),
      [
        ["clientId", "client_id", "string", "TEXT", true, "client_id     TEXT PRIMARY KEY", "'client_id as clientId'"],
        ["name", "name", "string", "TEXT", false, "name          TEXT NOT NULL", "'name'"],
        ["contactEmail", "contact_email", "string", "TEXT", false, "contact_email TEXT NOT NULL", "'contact_email as contactEmail'"],
      ],
    );
    assert.deepEqual(m.fields[0].openapi, ["type: string", "format: uuid"]);
    assert.equal(m.key?.column, "client_id");
    assert.deepEqual(m.events, [
      {
        name: "ClientCreated",
        fields: [
          { prop: "clientId", optional: false, ts: "string" },
          { prop: "name", optional: false, ts: "string" },
          { prop: "contactEmail", optional: false, ts: "string" },
        ],
        known: true,
        upsert: {
          values: [
            { prop: "client_id", value: "event.data.clientId" },
            { prop: "name", value: "event.data.name" },
            { prop: "contact_email", value: "event.data.contactEmail" },
          ],
          merge: ["'name'", "'contact_email'"],
        },
        marker: null,
      },
    ]);
    assert.equal(m.eventImport, "{ClientCreated}");
    assert.equal(m.projectionImport, "{ClientsProjection}");
    assert.deepEqual(m.migration, { file: "V1__clients.sql", create: true, columns: m.fields.map((f) => f.columnDef), alters: [] });
  });

  it("a test per specification: given data from the example rows when they map one to one, expected rows in field order", () => {
    const [both, none] = modelOf("clients-new").tests;
    assert.equal(both.title, "'List both clients'");
    assert.equal(both.givenMarker, null);
    assert.deepEqual(both.given.map((e) => e.type), ["ClientCreated", "ClientCreated"]);
    assert.deepEqual(both.given[1].data, [
      { prop: "clientId", value: "'c1a2b3c4-0000-4000-8000-000000000002'" },
      { prop: "name", value: "'The Lochside Lodge'" },
      { prop: "contactEmail", value: "'ellen@lochside.example'" },
    ]);
    assert.deepEqual(both.expected[0].map((p) => p.prop), ["clientId", "name", "contactEmail"], "the example names name first; the row follows the read model");
    assert.equal(both.thenMarker, null);
    assert.deepEqual([none.given, none.expected, none.givenMarker, none.thenMarker], [[], [], null, null], "expectEmptyList: no rows");
  });

  it("markers where judgement is needed: an event without the key, missing fields, given data the examples do not determine", () => {
    const m = modelOf("invoices-new");
    const [client, invoice] = m.events;
    assert.equal(client.upsert, null);
    assert.match(client.marker!, /^BUILD: evolve ClientCreated\. ClientCreated has no invoiceId, the key of Invoices: /);
    assert.deepEqual(invoice.upsert?.values.map((v) => v.prop), ["invoice_id", "date", "amount"]);
    assert.deepEqual(invoice.upsert?.merge, ["'date'", "'amount'"]);
    assert.match(invoice.marker!, /InvoiceCreated has no clientName or status: add client_name and status to the insert/);
    const [all, empty] = m.tests;
    assert.deepEqual(all.note, ["Given both clients and invoices ...0101, ...0102, ...0103 exist. Client name is looked up from ClientCreated by clientId."]);
    assert.match(all.givenMarker!, /^BUILD: given\. .*add events.*\(see the note\)$/);
    assert.deepEqual(all.given[1].data, [
      { prop: "invoiceId", value: "''" },
      { prop: "clientId", value: "''" },
      { prop: "amount", value: "0" },
      { prop: "date", value: "''" },
    ], "placeholders of the field types, so the test compiles");
    assert.deepEqual(all.expected[0], [
      { prop: "invoiceId", value: "'f9e8d7c6-0000-4000-8000-000000000101'" },
      { prop: "clientName", value: "'Great Glen Ltd'" },
      { prop: "date", value: "'2026-11-08'" },
      { prop: "amount", value: "1250" },
      { prop: "status", value: "'Created'" },
    ], "a Decimal example as a number, which the read model reads back as float8");
    assert.equal(all.thenMarker, null);
    assert.match(empty.givenMarker!, /^BUILD: given\./);
    assert.deepEqual(m.fields.map((f) => f.select), [
      "'invoice_id as invoiceId'",
      "'client_name as clientName'",
      "db.raw('??::text as ??', ['date', 'date'])",
      "db.raw('??::float8 as ??', ['amount', 'amount'])",
      "'status'",
    ]);
  });

  it("a slice without specifications gets one marked test per projected event", () => {
    const m = modelOf("clientdirectory-new");
    assert.equal(m.endpoint, "/api/query/clientdirectory-collection", "the verifier's route: the read model title, lowercased");
    assert.equal(m.table, "client_directory");
    assert.equal(m.eventsModule, "ReportingEvents");
    assert.equal(m.tests.length, 1);
    assert.equal(m.tests[0].title, "'projects ClientCreated'");
    assert.match(m.tests[0].givenMarker!, /^BUILD: test\. The slice has no specification/);
    assert.deepEqual(m.events[0].upsert?.merge, ["'name'"], "ClientCreated's contactEmail is not a ClientDirectory field");
  });

  it("paths follow the app: the slice folder and events file as they exist, the route modeledEndpoints.ts lists", () => {
    const i = input([field("thingId", "UUID", { idAttribute: true })]);
    const m = stateViewModel({ ...i, sliceFolder: "things", contextFiles: ["README.md", "stockEvents.ts"], modeledEndpoints: ["POST addthing", "GET query/all-things-collection", "GET query/things-collection"] });
    assert.deepEqual([m.sliceFolder, m.eventsModule, m.eventsType, m.endpoint], ["things", "stockEvents", "StockEvents", "/api/query/things-collection"]);
    const listed = stateViewModel({ ...i, modeledEndpoints: ["GET query/my-things-collection"], slice: { ...i.slice, readmodels: [{ id: "rm1", title: "My Things", fields: i.slice.readmodels![0].fields }] } });
    assert.equal(listed.endpoint, "/api/query/my-things-collection", "matched ignoring case and punctuation");
    const fallback = stateViewModel({ ...i, contextFiles: [], modeledEndpoints: [] });
    assert.deepEqual([fallback.sliceFolder, fallback.eventsModule, fallback.endpoint], ["Things", "StockEvents", "/api/query/things-collection"]);
  });

  it("types: optional, Boolean, Long, DateTime, Custom and List fields; coercion of examples, and a marker when one does not fit", () => {
    const fields = [
      field("thingId", "UUID", { idAttribute: true }),
      field("active", "Boolean"),
      field("count", "Long", { optional: true }),
      field("seenAt", "DateTime"),
      field("meta", "Custom"),
      field("tags", "String", { cardinality: "List" }),
    ];
    const spec = (examples: unknown[]) => ({ id: "x", title: "It's here", examples, given: [{ id: "e1", title: "ThingAdded", type: "EVENT" }], then: [] });
    const row = { thingId: "t1", active: "true", count: "12", seenAt: "2026-11-08T10:00:00Z", meta: '{"b":1,"a":2}', tags: ["x"] };
    const m = stateViewModel(input(fields, [spec([row]), spec([{ ...row, count: "twelve" }])]));
    assert.deepEqual(m.fields.map((f) => [f.ts, f.sql, f.columnDef]), [
      ["string", "TEXT", "thing_id TEXT PRIMARY KEY"],
      ["boolean", "BOOLEAN", "active   BOOLEAN NOT NULL"],
      ["number", "BIGINT", "count    BIGINT"],
      ["string", "TIMESTAMP", "seen_at  TIMESTAMP NOT NULL"],
      ["Record<string, unknown>", "JSONB", "meta     JSONB NOT NULL"],
      ["string[]", "JSONB", "tags     JSONB NOT NULL"],
    ]);
    assert.equal(m.fields[3].select, `db.raw(\`to_char(??, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ??\`, ['seen_at', 'seenAt'])`);
    assert.equal(m.fields[2].select, "db.raw('??::float8 as ??', ['count', 'count'])");
    assert.deepEqual(m.fields[5].openapi, ["type: array", "items:", "  type: string"]);
    const values = (row: { prop: string; value: string }[]) => Object.fromEntries(row.map((p) => [p.prop, p.value]));
    const [ok, bad] = m.tests;
    assert.equal(ok.title, "'It\\'s here'");
    assert.deepEqual(values(ok.expected[0]), { thingId: "'t1'", active: "true", count: "12", seenAt: "'2026-11-08T10:00:00.000Z'", meta: '{"b":1,"a":2}', tags: '["x"]' });
    assert.deepEqual(values(ok.given[0].data), { thingId: "'t1'", active: "true", count: "12", seenAt: "'2026-11-08T10:00:00Z'", meta: '{"b":1,"a":2}', tags: '["x"]' }, "given data as the event carries it");
    assert.equal(ok.givenMarker, null);
    assert.equal(ok.thenMarker, null);
    assert.match(bad.thenMarker!, /^BUILD: then\. The example count "twelve" is not a Long/);
    assert.deepEqual(m.events[0].upsert?.values.filter((v) => ["meta", "tags"].includes(v.prop)), [
      { prop: "meta", value: "JSON.stringify(event.data.meta)" },
      { prop: "tags", value: "JSON.stringify(event.data.tags)" },
    ]);
  });

  it("a read model without a key: no upsert, and markers to choose one", () => {
    const m = stateViewModel(input([field("name", "String")]));
    assert.equal(m.key, null);
    assert.match(m.keyMarker!, /^BUILD: key\. Things has no id field/);
    assert.match(m.events[0].marker!, /Things has no key field/);
  });

  it("events named only by a specification are typed without fields and marked", () => {
    const i = input([field("thingId", "UUID", { idAttribute: true })], [{ id: "x", title: "t", given: [{ id: "e9", title: "ThingDropped", type: "EVENT" }], then: [] }]);
    const m = stateViewModel(i);
    assert.deepEqual(m.events.map((e) => [e.name, e.known]), [["ThingAdded", true], ["ThingDropped", false]]);
    assert.match(m.events[1].marker!, /^BUILD: evolve ThingDropped\. The dispatch has no definition of ThingDropped/);
    assert.match(m.tests[0].givenMarker!, /^BUILD: given\./);
  });

  it("the migration: CREATE at the next number; for CHANGED on an earlier build, ALTER what changed; nothing when nothing did", () => {
    assert.equal(modelOf("clients-new", ["V1__schema.sql.example", "V3__other.sql", "_V0__supabase_stubs.sql"]).migration.file, "V4__clients.sql");
    const changed = modelOf("invoices-changed", ["V1__invoices.sql", "V2__other.sql"]).migration;
    assert.deepEqual(changed, { file: "V3__alter_invoices.sql", create: false, columns: [], alters: ['ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS due_date DATE;'] });
    assert.equal(modelOf("invoices-new", ["V1__invoices.sql"]).migration.file, "", "NEW on an existing table: no changes to apply");
    assert.equal(modelOf("invoices-changed").migration.file, "V1__invoices.sql", "CHANGED with no earlier migration: CREATE");

    const fields = [field("thingId", "UUID", { idAttribute: true }), field("qty", "Decimal"), field("label", "String")];
    const before = { id: "rm1", title: "Things", fields: [field("thingId", "UUID", { idAttribute: true }), field("qty", "Int"), field("old", "String")] };
    const changes = { verdict: "CHANGED" as const, since: null, elements: { changed: [{ kind: "readmodels", id: "rm1", title: "Things", before }], added: [], removed: [] } };
    assert.deepEqual(stateViewModel(input(fields, [], { existingMigrations: ["V1__things.sql"], changes, verdict: "CHANGED" })).migration.alters, [
      'ALTER TABLE "public"."things" ALTER COLUMN qty TYPE NUMERIC USING qty::NUMERIC;',
      'ALTER TABLE "public"."things" ADD COLUMN IF NOT EXISTS label TEXT;',
      'ALTER TABLE "public"."things" DROP COLUMN IF EXISTS old;',
    ]);
    const same = { ...changes, elements: { ...changes.elements, changed: [{ kind: "readmodels", id: "rm1", title: "Things", before: { ...before, fields } }] } };
    assert.equal(stateViewModel(input(fields, [], { existingMigrations: ["V2__alter_things.sql"], changes: same, verdict: "CHANGED" })).migration.file, "");
  });

  it("fails without a read model or events, so the scaffold skips and the agent builds from the skill", () => {
    const i = input([field("thingId", "UUID")]);
    assert.throws(() => stateViewModel({ ...i, slice: { ...i.slice, readmodels: [] } }), /needs a read model/);
    assert.throws(() => stateViewModel({ ...i, sourceEvents: [] }), /needs the events it projects/);
  });

  it("TypeScript literals", () => {
    assert.equal(tsLiteral("it's a \\ path\n"), "'it\\'s a \\\\ path\\n'");
    assert.equal(tsLiteral(12.5), "12.5");
    assert.equal(tsLiteral({ a: [1] }), '{"a":[1]}');
  });
});

describe("state-view scaffold", () => {
  it("is deterministic: every state-view dispatch renders the same bytes twice", () => {
    assert.ok(STATE_VIEW.length >= 6, `state-view sample dispatches: ${STATE_VIEW.join(", ")}`);
    for (const name of STATE_VIEW) {
      const d = loadDispatch(name);
      const c = classifyDispatch(d);
      const [a, b] = [fresh(), fresh()].map((dir) => {
        writeTree(dir, readTree(join(GOLDEN, "_base")));
        const report = renderSet(templatesDir(c.kind), modelFor(c, viewModelInput(c, d, dir)), { dir, verdict: c.verdict });
        return { report, files: readTree(dir) };
      });
      assert.equal(a.report.skipped, undefined, `${name}: ${a.report.skipped?.reason}`);
      assert.deepEqual(a, b, name);
    }
  });

  it("adds its events to an events file a state-change build wrote; a one-line union becomes a task", () => {
    const d = loadDispatch("invoices-new");
    const c = classifyDispatch(d);
    const header = "import type {Event} from '@event-driven-io/emmett';\n\ntype CommonMeta = {\n    correlation_id?: string;\n};\n\n";
    const created = "export type ClientCreated = Event<'ClientCreated', {\n    clientId: string;\n}, CommonMeta>;\n\n";
    const render = (union: string) => {
      const dir = writeTree(fresh(), { ...readTree(join(GOLDEN, "_base")), "src/slices/Invoicing/InvoicingEvents.ts": header + created + union });
      const report = renderSet(templatesDir(c.kind), modelFor(c, viewModelInput(c, d, dir)), { dir, verdict: c.verdict });
      return { report, events: readFileSync(join(dir, "src/slices/Invoicing/InvoicingEvents.ts"), "utf8") };
    };

    const multi = render("export type InvoicingEvents =\n    | ClientCreated;\n");
    assert.deepEqual(multi.report.tasks, []);
    assert.ok(multi.events.startsWith(header + created + "export type InvoiceCreated = Event<'InvoiceCreated', {\n    invoiceId: string;\n"), multi.events);
    assert.ok(multi.events.endsWith("}, CommonMeta>;\n\nexport type InvoicingEvents =\n    | InvoiceCreated\n    | ClientCreated;\n"), multi.events);
    assert.deepEqual(multi.report.files.find((f) => f.path.endsWith("InvoicingEvents.ts"))?.action, "kept");

    const legacy = render("export type InvoicingEvents = ClientCreated;\n");
    assert.deepEqual(legacy.report.injections.filter((i) => i.action === "task").map((i) => i.key), ["| ClientCreated", "| InvoiceCreated"]);
    assert.match(legacy.events, /export type InvoiceCreated = Event<'InvoiceCreated'/, "the type still goes in");
  });
});

describe("state-view CHANGED at the base compiles (tsc --noEmit in a snapshot of the dev repository)", { concurrency: 2, timeout: 600_000 }, () => {
  const repo = devRepo();
  const cases = ["clients-changed-at-base", "clientdirectory-changed-at-base", "invoices-changed-at-base"];
  for (const name of cases) {
    it(name, { skip: existsSync(repo) ? false : `no dev repository at ${repo}: set $BUILDER_DEV_REPO or check out invoice-lite beside the gaffer repository` }, async () => {
      const dispatch = loadDispatch(JSON.parse(readFileSync(join(GOLDEN, name, "case.json"), "utf8")).dispatch);
      assert.ok(hasCommit(repo, dispatch.repo.base), `${repo} does not have the dispatch's base ${dispatch.repo.base}: fetch it`);
      const parent = join(tmp.dir, "compile");
      mkdirSync(parent, { recursive: true });
      const { dir, rendered } = renderIntoSnapshot(name, parent, { repo });
      assert.equal(rendered.report.skipped, undefined, `the scaffold skipped: ${rendered.report.skipped?.reason}`);
      assert.ok(rendered.report.files.every((f) => f.action === "created"), "no earlier build at the base: every file is new");
      const { code, output } = await typecheck(dir);
      assert.equal(code, 0, `tsc --noEmit failed in ${dir} (KEEP_TEST_TMP=1 keeps it):\n${output}`);
    });
  }
});
