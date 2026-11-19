/**
 * The state-change scaffold: its view model (view-model/state-change.ts) and its template set (templates/state-change/).
 * The goldens (scaffold-golden.test.ts) pin the rendered bytes of every sample dispatch; this file pins the rules
 * behind them, determinism, and that the injections into an existing events file compile.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { stateChangeModel, type StateChangeModel } from "../../agentics/builders/supabase-api/view-model/state-change.ts";
import type { Slice, ViewModelInput } from "../../agentics/builders/supabase-api/view-model/common.ts";
import { devRepo, hasCommit, loadDispatch, readTree, renderCase, renderIntoSnapshot, typecheck } from "../harness/scaffold.ts";
import { tempDir } from "../harness/util.ts";

const tmp = tempDir("builder-state-change");
after(() => tmp.remove());

/** invoice-lite's src/common/modeledEndpoints.ts at the dispatches' base. */
const MODELED = ["GET query/clients-collection", "GET query/invoices-collection", "POST createclient", "POST createinvoice"];
const input = (slice: Slice, extra: Partial<ViewModelInput> = {}): ViewModelInput => ({ slice, changes: null, sourceEvents: [], context: "Invoicing", existingMigrations: [], verdict: "NEW", modeledEndpoints: MODELED, ...extra });
const model = (name: string): StateChangeModel => stateChangeModel(input(loadDispatch(name).slice as Slice));
const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, cardinality: "Single", ...extra });

describe("state-change view model", () => {
  it("names, the command, the route from the app's modeled endpoint and its OpenAPI body from the fields", () => {
    const m = model("createclient-new");
    assert.equal(m.commandType, "CreateClientCommand");
    assert.equal(m.handleName, "handleCreateClient");
    assert.equal(m.sliceFolder, "CreateClient");
    assert.equal(m.eventsModule, "InvoicingEvents");
    assert.equal(m.eventsType, "InvoicingEvents");
    assert.deepEqual(m.command.fields.map((f) => `${f.prop}: ${f.ts}`), ["clientId: string", "name: string", "contactEmail: string"]);
    assert.equal(m.route.modeled, "POST createclient");
    assert.equal(m.route.path, "/api/createclient/:clientId");
    assert.equal(m.route.openapiPath, "/api/createclient/{clientId}");
    assert.deepEqual(m.route.paramSchema, ["type: string", "format: uuid"]);
    assert.deepEqual(m.route.required, ["name", "contactEmail"]);
    assert.deepEqual(m.route.body.map((b) => [b.name, b.access, b.schema]), [
      ["name", "req.body?.name", ["type: string", "example: Great GlenLtd"]],
      ["contactEmail", "req.body?.contactEmail", ["type: string"]],
    ]);
    assert.deepEqual(m.route.data.map((d) => `${d.prop}: ${d.value}`), ["clientId: id", "name: req.body?.name", "contactEmail: req.body?.contactEmail"]);
    assert.equal(m.route.marker, null);
  });

  it("the route is POST /api/{kebab-case slice}/:{generated id} only when the app lists no endpoint for the slice", () => {
    const slice = loadDispatch("createclient-new").slice as Slice;
    for (const modeledEndpoints of [[], undefined, ["POST createinvoice", "GET query/createclient-collection"]]) {
      const m = stateChangeModel(input(slice, { modeledEndpoints }));
      assert.equal(m.route.modeled, null);
      assert.equal(m.route.path, "/api/create-client/:clientId");
      assert.equal(m.route.openapiPath, "/api/create-client/{clientId}");
    }
    assert.equal(stateChangeModel(input(slice, { modeledEndpoints: ["POST create-client"] })).route.path, "/api/create-client/:clientId", "a hyphenated entry is matched too");
  });

  it("follows the app's folders: the slice folder it has, and the context's events file it has", () => {
    const slice = loadDispatch("createinvoice-new").slice as Slice;
    const m = stateChangeModel(input(slice, { context: "invoicing", sliceFolder: "createinvoice", contextFiles: ["README.md", "invoicingEvents.ts"] }));
    assert.equal(m.sliceFolder, "createinvoice");
    assert.equal(m.eventsModule, "invoicingEvents");
    assert.equal(m.eventsType, "InvoicingEvents");
    const both = stateChangeModel(input(slice, { contextFiles: ["AEvents.ts", "InvoicingEvents.ts"] }));
    assert.equal(both.eventsModule, "InvoicingEvents", "the context's own name wins");
    const none = stateChangeModel(input(slice, { context: "invoicing" }));
    assert.deepEqual([none.sliceFolder, none.eventsModule, none.eventsType], ["CreateInvoice", "InvoicingEvents", "InvoicingEvents"]);
  });

  it("decide emits each event field from the command field of the same name; each SPEC_ERROR is a code, a message and a marker", () => {
    const m = model("createclient-new");
    assert.deepEqual(m.emits.map((e) => [e.type, e.data.map((d) => `${d.prop}: ${d.value}`)]), [
      ["ClientCreated", ["clientId: command.data.clientId", "name: command.data.name", "contactEmail: command.data.contactEmail"]],
    ]);
    assert.deepEqual(m.errors.map((e) => [e.codeLiteral, e.messageLiteral, e.doc]), [
      ["'empty_name_is_rejected'", "'Client name is required'", "empty_name_is_rejected: Client name is required"],
      ["'invalid_contact_email_is_rejected'", "'Contact email must be a valid email address'", "invalid_contact_email_is_rejected: Contact email must be a valid email address"],
    ]);
    assert.equal(m.markers.decide.length, 2);
    assert.match(m.markers.decide[0], /^BUILD: decide\. "Empty name is rejected": throw \{code: 'empty_name_is_rejected', message: 'Client name is required'\}/);
    assert.equal(m.markers.state, null, "no given events: nothing to judge in the state");
    assert.equal(m.markers.evolve, null);
    assert.equal(m.markers.handle, null);
  });

  it("one test per specification: events, a thrown code, or nothing; markers only where a value needs judgement", () => {
    const m = model("createclient-new");
    assert.deepEqual(m.tests.map((t) => [t.titleLiteral, t.outcome, t.errorCodeLiteral]), [
      ["'spec: Create a client'", "events", null],
      ["'spec: Empty name is rejected'", "throws", "'empty_name_is_rejected'"],
      ["'spec: Invalid contact email is rejected'", "throws", "'invalid_contact_email_is_rejected'"],
    ]);
    const [create, empty] = m.tests;
    assert.deepEqual(create.command.map((d) => `${d.prop}: ${d.value}`), ["clientId: '00000000-0000-4000-8000-000000000001'", "name: 'Great GlenLtd'", "contactEmail: '<contactEmail>'"]);
    assert.deepEqual(create.then[0].data, create.command, "the event repeats the command's values");
    assert.deepEqual(create.markers, ["BUILD: test data. The specification gives no example for contactEmail: replace the placeholders with values that fit it."]);
    assert.equal(empty.command[1].value, "'Great GlenLtd'", "another specification's example is a better start than a placeholder");
    assert.deepEqual(empty.markers, ['BUILD: test data. Give the command values that break only "Empty name is rejected" (Client name is required).']);
  });

  it("events of other slices: a stub type with a marker, a cast in the tests, and state, evolve and handle markers", () => {
    const m = model("createinvoice-new");
    assert.deepEqual(m.eventTypes.map((e) => [e.name, e.foreign, e.fields.length]), [["InvoiceCreated", false, 4], ["ClientCreated", true, 0]]);
    assert.match(m.foreignEvents[0].typeMarker ?? "", /^BUILD: event type\. ClientCreated is used by the CreateInvoice specifications but defined by another slice/);
    const [create, unknown] = m.tests;
    assert.deepEqual(create.given.map((g) => [g.type, g.foreign, g.data]), [["ClientCreated", true, []]]);
    assert.deepEqual(create.command.map((d) => d.value), ["'00000000-0000-4000-8000-000000000001'", "'00000000-0000-4000-8000-000000000002'", "1", "'2026-01-01'"]);
    assert.deepEqual(create.markers, [
      "BUILD: test data. The specification gives no example for amount and date: replace the placeholders with values that fit it.",
      "BUILD: test data. ClientCreated is defined by another slice: fill its data with the fields of its type.",
    ]);
    assert.deepEqual(unknown.given, []);
    assert.match(m.markers.state ?? "", /^BUILD: state\. .*\(ClientCreated\)/);
    assert.match(m.markers.evolve ?? "", /^BUILD: evolve\. Fold ClientCreated into the state/);
    assert.match(m.markers.handle ?? "", /^BUILD: handle\. ClientCreated comes from another slice/);
  });

  it("a field decide cannot copy gets a value of its type and a marker; no ID field, errors or events are handled", () => {
    const slice = structuredClone(loadDispatch("createclient-new").slice) as Slice;
    const command = slice.commands![0];
    command.fields = [field("clientId", "UUID", { idAttribute: true }), field("name", "String", { optional: true }), field("score", "Int"), field("Contact Email", "String")];
    slice.events![0].fields = [field("clientId", "UUID"), field("name", "String"), field("score", "String"), field("status", "String"), field("tags", "String", { cardinality: "List", optional: true })];
    slice.specifications = [];
    const m = stateChangeModel(input(slice));
    assert.deepEqual(m.emits[0].data.map((d) => [d.prop, d.value, !!d.marker]), [
      ["clientId", "command.data.clientId", false],
      ["name", "command.data.name ?? ''", true],
      ["score", "''", true],
      ["status", "''", true],
      ["tags", "[]", true],
    ]);
    assert.deepEqual(m.command.fields.map((f) => f.prop), ["clientId", "name", "score", "contactEmail"], "a name that is not an identifier is camelCased");
    assert.equal(m.route.path, "/api/createclient/:clientId", "no generated field: the ID attribute");
    assert.deepEqual(m.route.required, ["score", "contactEmail"], "the body's keys");
    assert.deepEqual(m.errors, []);
    assert.deepEqual(m.markers.decide, []);
    assert.deepEqual(m.tests, []);

    for (const f of command.fields) f.idAttribute = false;
    const bare = stateChangeModel(input(slice));
    assert.equal(bare.route.path, "/api/createclient/:id");
    assert.match(bare.route.marker ?? "", /^BUILD: route\. CreateClient has no generated ID field/);
  });

  it("is pure: the same input gives the same model and the input is not changed", () => {
    const slice = loadDispatch("createinvoice-changed").slice as Slice;
    const before = structuredClone(slice);
    assert.deepEqual(stateChangeModel(input(slice)), stateChangeModel(input(slice)));
    assert.deepEqual(slice, before);
  });
});

describe("state-change template set", () => {
  it("is deterministic: the same dispatch renders the same bytes, and a second render on its output changes nothing", () => {
    const a = renderCase("createinvoice-new", join(tmp.dir, "a"));
    const b = renderCase("createinvoice-new", join(tmp.dir, "b"));
    assert.equal(a.report.skipped, undefined);
    assert.deepEqual(a.outputs, b.outputs);
    assert.deepEqual(a.report, b.report);

    const before = readTree(join(tmp.dir, "a"));
    const again = renderCase("createinvoice-new", join(tmp.dir, "a"));
    assert.deepEqual(readTree(join(tmp.dir, "a")), before);
    assert.ok(again.report.files.every((f) => f.action === "kept"));
    assert.ok(again.report.injections.every((i) => i.action === "present"));
    assert.deepEqual(again.report.markers, []);
  });

  const repo = devRepo();
  it("injections into an existing events file compile (createinvoice-after-createclient, tsc --noEmit in a snapshot)", { skip: existsSync(repo) ? false : `no dev repository at ${repo}`, timeout: 600_000 }, async () => {
    assert.ok(hasCommit(repo, loadDispatch("createinvoice-new").repo.base), `${repo} does not have the dispatch's base: fetch it`);
    const { dir, rendered } = renderIntoSnapshot("createinvoice-after-createclient", tmp.dir, { repo });
    assert.deepEqual(rendered.report.injections.map((i) => i.action), ["inserted", "present", "inserted", "present"]);
    const { code, output } = await typecheck(dir);
    assert.equal(code, 0, `tsc --noEmit failed in ${dir}:\n${output}`);
  });
});
