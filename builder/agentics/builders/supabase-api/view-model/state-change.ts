/**
 * The state-change view model: what templates/state-change/ renders from. Pure: same input, same model.
 *
 * Everything code can decide is decided here, as text the templates print as is: names, TypeScript types and literals,
 * the command's fields, the events decide emits (each field mapped from the command field of the same name), the
 * route and its OpenAPI schema, the error codes (snake_case of each
 * SPEC_ERROR title, with its description as the message), and one test per specification with given, when and then
 * wired. What needs judgement becomes a `BUILD:` marker text: the rules decide enforces, what the state holds and how
 * evolve folds events into it, test data the specifications give no example for, events defined by other slices.
 *
 * Paths follow the app: the slice folder and the context's events file as they exist, and the route the app's
 * modeledEndpoints.ts lists for the slice (`POST createclient` -> POST /api/createclient/:{generated id field}). Only a
 * slice the app does not list falls back to POST /api/{kebab-case slice}/:{generated id field}.
 *
 * Values in tests: a step's own example, else an example the specification gives for the same field name, else the
 * field's own example, else an example another specification gives, else a placeholder by type. UUID placeholders are
 * numbered per field name across the slice, so one name has one value in every given, when and then.
 */
import { camel, pascal, snake, tsType } from "../../../../engine/templates.ts";
import { normalize } from "../checks.ts";
import {
  baseModel,
  eventsFileOf,
  names,
  type BaseModel,
  type EventTypeShape,
  type Names,
  type SliceElement,
  type SliceField,
  type Specification,
  type SpecificationStep,
  type ViewModelInput,
} from "./common.ts";

/** A field of the command or of an event, as the templates print it. */
export interface StateChangeField {
  /** The field's name in the slice. */
  name: string;
  /** The property key: the name, or its camelCase when the name is not an identifier. */
  prop: string;
  /** The TypeScript type. */
  ts: string;
  optional: boolean;
}

/** An event type for the context's events union, in the shape the shared event-type partial prints (name, type, fields, typeMarker). */
export interface StateChangeEventType extends EventTypeShape {
  /** The event's type string: the title when it is a word, else its PascalCase. */
  type: string;
  /** Used by the specifications but defined by another slice: no schema here, so the type is a stub with a marker. */
  foreign: boolean;
  fields: StateChangeField[];
  /** The marker above a foreign event's stub type, else null. */
  typeMarker: string | null;
}

/** One `key: value,` line of an object literal, with a marker for the line when the value needs judgement. */
export interface StateChangeAssignment {
  prop: string;
  value: string;
  marker: string | null;
}

/** An event in decide's result or in a test. */
export interface StateChangeEventValue {
  name: string;
  type: string;
  foreign: boolean;
  data: StateChangeAssignment[];
}

/** A rule the handler enforces: one per distinct SPEC_ERROR. */
export interface StateChangeError {
  /** The error code decide throws and routes.ts maps: snake_case of the SPEC_ERROR title. */
  code: string;
  /** The code as a TypeScript string literal. */
  codeLiteral: string;
  /** The message (the SPEC_ERROR description, else its title) as a TypeScript string literal. */
  messageLiteral: string;
  /** `code: message`, one line of the 409 response description. */
  doc: string;
}

/** A request body property of the route. */
export interface StateChangeBodyField {
  name: string;
  prop: string;
  /** `req.body?.name`. */
  access: string;
  /** The OpenAPI schema lines (type, format, items, example), unindented. */
  schema: string[];
}

export interface StateChangeRoute {
  /** The express path: `/api/createclient/:clientId` from the app's modeled endpoints, else `/api/create-client/:clientId`. */
  path: string;
  /** The OpenAPI path key: the path with `{param}`. */
  openapiPath: string;
  /** The path parameter: the command's generated ID field (`id` when it has none). */
  param: string;
  /** The command's data in slice order: the ID field from the path (`id`), the others from the body. */
  data: StateChangeAssignment[];
  /** The OpenAPI schema lines of the path parameter. */
  paramSchema: string[];
  /** The OpenAPI tag: the slice's context. */
  tag: string;
  summary: string;
  /** The slice's description as a YAML scalar, or null when it has none. */
  description: string | null;
  body: StateChangeBodyField[];
  /** The required body fields (their keys). */
  required: string[];
  /** The events a 201 appends, for its description. */
  appended: string;
  /** The app's modeled endpoint the path comes from (`POST createclient`), or null for the kebab-case fallback. */
  modeled: string | null;
  /** A marker when the route cannot follow the convention, else null. */
  marker: string | null;
}

/** One test: a specification with given, when and then wired. */
export interface StateChangeTest {
  /** The `it` title as a TypeScript string literal: `'spec: <title>'`. */
  titleLiteral: string;
  markers: string[];
  given: StateChangeEventValue[];
  command: StateChangeAssignment[];
  /** `events`: then lists events. `throws`: then has a SPEC_ERROR. `nothing`: then is empty. */
  outcome: "events" | "throws" | "nothing";
  then: StateChangeEventValue[];
  /** The code the test expects decide to throw (outcome `throws`), else null. */
  errorCodeLiteral: string | null;
}

export interface StateChangeModel extends BaseModel {
  /** The slice title in every case. */
  names: Names;
  /** The slice folder under the context folder (ViewModelInput.sliceFolder). */
  sliceFolder: string;
  /** The context's events file without .ts: the existing one, else `{Context}Events`. */
  eventsModule: string;
  /** The context's events union type: `InvoicingEvents`. */
  eventsType: string;
  /** The command's type alias, its state, initial state, handler and handle function names. */
  commandType: string;
  stateType: string;
  initialState: string;
  handlerName: string;
  handleName: string;
  command: { type: string; fields: StateChangeField[] };
  /** Every event type the slice needs in the union: its own events in slice order, then other slices' events its specifications use. */
  eventTypes: StateChangeEventType[];
  /** The other slices' events the specifications use. */
  foreignEvents: StateChangeEventType[];
  /** The events decide returns, each field mapped from the command. */
  emits: StateChangeEventValue[];
  errors: StateChangeError[];
  route: StateChangeRoute;
  tests: StateChangeTest[];
  /** Markers that are not tied to a single line: null when there is nothing to judge. */
  markers: { state: string | null; evolve: string | null; decide: string[]; handle: string | null; commands: string | null };
}

// ---- text ----

const IDENT = /^[A-Za-z_$][\w$]*$/;
const WORD = /^\w+$/;

const oneLine = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** A TypeScript single-quoted string literal. */
export function tsString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}

/** A YAML scalar for an OpenAPI value: plain when that is safe, else double-quoted (JSON is valid YAML). */
export function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][\w .,;()/'+-]*$/.test(s) && !s.endsWith(" ") ? s : JSON.stringify(s);
}

/** The property key for a field name. */
function keyOf(name: string): string {
  if (IDENT.test(name)) return name;
  const c = camel(name);
  return IDENT.test(c) ? c : JSON.stringify(name);
}

/** `base.key` or `base["key"]`. */
const access = (base: string, key: string) => (IDENT.test(key) ? `${base}.${key}` : `${base}[${key}]`);

/** A message's type string: the title when it is a word, else its PascalCase. */
const typeOf = (title: string) => (WORD.test(title) ? title : pascal(title));

const quoteList = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---- types and values ----

const kindOf = (f: SliceField) => String(f.type ?? "").toLowerCase();
const isList = (f: SliceField) => String(f.cardinality ?? "").toLowerCase() === "list";
const NUMERIC = new Set(["int", "long", "double", "decimal"]);
const STRINGS = new Set(["string", "uuid", "date", "datetime"]);

function field(f: SliceField): StateChangeField {
  return { name: f.name, prop: keyOf(f.name), ts: tsType(f.type ? f : { type: "unknown" }), optional: f.optional === true };
}

/** A TypeScript literal of an example value for a field, or null when the value does not fit its type. */
function literal(f: SliceField, v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const k = kindOf(f);
  if (isList(f) || k === "custom") {
    if (typeof v === "object") return JSON.stringify(v);
    try {
      const parsed = JSON.parse(String(v));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed) === isList(f)) return JSON.stringify(parsed);
    } catch {
      /* not JSON */
    }
    return null;
  }
  if (NUMERIC.has(k)) {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    return Number.isFinite(n) && String(v).trim() !== "" ? String(n) : null;
  }
  if (k === "boolean") return v === true || v === "true" ? "true" : v === false || v === "false" ? "false" : null;
  if (typeof v === "object") return null;
  return tsString(String(v));
}

/** Placeholder values for the slice: UUIDs numbered per field name in order of first use. */
class Placeholders {
  private ids = new Map<string, string>();

  uuid(name: string): string {
    let v = this.ids.get(name);
    if (!v) {
      v = `'00000000-0000-4000-8000-${String(this.ids.size + 1).padStart(12, "0")}'`;
      this.ids.set(name, v);
    }
    return v;
  }

  /** A test value for a field with no example. `judge` is false when any value of the type will do (a UUID). */
  test(f: SliceField): { value: string; judge: boolean } {
    if (isList(f)) return { value: "[]", judge: true };
    const k = kindOf(f);
    if (k === "uuid") return { value: this.uuid(f.name), judge: false };
    if (k === "string") return { value: tsString(`<${f.name}>`), judge: true };
    if (NUMERIC.has(k)) return { value: "1", judge: true };
    if (k === "boolean") return { value: "true", judge: true };
    if (k === "date") return { value: "'2026-01-01'", judge: true };
    if (k === "datetime") return { value: "'2026-01-01T00:00:00.000Z'", judge: true };
    if (k === "custom") return { value: "{}", judge: true };
    return { value: "null", judge: true };
  }
}

/** A value of the field's type for decide when the command cannot give one. */
function emptyValue(f: SliceField): string {
  if (isList(f)) return "[]";
  const k = kindOf(f);
  if (STRINGS.has(k)) return "''";
  if (NUMERIC.has(k)) return "0";
  if (k === "boolean") return "false";
  if (k === "custom") return "{}";
  return "null";
}

// ---- OpenAPI ----

const OPENAPI: Record<string, string[]> = {
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

function schemaOf(f: SliceField): string[] {
  const base = OPENAPI[kindOf(f)] ?? ["type: string"];
  return isList(f) ? ["type: array", "items:", ...base.map((l) => `  ${l}`)] : base;
}

/** The YAML text of an example for the OpenAPI block, or null. */
function exampleYaml(f: SliceField, v: unknown): string | null {
  const lit = literal(f, v);
  if (lit === null) return null;
  if (isList(f) || kindOf(f) === "custom") return lit; // JSON: YAML flow style
  if (NUMERIC.has(kindOf(f)) || kindOf(f) === "boolean") return lit;
  return yamlScalar(oneLine(v));
}

// ---- the slice ----

const elementsOf = (xs: SliceElement[] | undefined) => (Array.isArray(xs) ? xs : []);
const fieldsOf = (e: { fields?: SliceField[] } | undefined) => (Array.isArray(e?.fields) ? e!.fields!.filter((f) => f && typeof f.name === "string" && f.name) : []);
const stepsOf = (s: Specification, k: "given" | "when" | "then") => (Array.isArray(s[k]) ? (s[k] as SpecificationStep[]) : []);
const typeIs = (step: SpecificationStep, t: string) => String(step.type ?? "").toUpperCase() === t;

function find(elements: SliceElement[], step: SpecificationStep): SliceElement | undefined {
  return elements.find((e) => e.id === step.id) ?? elements.find((e) => e.title === step.title);
}

/** The command the slice's route and handler are for: the one titled like the slice, else the first. */
function mainCommand(commands: SliceElement[], title: string): SliceElement | undefined {
  return commands.find((c) => pascal(c.title) === pascal(title)) ?? commands[0];
}

/** The events the command emits: its OUTBOUND event dependencies among the slice's events, else every event. */
function emitted(command: SliceElement | undefined, events: SliceElement[]): SliceElement[] {
  const out = (command?.dependencies ?? []).filter((d) => d.type === "OUTBOUND" && String(d.elementType).toUpperCase() === "EVENT");
  const hit = events.filter((e) => out.some((d) => d.id === e.id || d.title === e.title));
  return hit.length ? hit : events;
}

/**
 * The app's modeled endpoint for the slice: a POST entry whose path, ignoring case and punctuation, is the command's
 * or the slice's title (`POST createclient`, `POST create-client`). Null when the app lists none.
 */
export function modeledEndpoint(entries: string[], titles: (string | undefined)[]): string | null {
  for (const title of titles) {
    if (!title) continue;
    const hit = entries.find((e) => e.startsWith("POST ") && normalize(e.slice("POST ".length)) === normalize(title));
    if (hit) return hit;
  }
  return null;
}


function errorOf(step: SpecificationStep, n: number): { code: string; message: string } {
  const code = snake(step.title ?? "") || `rule_${n}`;
  return { code, message: oneLine(step.description) || oneLine(step.title) || code };
}

export function stateChangeModel(input: ViewModelInput): StateChangeModel {
  const base = baseModel(input);
  const eventsFile = eventsFileOf(input);
  const slice = input.slice;
  const n = names(slice.title);
  const commands = elementsOf(slice.commands);
  const events = elementsOf(slice.events);
  const specs = Array.isArray(slice.specifications) ? slice.specifications : [];
  const command = mainCommand(commands, slice.title);
  const commandFields = fieldsOf(command);
  const ph = new Placeholders();
  // Number the UUID placeholders in a fixed order: the command's fields, then the events', then the specifications'.
  for (const f of [...commandFields, ...events.flatMap(fieldsOf)]) if (kindOf(f) === "uuid") ph.uuid(f.name);

  // Event types: the slice's own, then other slices' events the specifications use.
  const eventTypes: StateChangeEventType[] = [];
  const addType = (t: StateChangeEventType) => {
    if (!eventTypes.some((e) => e.name === t.name)) eventTypes.push(t);
  };
  for (const e of events) addType({ name: pascal(e.title), type: typeOf(e.title), foreign: false, fields: fieldsOf(e).map(field), typeMarker: null });
  for (const s of specs) {
    for (const step of [...stepsOf(s, "given"), ...stepsOf(s, "then")]) {
      if (!typeIs(step, "EVENT") || find(events, step)) continue;
      addType({
        name: pascal(step.title),
        type: typeOf(step.title),
        foreign: true,
        fields: [],
        typeMarker: `BUILD: event type. ${typeOf(step.title)} is used by the ${slice.title} specifications but defined by another slice: give it that slice's fields if src/slices/ has them, else the fields this slice reads from it.`,
      });
    }
  }
  const foreignEvents = eventTypes.filter((e) => e.foreign);

  // decide: each emitted event's fields from the command field of the same name.
  const byName = new Map(commandFields.map((f) => [f.name, f]));
  const commandType = `${n.pascal}Command`;
  const emitList = emitted(command, events);
  const emits: StateChangeEventValue[] = emitList.map((e) => ({
    name: pascal(e.title),
    type: typeOf(e.title),
    foreign: false,
    data: fieldsOf(e).map((f) => {
      const k = keyOf(f.name);
      const c = byName.get(f.name);
      const from = c ? access("command.data", keyOf(c.name)) : null;
      if (!c) return { prop: k, value: emptyValue(f), marker: `BUILD: emit. ${commandType} has no ${f.name} field: set ${typeOf(e.title)}.${f.name} as the slice describes.` };
      if (tsType(c) !== tsType(f)) return { prop: k, value: emptyValue(f), marker: `BUILD: emit. ${f.name} is ${tsType(c)} on the command but ${tsType(f)} on ${typeOf(e.title)}: convert ${from}.` };
      if (c.optional === true && f.optional !== true) return { prop: k, value: `${from} ?? ${emptyValue(f)}`, marker: `BUILD: emit. ${f.name} is optional on the command but required on ${typeOf(e.title)}: decide its value when it is missing.` };
      return { prop: k, value: from!, marker: null };
    }),
  }));

  // Errors: one per distinct SPEC_ERROR, in order of appearance.
  const errors: StateChangeError[] = [];
  const errorFor = new Map<SpecificationStep, StateChangeError>();
  for (const s of specs) {
    for (const step of stepsOf(s, "then").filter((t) => typeIs(t, "SPEC_ERROR"))) {
      const { code, message } = errorOf(step, errors.length + 1);
      let err = errors.find((e) => e.code === code);
      if (!err) {
        err = { code, codeLiteral: tsString(code), messageLiteral: tsString(message), doc: `${code}: ${message}` };
        errors.push(err);
      }
      errorFor.set(step, err);
    }
  }

  // The route: the app's modeled endpoint for the slice, else POST /api/{kebab-case slice}; the generated ID field as its parameter.
  const idField = commandFields.find((f) => f.generated === true) ?? commandFields.find((f) => f.idAttribute === true) ?? null;
  const param = idField && IDENT.test(keyOf(idField.name)) ? keyOf(idField.name) : "id";
  const firstExample = (f: SliceField): unknown => {
    if (f.example !== undefined && f.example !== null && f.example !== "") return f.example;
    for (const s of specs) {
      for (const step of stepsOf(s, "when")) {
        if (!typeIs(step, "COMMAND") || (command && find([command], step) === undefined)) continue;
        const v = fieldsOf(step).find((x) => x.name === f.name)?.example;
        if (v !== undefined && v !== null && v !== "") return v;
      }
    }
    return undefined;
  };
  const body: StateChangeBodyField[] = commandFields
    .filter((f) => f !== idField)
    .map((f) => {
      const k = keyOf(f.name);
      const ex = exampleYaml(f, firstExample(f));
      return { name: f.name, prop: k, access: IDENT.test(k) ? `req.body?.${k}` : `req.body?.[${k}]`, schema: [...schemaOf(f), ...(ex === null ? [] : [`example: ${ex}`])] };
    });
  const modeled = modeledEndpoint(input.modeledEndpoints ?? [], [command?.title, slice.title]);
  const routeBase = `/api/${modeled ? modeled.slice("POST ".length).replace(/^\/+|\/+$/g, "") : n.kebab}`;
  const route: StateChangeRoute = {
    path: `${routeBase}/:${param}`,
    openapiPath: `${routeBase}/{${param}}`,
    param,
    data: commandFields.map((f) => ({ prop: keyOf(f.name), value: f === idField ? "id" : body.find((b) => b.name === f.name)!.access, marker: null })),
    paramSchema: idField ? schemaOf(idField) : ["type: string"],
    tag: yamlScalar(oneLine(slice.context) || input.context),
    summary: yamlScalar(oneLine(slice.title)),
    description: oneLine(slice.description) ? yamlScalar(oneLine(slice.description)) : null,
    body,
    required: commandFields.filter((f) => f !== idField && f.optional !== true).map((f) => keyOf(f.name)),
    appended: emits.map((e) => e.type).join(", ") || "nothing",
    marker: idField
      ? null
      : `BUILD: route. ${command?.title ?? slice.title} has no generated ID field, so the route cannot follow POST ${routeBase}/:{generated-id-field}: decide the stream id.`,
    modeled,
  };

  // Tests: one per specification.
  /** Examples by field name, the first one wins: in one specification, or in all of them. */
  const examplesIn = (ss: Specification[]) => {
    const examples = new Map<string, unknown>();
    for (const s of ss) {
      for (const step of [...stepsOf(s, "given"), ...stepsOf(s, "when"), ...stepsOf(s, "then")]) {
        for (const f of fieldsOf(step)) if (f.example !== undefined && f.example !== null && f.example !== "" && !examples.has(f.name)) examples.set(f.name, f.example);
      }
    }
    return examples;
  };
  const sliceExamples = examplesIn(specs);
  const tests: StateChangeTest[] = specs.map((s) => {
    const markers: string[] = [];
    const examples = examplesIn([s]);
    const judged: string[] = [];
    const valueOf = (f: SliceField, step: SpecificationStep): string => {
      const own = fieldsOf(step).find((x) => x.name === f.name)?.example;
      for (const v of [own, examples.get(f.name), f.example, sliceExamples.get(f.name)]) {
        const lit = literal(f, v);
        if (lit !== null) return lit;
      }
      const p = ph.test(f);
      if (p.judge && !judged.includes(f.name)) judged.push(f.name);
      return p.value;
    };
    /** The element's fields a step sets: every required field, and the optional ones the step lists (all when it lists none). */
    const dataOf = (element: SliceElement, step: SpecificationStep): StateChangeAssignment[] => {
      const listed = new Set(fieldsOf(step).map((f) => f.name));
      return fieldsOf(element)
        .filter((f) => f.optional !== true || listed.size === 0 || listed.has(f.name))
        .map((f) => ({ prop: keyOf(f.name), value: valueOf(f, step), marker: null }));
    };
    const foreignUsed: string[] = [];
    const eventValue = (step: SpecificationStep): StateChangeEventValue => {
      const own = find(events, step);
      if (own) return { name: pascal(own.title), type: typeOf(own.title), foreign: false, data: dataOf(own, step) };
      const listed = fieldsOf(step).map((f) => f.name);
      foreignUsed.push(`${typeOf(step.title)}${listed.length ? ` (the specification lists ${list(listed)})` : ""}`);
      return { name: pascal(step.title), type: typeOf(step.title), foreign: true, data: [] };
    };

    const whenStep = stepsOf(s, "when").find((w) => typeIs(w, "COMMAND"));
    const errorStep = stepsOf(s, "then").find((t) => typeIs(t, "SPEC_ERROR"));
    const error = errorStep ? errorFor.get(errorStep)! : null;
    if (error) markers.push(`BUILD: test data. Give the command values that break only "${oneLine(errorStep!.title)}" (${oneLine(errorStep!.description) || "the rule"}).`);
    if (!whenStep) markers.push(`BUILD: test. The specification names no command: this test sends ${commandType}; make it match the specification.`);
    else if (command && !find([command], whenStep)) markers.push(`BUILD: test. The specification sends ${typeOf(whenStep.title)}, which is not ${command.title}: make the test match the specification.`);
    const given = stepsOf(s, "given").filter((g) => typeIs(g, "EVENT")).map(eventValue);
    const commandData = command ? dataOf(command, whenStep ?? ({ id: "", title: "", type: "COMMAND", fields: [] } as SpecificationStep)) : [];
    const then = error ? [] : stepsOf(s, "then").filter((t) => typeIs(t, "EVENT")).map(eventValue);
    if (judged.length && !error) markers.push(`BUILD: test data. The specification gives no example for ${list(judged)}: replace the placeholders with values that fit it.`);
    const foreign = [...new Set(foreignUsed)];
    if (foreign.length) {
      markers.push(
        foreign.length > 1
          ? `BUILD: test data. ${list(foreign)} are defined by other slices: fill their data with the fields of their types.`
          : `BUILD: test data. ${foreign[0]} is defined by another slice: fill its data with the fields of its type.`,
      );
    }
    return {
      titleLiteral: tsString(`spec: ${oneLine(s.title)}`),
      markers,
      given,
      command: commandData,
      outcome: error ? "throws" : then.length ? "events" : "nothing",
      then,
      errorCodeLiteral: error ? error.codeLiteral : null,
    };
  });

  // Markers that are not tied to one line.
  const givenTypes = [...new Set(specs.flatMap((s) => stepsOf(s, "given").filter((g) => typeIs(g, "EVENT")).map((g) => typeOf(g.title))))];
  const decide = errors.map((e) => {
    const title = specs.flatMap((s) => stepsOf(s, "then")).find((t) => errorFor.get(t) === e)?.title ?? e.code;
    return `BUILD: decide. "${oneLine(title)}": throw {code: ${e.codeLiteral}, message: ${e.messageLiteral}} when the command breaks this rule.`;
  });
  if (emits.length > 1) decide.push(`BUILD: decide. The command can emit ${list(emits.map((e) => e.type))}: return the events each specification expects.`);
  const foreignGiven = givenTypes.filter((t) => foreignEvents.some((f) => f.type === t));
  const others = commands.filter((c) => c !== command).map((c) => c.title);

  return {
    ...base,
    names: n,
    sliceFolder: input.sliceFolder ?? n.pascal,
    eventsModule: eventsFile.module,
    eventsType: eventsFile.type,
    commandType,
    stateType: `${n.pascal}State`,
    initialState: `${n.pascal}InitialState`,
    handlerName: `${n.pascal}CommandHandler`,
    handleName: `handle${n.pascal}`,
    command: { type: typeOf(command?.title ?? slice.title), fields: commandFields.map(field) },
    eventTypes,
    foreignEvents,
    emits,
    errors,
    route,
    tests,
    markers: {
      state: givenTypes.length ? `BUILD: state. Hold what decide needs from earlier events (${givenTypes.join(", ")}); keep {} if it needs nothing.` : null,
      evolve: givenTypes.length ? `BUILD: evolve. Fold ${list(givenTypes)} into the state for decide; return the state unchanged for every other event.` : null,
      decide,
      handle: foreignGiven.length
        ? `BUILD: handle. ${list(foreignGiven)} ${foreignGiven.length > 1 ? "come" : "comes"} from another slice. If ${foreignGiven.length > 1 ? "they are" : "it is"} on another stream than this command's, load that fact (for example from its read model with getKnexInstance() from src/common/db) and add it to the state before decide.`
        : null,
      commands: others.length ? `BUILD: commands. The slice has more commands (${quoteList(others)}): this scaffold handles only ${command?.title ?? slice.title}. Handle them too.` : null,
    },
  };
}
