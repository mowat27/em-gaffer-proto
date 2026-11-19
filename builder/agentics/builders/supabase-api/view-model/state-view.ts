/**
 * The state-view view model: what templates/state-view/ renders from (README.md next to the templates).
 *
 * A state view projects events into one read model table. Everything that follows from the slice alone is computed
 * here, so the templates only lay it out: names, the table and its snake_case columns, the TypeScript and SQL types,
 * the GET route and its OpenAPI schema, the event types for the context's events file, an upsert per event that
 * carries the read model's key, and one test per specification with its given events and expected rows wired from the
 * examples. What needs judgement becomes a `BUILD:` marker text: an event the upsert cannot cover, given data the
 * examples do not determine. Pure: same input, same model.
 *
 * Paths follow the app: the slice folder and the context's events file as they exist, and the route the app's
 * modeledEndpoints.ts lists for the read model (`GET query/clients-collection`). A read model the app does not list
 * falls back to GET /api/query/{read model title, lowercased}-collection, the verifier's convention.
 */
import { camel, pascal, snake, sqlType, tsType } from "../../../../engine/templates.ts";
import { normalize } from "../checks.ts";
import {
  baseModel,
  eventsFileOf,
  names,
  nextMigrationNumber,
  type BaseModel,
  type Names,
  type SliceElement,
  type SliceField,
  type Specification,
  type SpecificationStep,
  type ViewModelInput,
} from "./common.ts";

/** A read model field, ready for every place it shows up. */
export interface ViewField {
  /** The name as the slice spells it. */
  name: string;
  /** The TypeScript property: the name, or its camelCase when it is not an identifier. */
  prop: string;
  /** The snake_case column. */
  column: string;
  type: string;
  cardinality: string;
  optional: boolean;
  /** The read model's key (its first idAttribute field). */
  key: boolean;
  /** The TypeScript type (`ts`) and the column type (`sql`): not tsType and sqlType, which are helpers in a template. */
  ts: string;
  sql: string;
  /** The column's definition in CREATE TABLE, padded so the types line up. */
  columnDef: string;
  /** The knex select item that reads the column as the field (dates as text, BIGINT and NUMERIC as numbers). */
  select: string;
  /** The field's OpenAPI schema lines. */
  openapi: string[];
}

/** One property of an object literal: the property and its TypeScript literal. */
export interface Prop {
  prop: string;
  value: string;
}

/** An event the projection handles. */
export interface ProjectedEvent {
  /** The event type, also its TypeScript type name. */
  name: string;
  /** The event's fields, from its definition in sourceEvents. */
  fields: { prop: string; optional: boolean; ts: string }[];
  /** False when the dispatch has no definition for it (only a specification or a dependency names it). */
  known: boolean;
  /** The upsert when the event carries the read model's key, else null. */
  upsert: { values: Prop[]; merge: string[] } | null;
  /** The evolve case's BUILD: marker text, or null when the upsert is all it needs. */
  marker: string | null;
}

/** A given or when event of a test. */
export interface TestEvent {
  type: string;
  data: Prop[];
}

/** One test: a specification, or (for a slice without specifications) one projected event. */
export interface TestCase {
  /** The `it` title, as a TypeScript string literal. */
  title: string;
  /** The specification's note, as comment lines. */
  note: string[];
  /** BUILD: marker text for the given and when events, or null when they are complete. */
  givenMarker: string | null;
  given: TestEvent[];
  when: TestEvent[];
  /** BUILD: marker text for the expected rows, or null when the examples give them. */
  thenMarker: string | null;
  /** The rows the table must hold afterwards. */
  expected: Prop[][];
}

export interface StateViewModel extends BaseModel {
  /** The slice in every case: the projection's names. */
  names: Names;
  /** The slice folder under the context folder (ViewModelInput.sliceFolder). */
  sliceFolder: string;
  /** The context's events file without `.ts` (`InvoicingEvents`, or the spelling that exists) and its union type. */
  eventsModule: string;
  eventsType: string;
  /** The read model: its title, the row type (`ClientsReadModel`), its description lines for OpenAPI. */
  readModel: { title: string; type: string; summary: string; description: string };
  /** The table: snake_case of the read model's title. */
  table: string;
  /** The GET route: the one modeledEndpoints.ts lists for the read model, else /api/query/{read model title, lowercased}-collection. */
  endpoint: string;
  fields: ViewField[];
  /** The key field, or null when the read model has none. */
  key: ViewField | null;
  /** BUILD: marker text when the read model has no key field. */
  keyMarker: string | null;
  /** BUILD: marker text when the slice has further read models, which the scaffold leaves to the agent. */
  otherReadModelsMarker: string | null;
  events: ProjectedEvent[];
  /** The projection's own event union (`ClientsEvents`). */
  projectionEvents: string;
  /** Import lists, braces included (a template cannot write `{` before `{{`): `{ClientCreated, InvoiceCreated}`, `{ClientsProjection}`. */
  eventImport: string;
  projectionImport: string;
  tests: TestCase[];
  migration: {
    /** `V{n}__{table}.sql`, `V{n}__alter_{table}.sql`, or "" when no migration is needed. */
    file: string;
    /** CREATE TABLE (true) or ALTER TABLE (false). */
    create: boolean;
    /** CREATE TABLE: the column definitions. */
    columns: string[];
    /** ALTER TABLE: the statements. */
    alters: string[];
  };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const kindOf = (f: { type?: string }) => String(f.type ?? "").toLowerCase();
const isList = (f: { cardinality?: string }) => String(f.cardinality ?? "").toLowerCase() === "list";
const propOf = (name: string) => (IDENT.test(name) ? name : camel(name));
const fieldsOf = (e: { fields?: SliceField[] } | undefined): SliceField[] => (Array.isArray(e?.fields) ? e.fields : []);
const isEvent = (s: SpecificationStep) => String(s.type ?? "").toUpperCase() === "EVENT";
/** `a`, `a or b`, `a, b or c` (or `and`). */
const words = (xs: string[], conj = "or") => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${conj} ${xs[xs.length - 1]}`);

/** A TypeScript literal for a value: strings in single quotes, objects and arrays as JSON. */
export function tsLiteral(v: unknown): string {
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
  if (v === undefined) return "undefined";
  return JSON.stringify(v);
}

/** A YAML scalar for an OpenAPI line: plain when safe, else single-quoted. */
function yamlScalar(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return /^[A-Za-z0-9][\w .,()/-]*$/.test(one) && !/ #|: /.test(one) ? one : `'${one.replace(/'/g, "''")}'`;
}

/** The OpenAPI schema lines of a field type (the build-state-view table). */
function openapiType(f: SliceField): string[] {
  const t = kindOf(f);
  const base: Record<string, string[]> = {
    string: ["type: string"],
    uuid: ["type: string", "format: uuid"],
    int: ["type: integer", "format: int32"],
    long: ["type: integer", "format: int64"],
    double: ["type: number", "format: double"],
    decimal: ["type: number"],
    boolean: ["type: boolean"],
    date: ["type: string", "format: date"],
    datetime: ["type: string", "format: date-time"],
    custom: ["type: object"],
  };
  const lines = base[t] ?? ["type: string"];
  if (!isList(f)) return lines;
  return ["type: array", "items:", ...lines.map((l) => `  ${l}`)];
}

/**
 * A value coerced to a field's TypeScript type, or `{ ok: false }` when it does not fit. Numbers from numeric strings,
 * booleans from "true"/"false", objects and lists from JSON text; DateTime normalized to how the read model reads it
 * back (`YYYY-MM-DDTHH:MM:SS.mmmZ`, the wall clock as written) when `forRow`.
 */
function coerce(f: SliceField, raw: unknown, forRow: boolean): { ok: true; value: unknown } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  const t = kindOf(f);
  if (isList(f) || t === "custom") {
    let v = raw;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        return { ok: false };
      }
    }
    if (isList(f) ? !Array.isArray(v) : !v || typeof v !== "object") return { ok: false };
    return { ok: true, value: v };
  }
  if (typeof raw === "object") return { ok: false };
  if (["int", "long", "double", "decimal"].includes(t)) {
    if (typeof raw === "number") return { ok: true, value: raw };
    return typeof raw === "string" && NUMBER.test(raw.trim()) ? { ok: true, value: Number(raw) } : { ok: false };
  }
  if (t === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const s = String(raw).toLowerCase();
    return s === "true" || s === "false" ? { ok: true, value: s === "true" } : { ok: false };
  }
  if (t === "datetime" && forRow) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(String(raw));
    if (!m) return { ok: false };
    return { ok: true, value: `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}.${(m[5] ?? "").padEnd(3, "0").slice(0, 3)}Z` };
  }
  return { ok: true, value: String(raw) };
}

/** A placeholder of a field's type, so a test with unknown data still compiles. */
function placeholder(f: SliceField): string {
  const ts = tsType(f);
  if (ts.endsWith("[]") || ts.startsWith("Array<")) return "[]";
  if (ts === "number") return "0";
  if (ts === "boolean") return "false";
  if (ts === "string") return "''";
  if (ts.startsWith("Record<")) return "{}";
  return "null";
}

/** The knex select item that reads a column as its field. */
function selectOf(column: string, prop: string, f: SliceField): string {
  const t = kindOf(f);
  const as = (expr: string) => `db.raw(${tsLiteral(`${expr} as ??`)}, [${tsLiteral(column)}, ${tsLiteral(prop)}])`;
  if (!isList(f)) {
    if (t === "date") return as("??::text");
    if (t === "datetime") return `db.raw(\`to_char(??, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ??\`, [${tsLiteral(column)}, ${tsLiteral(prop)}])`;
    if (t === "long" || t === "decimal") return as("??::float8");
  }
  return tsLiteral(column === prop ? column : `${column} as ${prop}`);
}

/** The read model's fields, in slice order. */
function viewFields(rm: SliceElement): ViewField[] {
  const fields = fieldsOf(rm);
  const keyIndex = fields.findIndex((f) => f.idAttribute === true);
  const columns = fields.map((f) => snake(f.name));
  const width = Math.max(0, ...columns.map((c) => c.length));
  return fields.map((f, i) => {
    const key = i === keyIndex;
    const column = columns[i];
    const sql = sqlType(f);
    const prop = propOf(f.name);
    const example = f.example === undefined || f.example === null || f.example === "" ? [] : [`example: ${typeof f.example === "string" ? `'${f.example.replace(/'/g, "''")}'` : JSON.stringify(f.example)}`];
    return {
      name: f.name,
      prop,
      column,
      type: String(f.type ?? ""),
      cardinality: String(f.cardinality ?? "Single"),
      optional: f.optional === true,
      key,
      ts: tsType(f),
      sql,
      columnDef: `${column.padEnd(width)} ${sql}${key ? " PRIMARY KEY" : f.optional === true ? "" : " NOT NULL"}`,
      select: selectOf(column, prop, f),
      openapi: [...openapiType(f), ...example],
    };
  });
}

interface EventDef {
  name: string;
  fields: SliceField[];
  known: boolean;
}

/** The events the projection handles: the source events, then any other event a specification or the read model names. */
function eventDefs(input: ViewModelInput, rm: SliceElement): EventDef[] {
  const out = new Map<string, EventDef>();
  for (const se of input.sourceEvents) {
    const name = pascal(se.event.title);
    if (!out.has(name)) out.set(name, { name, fields: fieldsOf(se.event), known: true });
  }
  const named = [
    ...(rm.dependencies ?? []).filter((d) => d.type === "INBOUND" && String(d.elementType).toUpperCase() === "EVENT").map((d) => d.title),
    ...(input.slice.specifications ?? []).flatMap((s) => [...(s.given ?? []), ...(s.when ?? [])]).filter(isEvent).map((s) => s.title),
  ];
  for (const title of named) {
    const name = pascal(title);
    if (!out.has(name)) out.set(name, { name, fields: [], known: false });
  }
  return [...out.values()];
}

function projectedEvent(e: EventDef, fields: ViewField[], key: ViewField | null, rmTitle: string): ProjectedEvent {
  const byName = new Map(e.fields.map((f) => [f.name, f]));
  const matched = fields.filter((f) => byName.has(f.name));
  const missing = fields.filter((f) => !byName.has(f.name));
  const fieldTypes = e.fields.map((f) => ({ prop: propOf(f.name), optional: f.optional === true, ts: tsType(f) }));
  if (!e.known) {
    return {
      name: e.name,
      fields: fieldTypes,
      known: false,
      upsert: null,
      marker: `BUILD: evolve ${e.name}. The dispatch has no definition of ${e.name}: add its fields to its type, then write what it does to ${rmTitle}, or return []`,
    };
  }
  if (!key || !byName.has(key.name)) {
    const why = key ? `${e.name} has no ${key.prop}, the key of ${rmTitle}` : `${rmTitle} has no key field`;
    return {
      name: e.name,
      fields: fieldTypes,
      known: true,
      upsert: null,
      marker: `BUILD: evolve ${e.name}. ${why}: write the statements it implies (an update by another column, a lookup table in this slice's migration), or return []`,
    };
  }
  const value = (f: ViewField) => {
    const v = `event.data.${propOf(byName.get(f.name)!.name)}`;
    return isList(f) || kindOf(f) === "custom" ? `JSON.stringify(${v})` : v;
  };
  return {
    name: e.name,
    fields: fieldTypes,
    known: true,
    upsert: { values: matched.map((f) => ({ prop: f.column, value: value(f) })), merge: matched.filter((f) => !f.key).map((f) => tsLiteral(f.column)) },
    marker: missing.length
      ? `BUILD: evolve ${e.name}. ${e.name} has no ${words(missing.map((f) => f.prop))}: add ${words(missing.map((f) => f.column), "and")} to the insert as the slice describes (a lookup, a default), or change the statement if ${e.name} does not create or update a row`
      : null,
  };
}

/** The data of a test event: from its step's example values, else from an example row, else placeholders (complete: false). */
function testEvent(step: SpecificationStep, def: EventDef | undefined, row: Record<string, unknown> | null): { event: TestEvent; complete: boolean } {
  const type = pascal(step.title);
  const defs = def?.fields ?? [];
  const stepExamples = new Map(fieldsOf(step).filter((f) => f.example !== undefined).map((f) => [f.name, f.example]));
  const data: Prop[] = [];
  let complete = !!def?.known;
  for (const f of defs) {
    const raw = stepExamples.has(f.name) ? stepExamples.get(f.name) : row && f.name in row ? row[f.name] : undefined;
    const c = raw === undefined ? null : coerce(f, raw, false);
    if (c && c.ok) data.push({ prop: propOf(f.name), value: tsLiteral(c.value) });
    else if (f.optional !== true) {
      data.push({ prop: propOf(f.name), value: placeholder(f) });
      complete = false;
    }
  }
  return { event: { type, data }, complete };
}

/** The tests: one per specification, or one per projected event when the slice has none. */
function testCases(input: ViewModelInput, fields: ViewField[], defs: EventDef[], rmTitle: string): TestCase[] {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const specs: Specification[] = input.slice.specifications ?? [];
  if (!specs.length) {
    return defs.map((d) => {
      const { event } = testEvent({ id: "", title: d.name, type: "EVENT" }, d, null);
      return {
        title: tsLiteral(`projects ${d.name}`),
        note: [],
        givenMarker: `BUILD: test. The slice has no specification: give ${d.name} example data and expect the ${rmTitle} rows it gives`,
        given: [event],
        when: [],
        thenMarker: null,
        expected: [],
      };
    });
  }
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  return specs.map((s) => {
    const rows = Array.isArray(s.examples) ? (s.examples as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : [];
    const steps = [...(s.given ?? []), ...(s.when ?? [])].filter(isEvent);
    // An example row per event: when every event of one type maps to one row, and the rows hold its required fields.
    const pairs = new Map<string, Record<string, unknown>[]>();
    for (const name of new Set(steps.map((st) => pascal(st.title)))) {
      const def = byName.get(name);
      const count = steps.filter((st) => pascal(st.title) === name).length;
      const required = (def?.fields ?? []).filter((f) => f.optional !== true);
      if (def?.known && required.length && count === rows.length && rows.every((r) => required.every((f) => f.name in r))) pairs.set(name, rows);
    }
    const seen = new Map<string, number>();
    let complete = true;
    const build = (st: SpecificationStep) => {
      const name = pascal(st.title);
      const i = seen.get(name) ?? 0;
      seen.set(name, i + 1);
      const r = testEvent(st, byName.get(name), pairs.get(name)?.[i] ?? null);
      complete &&= r.complete;
      return r.event;
    };
    const given = (s.given ?? []).filter(isEvent).map(build);
    const when = (s.when ?? []).filter(isEvent).map(build);

    // The expected rows: the examples, else the then read model's example values, else none when an empty list is expected.
    const thenRm = (s.then ?? []).find((t) => String(t.type ?? "").toUpperCase() === "READMODEL");
    const empty = s.expectEmptyList === true || thenRm?.expectEmptyList === true;
    const thenValues = fieldsOf(thenRm).filter((f) => f.example !== undefined);
    const sources = rows.length ? rows : thenValues.length ? [Object.fromEntries(thenValues.map((f) => [f.name, f.example]))] : [];
    let thenMarker: string | null = null;
    const order = (name: string) => (fieldByName.has(name) ? fields.indexOf(fieldByName.get(name)!) : fields.length);
    const expected = sources.map((r) =>
      Object.entries(r).sort(([a], [b]) => order(a) - order(b)).flatMap(([name, raw]): Prop[] => {
        const f = fieldByName.get(name);
        if (!f) {
          thenMarker = `BUILD: then. The examples name ${name}, which ${rmTitle} does not have: drop it or map it to a field`;
          return [{ prop: propOf(name), value: tsLiteral(raw) }];
        }
        const c = coerce({ name: f.name, type: f.type, cardinality: f.cardinality }, raw, true);
        if (!c.ok) thenMarker = `BUILD: then. The example ${f.prop} ${JSON.stringify(raw)} is not a ${f.type}: set the value the read model holds`;
        return [{ prop: f.prop, value: tsLiteral(c.ok ? c.value : raw) }];
      }),
    );
    if (!sources.length && !empty) thenMarker = `BUILD: then. The specification gives no example rows: expect the ${rmTitle} rows it describes`;
    const note = typeof s.contextNote === "string" && s.contextNote.trim() ? s.contextNote.trim().split(/\r?\n/) : [];
    return {
      title: tsLiteral(s.title),
      note,
      givenMarker: complete ? null : `BUILD: given. Set the events' data${rows.length ? `, and add events,` : ""} so they give the expected rows${note.length ? " (see the note)" : ""}`,
      given,
      when,
      thenMarker,
      expected,
    };
  });
}


/** The route: the app's modeled `GET query/<name>-collection` for the read model or the slice, else the read model's title lowercased. */
function endpointOf(input: ViewModelInput, rmTitle: string): string {
  for (const title of [rmTitle, input.slice.title]) {
    const hit = (input.modeledEndpoints ?? []).map((e) => /^GET (query\/(.+)-collection)$/.exec(e)).find((m) => m && normalize(m[2]) === normalize(title));
    if (hit) return `/api/${hit[1]}`;
  }
  return `/api/query/${rmTitle.toLowerCase().replace(/\s+/g, "")}-collection`;
}

/** The migration: CREATE TABLE when no migration of the table exists, else ALTER TABLE for what changed since the last build. */
function migrationOf(input: ViewModelInput, rm: SliceElement, table: string, fields: ViewField[]): StateViewModel["migration"] {
  const n = nextMigrationNumber(input.existingMigrations);
  const exists = input.existingMigrations.some((f) => new RegExp(`^V\\d+__(alter_)?${table}\\.sql$`).test(f));
  if (!exists) return { file: `V${n}__${table}.sql`, create: true, columns: fields.map((f) => f.columnDef), alters: [] };
  const before = input.changes?.elements?.changed?.find((c) => c.id === rm.id && c.before)?.before;
  if (!before) return { file: "", create: false, columns: [], alters: [] };
  const was = new Map(fieldsOf(before).map((f) => [f.name, f]));
  const now = new Set(fieldsOf(rm).map((f) => f.name));
  const alters: string[] = [];
  for (const f of fields) {
    const old = was.get(f.name);
    if (!old) alters.push(`ALTER TABLE "public"."${table}" ADD COLUMN IF NOT EXISTS ${f.column} ${f.sql};`);
    else if (sqlType(old) !== f.sql) alters.push(`ALTER TABLE "public"."${table}" ALTER COLUMN ${f.column} TYPE ${f.sql} USING ${f.column}::${f.sql};`);
  }
  for (const [name] of was) if (!now.has(name)) alters.push(`ALTER TABLE "public"."${table}" DROP COLUMN IF EXISTS ${snake(name)};`);
  return alters.length ? { file: `V${n}__alter_${table}.sql`, create: false, columns: [], alters } : { file: "", create: false, columns: [], alters: [] };
}

export function stateViewModel(input: ViewModelInput): StateViewModel {
  const rms = input.slice.readmodels ?? [];
  const rm = rms[0];
  if (!rm) throw new Error("a state-view slice needs a read model, and this one has none");
  const fields = viewFields(rm);
  const key = fields.find((f) => f.key) ?? null;
  const table = snake(rm.title);
  const rmNames = names(rm.title);
  const defs = eventDefs(input, rm);
  if (!defs.length) throw new Error(`a state-view slice needs the events it projects, and ${input.slice.title} names none (sourceEvents, specifications, dependencies)`);
  const events = eventsFileOf(input);
  const description = [input.slice.description, rm.description].find((d) => typeof d === "string" && d.trim()) ?? `The ${rm.title} read model`;
  return {
    ...baseModel(input),
    names: names(input.slice.title),
    sliceFolder: input.sliceFolder ?? pascal(input.slice.title),
    eventsModule: events.module,
    eventsType: events.type,
    readModel: { title: rm.title, type: `${rmNames.pascal}ReadModel`, summary: yamlScalar(input.slice.title), description: yamlScalar(String(description)) },
    table,
    endpoint: endpointOf(input, rm.title),
    fields,
    key,
    keyMarker: key ? null : `BUILD: key. ${rm.title} has no id field: choose the primary key column`,
    otherReadModelsMarker:
      rms.length > 1 ? `BUILD: read models. The scaffold builds ${rm.title} only: build ${rms.slice(1).map((r) => r.title).join(", ")} too, with its table in this slice's migration` : null,
    events: defs.map((d) => projectedEvent(d, fields, key, rm.title)),
    projectionEvents: `${pascal(input.slice.title)}Events`,
    eventImport: `{${defs.map((d) => d.name).join(", ")}}`,
    projectionImport: `{${pascal(input.slice.title)}Projection}`,
    tests: testCases(input, fields, defs, rm.title),
    migration: migrationOf(input, rm, table, fields),
  };
}
