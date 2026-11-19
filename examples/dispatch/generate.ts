#!/usr/bin/env node
/**
 * generate.ts: example gaffer dispatches (POST /slices bodies) for every Invoice Lite slice, for working on the
 * builder locally without a board, a runner or a gaffer.
 *
 * Reads the board snapshot in board.json and writes one file per scenario next to this script:
 *   <slice>-new.json      verdict NEW: the slice as it is on the board, no baseline
 *   <slice>-changed.json  verdict CHANGED: the board slice is the baseline, the edits below are the new definition
 *
 * `changes` comes from the gaffer's own compare() (gaffer/kit/templates/build-kit/baseline.ts), and source events are
 * resolved as gaffer.ts resolves them: each read model's INBOUND EVENT dependencies, looked up in the owning slice's
 * events[] in any chapter.
 *
 * Run: node examples/dispatch/generate.ts [--base <sha>] [--callback-port <port>]
 * Refresh board.json from the board first when the model changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, type Baseline, type SourceEventEntry } from "../../gaffer/kit/templates/build-kit/baseline.ts";

type Json = Record<string, any>;

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** invoice-lite main: the scaffold, with no slice built. */
const BASE = arg("--base", "a4ed0fbd5180aeb3155c6c0f60b77b1873a3ad5c");
const CALLBACK_PORT = arg("--callback-port", "8787");
const REPO_URL = "git@github.com:mowat27/invoice-lite.git";
const REQUIRES = ["repo:github.com/mowat27/invoice-lite", "stack:stub"];
const RECORDED_AT = "2026-11-16T12:00:00.000Z";

const board = JSON.parse(readFileSync(join(here, "board.json"), "utf8")) as { slices: Json[]; chapters: Record<string, Json[]> };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const chapterOf = (id: string): string => board.slices.find((s) => s.id === id)!.chapterId;
const allSlices = (): Json[] => Object.values(board.chapters).flat();
const sliceNamed = (title: string): Json => clone(allSlices().find((s) => s.title === title)!);

/** Source events of a read model slice, from the owners' events[], originals over copies (gaffer.ts loadSourceEvents). */
function sourceEventsOf(slice: Json, owners: Json[] = allSlices()): SourceEventEntry[] {
  const ids = new Set<string>();
  for (const rm of slice.readmodels ?? []) for (const d of rm.dependencies ?? []) if (d.type === "INBOUND" && d.elementType === "EVENT") ids.add(d.id);
  const out: SourceEventEntry[] = [];
  for (const id of ids) {
    const owner = owners.find((s) => (s.events ?? []).some((e: Json) => e.id === id && !e.elementCopy));
    if (!owner) throw new Error(`no slice owns event ${id} of ${slice.title}`);
    const event = clone(owner.events.find((e: Json) => e.id === id));
    out.push({ owner: { sliceId: owner.id, title: owner.title, status: owner.status, sliceType: owner.sliceType, chapterId: chapterOf(owner.id) }, event });
  }
  return out;
}

/** A field in the board's shape. */
function field(name: string, type: string, optional = false, mapping?: string): Json {
  return {
    name, optional, showAttributes: false, technicalAttribute: false, query: false, generated: false, edited: false,
    idAttribute: false, tag: false, type, cardinality: "Single", subfields: [], ...(mapping ? { mapping } : {}),
  };
}

const step = (el: Json, type: string): Json => ({ id: el.id, title: el.title, tags: [], index: 0, specRow: 0, type, fields: [] });
const error = (id: string, title: string, description: string): Json => ({ id, title, description, type: "SPEC_ERROR", fields: [] });

function spec(slice: Json, id: string, title: string, parts: { given: Json[]; when?: Json[]; then: Json[]; examples?: Json[] }): Json {
  return { id, title, chapter: slice.chapter, sliceName: slice.title, vertical: false, expectEmptyList: false, examples: parts.examples ?? [], given: parts.given, when: parts.when ?? [], then: parts.then };
}

const addField = (el: Json, f: Json): void => void el.fields.push(f);

// The edits behind each CHANGED scenario. The story runs across slices: CreateClient gains an optional phone number
// that Clients shows, CreateInvoice gains a due date that Invoices shows, and ClientDirectory gains a contact email
// and its first spec. Ids of new elements are fixed so the files are stable across runs.
const edits: Record<string, (s: Json, owners: Json[]) => void> = {
  CreateClient(s) {
    addField(s.commands[0], field("phone", "String", true));
    addField(s.events[0], field("phone", "String", true));
    addField(s.screens[0], field("phone", "String", true, "phone"));
    s.specifications.push(spec(s, "e0000000-0000-4000-8000-000000000101", "Create a client with a phone number", {
      given: [], when: [step(s.commands[0], "COMMAND")], then: [step(s.events[0], "EVENT")],
    }));
  },
  Clients(s, owners) {
    edits.CreateClient(owners.find((o) => o.title === "CreateClient")!, owners);
    addField(s.readmodels[0], field("phone", "String", true));
    addField(s.screens[0], field("phone", "String", true, "phone"));
  },
  CreateInvoice(s) {
    addField(s.commands[0], field("dueDate", "Date"));
    addField(s.events[0], field("dueDate", "Date"));
    addField(s.screens[0], field("dueDate", "Date", false, "dueDate"));
    s.specifications = s.specifications.filter((x: Json) => x.title !== "Zero amount is rejected");
    const clientCreated = s.specifications.flatMap((x: Json) => x.given).find((g: Json) => g.title === "ClientCreated");
    s.specifications.push(spec(s, "e0000000-0000-4000-8000-000000000201", "Due date before the invoice date is rejected", {
      given: [clientCreated], when: [step(s.commands[0], "COMMAND")],
      then: [error("e0000000-0000-4000-8000-000000000202", "Due date before the invoice date is rejected", "Due date must be on or after the invoice date")],
    }));
  },
  Invoices(s, owners) {
    edits.CreateInvoice(owners.find((o) => o.title === "CreateInvoice")!, owners);
    addField(s.readmodels[0], field("dueDate", "Date"));
    addField(s.screens[0], field("dueDate", "Date", false, "dueDate"));
  },
  ClientDirectory(s) {
    addField(s.readmodels[0], field("contactEmail", "String"));
    addField(s.screens[0], field("contactEmail", "String", false, "contactEmail"));
    const event = s.readmodels[0].dependencies.find((d: Json) => d.elementType === "EVENT" && d.type === "INBOUND");
    s.specifications.push(spec(s, "e0000000-0000-4000-8000-000000000301", "Directory lists every client", {
      given: [step(event, "EVENT"), step(event, "EVENT")],
      then: [step(s.readmodels[0], "READMODEL")],
      examples: [
        { clientId: "c1a2b3c4-0000-4000-8000-000000000001", name: "Great Glen Ltd", contactEmail: "accounts@great-glen.example" },
        { clientId: "c1a2b3c4-0000-4000-8000-000000000002", name: "The Lochside Lodge", contactEmail: "ellen@lochside.example" },
      ],
    }));
  },
};

function dispatch(slice: Json, sourceEvents: SourceEventEntry[], changes: unknown, scenario: string): Json {
  const jobId = `example-${slice.title.toLowerCase()}-${scenario}`;
  return {
    requires: REQUIRES,
    repo: { url: REPO_URL, base: BASE },
    task: { sliceId: slice.id, title: slice.title, context: slice.context, handover: false, attempt: 1 },
    slice,
    ...(slice.sliceType === "STATE_VIEW" ? { sourceEvents } : {}),
    changes,
    callback: `http://127.0.0.1:${CALLBACK_PORT}/jobs/${jobId}`,
  };
}

function write(name: string, body: Json): void {
  writeFileSync(join(here, name), JSON.stringify(body, null, 2) + "\n");
  console.log(`${name}  ${body.changes.verdict}`);
}

for (const title of Object.keys(edits)) {
  const slice = sliceNamed(title);
  const sourceEvents = sourceEventsOf(slice);
  write(`${title.toLowerCase()}-new.json`, dispatch(slice, sourceEvents, compare(null, null, slice, sourceEvents), "new"));

  const owners = clone(allSlices());
  const next = owners.find((s) => s.title === title)!;
  edits[title](next, owners);
  const nextEvents = sourceEventsOf(next, owners);
  const prev: Baseline = { sliceId: slice.id, title, sliceType: slice.sliceType, recordedAt: RECORDED_AT, jobId: `example-${title.toLowerCase()}-new`, slice, sourceEvents };
  const changes = compare(prev, { commit: BASE, recordedAt: RECORDED_AT }, next, nextEvents);
  if (changes.verdict !== "CHANGED") throw new Error(`${title}: the edits produced ${changes.verdict}`);
  write(`${title.toLowerCase()}-changed.json`, dispatch(next, nextEvents, changes, "changed"));
}
