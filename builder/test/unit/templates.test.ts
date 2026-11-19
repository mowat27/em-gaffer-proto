/** engine/templates.ts: helpers, paths, partials, NEW and CHANGED, injections, markers, determinism and skipping. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { camel, helpers, json, kebab, pascal, renderSet, snake, sqlType, tsType, type ScaffoldReport } from "../../engine/templates.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-templates");
after(() => tmp.remove());
let n = 0;
const fresh = (files: Record<string, string> = {}) => {
  const dir = join(tmp.dir, `ws-${++n}`);
  mkdirSync(dir, { recursive: true });
  return writeTree(dir, files);
};
const set = (files: Record<string, string>, kind = "state-change") => writeTree(join(tmp.dir, `set-${++n}`, kind), files);
const NEW = { verdict: "NEW" as const, partials: [] as string[] };
const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");

/** Every file under `dir` with its content. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, cardinality: "Single", ...extra });
const DATA = {
  context: "Invoicing",
  slice: "CreateClient",
  fields: [field("clientId", "UUID"), field("name", "String"), field("tags", "String", { cardinality: "List" }), field("total", "Decimal", { optional: true })],
  events: [{ name: "ClientCreated" }, { name: "ClientRenamed" }],
};

describe("helpers", () => {
  it("names in every case", () => {
    for (const [input, p, c, k, s] of [
      ["CreateClient", "CreateClient", "createClient", "create-client", "create_client"],
      ["createClient", "CreateClient", "createClient", "create-client", "create_client"],
      ["create client", "CreateClient", "createClient", "create-client", "create_client"],
      ["create-client", "CreateClient", "createClient", "create-client", "create_client"],
      ["contact_email", "ContactEmail", "contactEmail", "contact-email", "contact_email"],
      ["clientId", "ClientId", "clientId", "client-id", "client_id"],
      ["HTTPServer", "HttpServer", "httpServer", "http-server", "http_server"],
      ["Clients", "Clients", "clients", "clients", "clients"],
      ["addressLine2", "AddressLine2", "addressLine2", "address-line2", "address_line2"],
    ]) {
      assert.deepEqual([pascal(input), camel(input), kebab(input), snake(input)], [p, c, k, s], input);
    }
    assert.throws(() => pascal(undefined), /pascal: no value/);
    assert.throws(() => snake(null), /snake: no value/);
  });

  it("tsType and sqlType from a field or a type, lists, unknown types", () => {
    assert.deepEqual(["String", "UUID", "Boolean", "Int", "Long", "Double", "Decimal", "Date", "DateTime", "Custom"].map((t) => tsType(t)), [
      "string", "string", "boolean", "number", "number", "number", "number", "string", "string", "Record<string, unknown>",
    ]);
    assert.deepEqual(["String", "UUID", "Boolean", "Int", "Long", "Double", "Decimal", "Date", "DateTime", "Custom"].map((t) => sqlType(t)), [
      "TEXT", "TEXT", "BOOLEAN", "INTEGER", "BIGINT", "DOUBLE PRECISION", "NUMERIC", "DATE", "TIMESTAMP", "JSONB",
    ]);
    assert.equal(tsType(field("tags", "String", { cardinality: "List" })), "string[]");
    assert.equal(tsType("Custom", "List"), "Array<Record<string, unknown>>");
    assert.equal(sqlType(field("tags", "UUID", { cardinality: "List" })), "JSONB");
    assert.equal(tsType("uuid"), "string", "case does not matter");
    assert.equal(tsType("Money"), "unknown");
    assert.equal(sqlType("Money"), "TEXT");
    assert.throws(() => tsType({ name: "x" }), /tsType: no value/);
  });

  it("json, and the helper set is exactly the documented one", () => {
    assert.equal(json({ a: [1, "b"] }), '{"a":[1,"b"]}');
    assert.equal(json({ a: 1 }, 2), '{\n  "a": 1\n}');
    assert.equal(json(null), "null");
    assert.throws(() => json(undefined), /json: no value/);
    assert.deepEqual(Object.keys(helpers).sort(), ["camel", "json", "kebab", "pascal", "snake", "sqlType", "tsType"]);
  });
});

describe("renderSet", () => {
  it("renders paths and content with the helpers, shared and set partials (the set's win), and lists the BUILD: markers", () => {
    const shared = writeTree(join(tmp.dir, `partials-${++n}`), { "header.hbs": "// shared header for {{slice}}\n", "fields.hbs": "shared fields\n" });
    const s = set({
      "src/slices/{{context}}/{{pascal slice}}/{{pascal slice}}Command.ts.hbs":
        "{{> header}}export type {{pascal slice}}Command = {\n{{#each fields}}\n  {{camel name}}{{#if optional}}?{{/if}}: {{tsType this}};\n{{/each}}\n};\n{{> fields}}// BUILD: decide\n",
      "supabase/migrations/V1__{{snake slice}}.sql.hbs": "CREATE TABLE {{snake slice}} (\n{{#each fields}}  {{snake name}} {{sqlType this}}{{#unless @last}},{{/unless}}\n{{/each}});\n-- BUILD: primary key\n",
      "partials/fields.hbs": "{{#each fields}}{{kebab name}} {{/each}}\n",
      ".gitkeep": "",
      "README.md": "not a template",
    });
    const dir = fresh();
    const report = renderSet(s, DATA, { verdict: "NEW", dir, partials: [shared, join(s, "partials")] });
    assert.equal(report.skipped, undefined, report.skipped?.reason);
    assert.deepEqual(report.files, [
      { path: "src/slices/Invoicing/CreateClient/CreateClientCommand.ts", action: "created" },
      { path: "supabase/migrations/V1__create_client.sql", action: "created" },
    ]);
    assert.equal(
      read(dir, "src/slices/Invoicing/CreateClient/CreateClientCommand.ts"),
      "// shared header for CreateClient\nexport type CreateClientCommand = {\n  clientId: string;\n  name: string;\n  tags: string[];\n  total?: number;\n};\nclient-id name tags total \n// BUILD: decide\n",
    );
    assert.equal(read(dir, "supabase/migrations/V1__create_client.sql"), "CREATE TABLE create_client (\n  client_id TEXT,\n  name TEXT,\n  tags JSONB,\n  total NUMERIC\n);\n-- BUILD: primary key\n");
    assert.deepEqual(report.markers, [
      { path: "src/slices/Invoicing/CreateClient/CreateClientCommand.ts", line: 9, text: "// BUILD: decide" },
      { path: "supabase/migrations/V1__create_client.sql", line: 7, text: "-- BUILD: primary key" },
    ]);
    assert.deepEqual(Object.keys(tree(dir)).sort(), report.files.map((f) => f.path), "only the templates' outputs are written");
  });

  it("is deterministic: the same set and data on the same files give the same bytes and the same report", () => {
    const s = set({
      "src/{{context}}/{{pascal slice}}.ts.hbs": "{{#each fields}}{{json this}}\n{{/each}}",
      "src/{{context}}/index.ts.hbs": "// slices\n",
      "injections/a.hbs": "---\ntarget: 'src/{{@root.context}}/index.ts'\nanchor: '// slices'\nkey: \"{{name}}\"\neach: events\n---\nexport * from './{{name}}'; // {{@index}} of {{@root.slice}}\n",
    });
    const a = fresh();
    const b = fresh();
    const ra = renderSet(s, DATA, { ...NEW, dir: a });
    const rb = renderSet(s, structuredClone(DATA), { ...NEW, dir: b });
    assert.equal(ra.skipped, undefined, ra.skipped?.reason);
    assert.deepEqual(ra, rb);
    assert.deepEqual(tree(a), tree(b));
    assert.equal(read(a, "src/Invoicing/index.ts"), "// slices\nexport * from './ClientCreated'; // 0 of CreateClient\nexport * from './ClientRenamed'; // 1 of CreateClient\n");
  });

  it("never overwrites: an existing file is kept (CHANGED and NEW alike), a missing one is created", () => {
    const s = set({ "src/{{pascal slice}}/{{pascal slice}}Command.ts.hbs": "new command\n", "src/{{pascal slice}}/{{pascal slice}}.test.ts.hbs": "new test\n" });
    for (const verdict of ["CHANGED", "NEW"] as const) {
      const dir = fresh({ "src/CreateClient/CreateClientCommand.ts": "the existing command\n" });
      const report = renderSet(s, DATA, { verdict, partials: [], dir });
      assert.equal(report.verdict, verdict);
      assert.deepEqual(report.files, [
        { path: "src/CreateClient/CreateClient.test.ts", action: "created" },
        { path: "src/CreateClient/CreateClientCommand.ts", action: "kept" },
      ]);
      assert.equal(read(dir, "src/CreateClient/CreateClientCommand.ts"), "the existing command\n");
      assert.equal(read(dir, "src/CreateClient/CreateClient.test.ts"), "new test\n");
    }
  });

  it("a path segment that renders empty leaves the file out, without rendering its content", () => {
    const s = set({ "supabase/migrations/{{migration}}.hbs": "{{migrationOnly.field}}\n", "src/a.ts.hbs": "a\n" });
    const dir = fresh();
    const report = renderSet(s, { migration: "", migrationOnly: null }, { ...NEW, dir });
    assert.equal(report.skipped, undefined, report.skipped?.reason);
    assert.deepEqual(report.files, [{ path: "src/a.ts", action: "created" }]);
    assert.equal(existsSync(join(dir, "supabase")), false);
  });

  it("injections: inserted once (a second render finds the key), in order at one anchor, before or after, literal or /regex/ anchors", () => {
    const s = set({
      "injections/10-import.hbs": "---\ntarget: 'src/common/load.ts'\nanchor: '/^import \\{projections\\}/'\nposition: after\nkey: '{{pascal slice}}Projection}'\n---\nimport {{brace}}{{pascal slice}}Projection} from '../slices/{{context}}/{{pascal slice}}/{{pascal slice}}Projection';\n",
      "injections/20-register.hbs": "---\ntarget: 'src/common/load.ts'\nanchor: 'projections: projections.inline(['\nkey: '    {{name}},'\neach: events\n---\n    {{name}},\n",
      "injections/30-before.hbs": "---\ntarget: 'src/common/load.ts'\nanchor: ']),'\nposition: before\nkey: '// end of {{slice}}'\n---\n    // end of {{slice}}\n",
    });
    const base = "import {projections} from 'emmett';\n\nconst x = {\n    projections: projections.inline([\n    ]),\n};\n";
    const dir = fresh({ "src/common/load.ts": base });
    const data = { ...DATA, brace: "{" };
    const first = renderSet(s, data, { ...NEW, dir });
    assert.equal(first.skipped, undefined, first.skipped?.reason);
    assert.deepEqual(first.files, []);
    assert.deepEqual(first.injections, [
      { target: "src/common/load.ts", key: "CreateClientProjection}", action: "inserted" },
      { target: "src/common/load.ts", key: "    ClientCreated,", action: "inserted" },
      { target: "src/common/load.ts", key: "    ClientRenamed,", action: "inserted" },
      { target: "src/common/load.ts", key: "// end of CreateClient", action: "inserted" },
    ]);
    const expected =
      "import {projections} from 'emmett';\nimport {CreateClientProjection} from '../slices/Invoicing/CreateClient/CreateClientProjection';\n\nconst x = {\n    projections: projections.inline([\n    ClientCreated,\n    ClientRenamed,\n    // end of CreateClient\n    ]),\n};\n";
    assert.equal(read(dir, "src/common/load.ts"), expected);
    assert.deepEqual(first.tasks, []);

    const second = renderSet(s, data, { ...NEW, dir });
    assert.deepEqual(second.injections.map((i) => i.action), ["present", "present", "present", "present"]);
    assert.equal(read(dir, "src/common/load.ts"), expected, "idempotent");
  });

  it("injections run after the files and see the files the set just created", () => {
    const s = set({
      "src/slices/{{context}}/{{context}}Events.ts.hbs": "export type {{context}}Events =\n    | Base;\n",
      "injections/events.hbs": "---\ntarget: 'src/slices/{{@root.context}}/{{@root.context}}Events.ts'\nanchor: '/^export type \\w+Events =$/'\nkey: '| {{name}}'\neach: events\n---\n    | {{name}}\n",
    });
    const dir = fresh();
    const report = renderSet(s, DATA, { ...NEW, dir });
    assert.deepEqual(report.files, [{ path: "src/slices/Invoicing/InvoicingEvents.ts", action: "created" }]);
    assert.equal(read(dir, "src/slices/Invoicing/InvoicingEvents.ts"), "export type InvoicingEvents =\n    | ClientCreated\n    | ClientRenamed\n    | Base;\n");
  });

  it("a missing target or anchor is a task with the snippet, never an error", () => {
    const s = set({
      "injections/a.hbs": "---\ntarget: 'src/missing.ts'\nanchor: 'x'\nkey: 'A1'\n---\nconst A1 = 1;\n",
      "injections/b.hbs": "---\ntarget: 'src/there.ts'\nanchor: '/^export const registry = \\[/'\nkey: 'B1'\n---\n  B1,\n",
      "src/new.ts.hbs": "// BUILD: something\n",
    });
    const dir = fresh({ "src/there.ts": "const registry = [];\n" });
    const report = renderSet(s, DATA, { ...NEW, dir });
    assert.equal(report.skipped, undefined, report.skipped?.reason);
    assert.deepEqual(report.injections, [
      { target: "src/missing.ts", key: "A1", action: "task", reason: "the file does not exist" },
      { target: "src/there.ts", key: "B1", action: "task", reason: "no line matches the anchor /^export const registry = \\[/" },
    ]);
    assert.deepEqual(report.tasks, [
      "src/missing.ts: the file does not exist. Add this where it belongs:\nconst A1 = 1;",
      "src/there.ts: no line matches the anchor /^export const registry = \\[/. Add this where it belongs:\n  B1,",
    ]);
    assert.equal(read(dir, "src/there.ts"), "const registry = [];\n", "untouched");
    assert.deepEqual(report.files, [{ path: "src/new.ts", action: "created" }], "the rest of the scaffold still renders");
  });

  it("a render error skips the whole scaffold and writes nothing (E11)", () => {
    const dir = fresh({ "src/index.ts": "// slices\n" });
    for (const [what, files, reason] of [
      ["a missing field", { "a.ts.hbs": "ok\n", "b.ts.hbs": "{{nope}}\n" }, /^render error: b\.ts\.hbs: "nope" not defined/],
      ["a missing partial", { "a.ts.hbs": "{{> nowhere}}\n" }, /^render error: a\.ts\.hbs: The partial nowhere could not be found/],
      ["a helper on a missing field", { "a.ts.hbs": "{{pascal sliceTitle}}\n" }, /^render error: a\.ts\.hbs: pascal: no value/],
      ["a path that escapes", { "{{up}}/x.ts.hbs": "x\n" }, /is not a file name/],
      ["two templates, one output", { "{{slice}}.ts.hbs": "a\n", "CreateClient.ts.hbs": "b\n" }, /another template renders to CreateClient\.ts too/],
      ["a body without its key", { "a.ts.hbs": "ok\n", "injections/x.hbs": "---\ntarget: 'src/index.ts'\nanchor: '// slices'\nkey: 'K'\n---\nno key here\n" }, /the body does not contain its key/],
      ["an unknown front matter key", { "injections/x.hbs": "---\ntarget: 'src/index.ts'\nachor: '// slices'\nanchor: 'x'\nkey: 'K'\n---\nK\n" }, /unknown front matter key achor/],
      ["unquoted handlebars in front matter", { "injections/x.hbs": "---\ntarget: src/index.ts\nanchor: x\nkey: {{slice}}\n---\nK\n" }, /front matter/],
      ["each over a non-array", { "injections/x.hbs": "---\ntarget: 'src/index.ts'\nanchor: 'x'\nkey: 'K'\neach: slice\n---\nK\n" }, /each: slice is not an array/],
      ["a target in node_modules", { "injections/x.hbs": "---\ntarget: 'node_modules/x/index.js'\nanchor: 'x'\nkey: 'K'\n---\nK\n" }, /inside node_modules/],
    ] as [string, Record<string, string>, RegExp][]) {
      const report = renderSet(set(files), { ...DATA, up: ".." }, { ...NEW, dir });
      assert.match(report.skipped?.reason ?? "(not skipped)", reason, what);
      assert.deepEqual([report.files, report.injections, report.tasks, report.markers], [[], [], [], []], what);
      assert.deepEqual(tree(dir), { "src/index.ts": "// slices\n" }, `${what}: nothing written`);
    }
  });

  it("no set, or a set with no templates, is skipped", () => {
    const dir = fresh();
    const none = renderSet(join(tmp.dir, "nowhere", "automation"), {}, { ...NEW, dir });
    assert.deepEqual(none, { kind: "automation", verdict: "NEW", skipped: { reason: "no template set for automation" }, files: [], injections: [], tasks: [], markers: [] } satisfies ScaffoldReport);
    const empty = renderSet(set({ ".gitkeep": "", "partials/p.hbs": "x" }, "state-view"), {}, { ...NEW, dir });
    assert.equal(empty.skipped?.reason, "no template set for state-view");
  });
});
