/**
 * baseline.ts: what changed in a slice since the gaffer last built it (contract: `changes`).
 *
 * After every successful build the gaffer commits the slice and source events it dispatched to
 * `.gaffer/slices/<sliceId>.json` in the target repository, on the same branch as the code. The next build reads
 * the baseline from its base commit, so the comparison is always against the definition the code on that branch was
 * built from. Elements are compared by a hash of their content (JSON with sorted keys), so a board-only change that
 * the builder never sees is not a change.
 *
 * Runs on Node 24 type stripping: only erasable TypeScript syntax is used.
 */
import { createHash } from "node:crypto";

export const BASELINE_DIR = ".gaffer/slices";

type Json = Record<string, unknown>;

export interface SourceEventEntry {
  owner: { sliceId: string; title: string; status: string; sliceType: string; chapterId: string };
  event: Json;
}

export interface Baseline {
  sliceId: string;
  title: string;
  sliceType: string;
  recordedAt: string;
  jobId: string;
  slice: Json;
  sourceEvents: SourceEventEntry[];
}

export type Verdict = "NEW" | "CHANGED" | "UNCHANGED";

export interface ElementRef {
  kind: string;
  id: string;
  title: string;
  before?: Json;
}

export interface SourceEventRef {
  id: string;
  title: string;
  owner: string;
  before?: Json;
}

export interface Changes {
  verdict: Verdict;
  since: { commit: string; recordedAt: string } | null;
  slice: { changed: string[] };
  elements: { changed: ElementRef[]; added: ElementRef[]; removed: ElementRef[] };
  sourceEvents: { changed: SourceEventRef[]; added: SourceEventRef[]; removed: SourceEventRef[] };
}

/** Slice keys that are not part of the spec: progress, board notes and position. */
const VOLATILE_SLICE_KEYS = new Set(["status", "comments", "index"]);
/** Element keys that are not part of the spec. */
const VOLATILE_ELEMENT_KEYS = new Set(["comments"]);

export function baselinePath(sliceId: string): string {
  return `${BASELINE_DIR}/${sliceId}.json`;
}

/** JSON with sorted keys, so key order on the board never reads as a change. */
export function stable(value: unknown, indent = ""): string {
  const pretty = indent !== "";
  const nl = (depth: number): string => (pretty ? `\n${indent.repeat(depth)}` : "");
  const walk = (v: unknown, depth: number): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[${v.map((x) => `${nl(depth + 1)}${walk(x, depth + 1)}`).join(",")}${nl(depth)}]`;
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v as Json).filter((k) => (v as Json)[k] !== undefined).sort();
      if (keys.length === 0) return "{}";
      return `{${keys.map((k) => `${nl(depth + 1)}${JSON.stringify(k)}:${pretty ? " " : ""}${walk((v as Json)[k], depth + 1)}`).join(",")}${nl(depth)}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return walk(value, 0);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function without(obj: Json, keys: Set<string>): Json {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.has(k)));
}

const isElement = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x) && typeof (x as Json).id === "string";

/**
 * A list of board elements: an array whose items are objects with an id (commands, events, screens, specs, ...). An
 * empty array counts as one, so a list that empties out is compared element by element, not as a slice field.
 */
function isElementList(v: unknown): v is Json[] {
  return Array.isArray(v) && v.every(isElement);
}

/** Every element of the slice by `<kind>/<id>`, where kind is the slice key that holds it. */
function elementsOf(slice: Json): Map<string, { kind: string; element: Json }> {
  const out = new Map<string, { kind: string; element: Json }>();
  for (const [kind, v] of Object.entries(slice)) {
    if (VOLATILE_SLICE_KEYS.has(kind) || !isElementList(v)) continue;
    for (const element of v) out.set(`${kind}/${String(element.id)}`, { kind, element });
  }
  return out;
}

/** The slice's own fields: every key that is not an element list and not volatile (title, sliceType, actors, ...). */
function sliceFields(slice: Json): Json {
  return Object.fromEntries(Object.entries(slice).filter(([k, v]) => !VOLATILE_SLICE_KEYS.has(k) && !isElementList(v)));
}

const titleOf = (e: Json): string => String(e.title ?? e.name ?? e.id ?? "?");

/**
 * Why the slice cannot be built, or null when it can. A command slice needs a command and an event, a read model
 * slice needs a read model. Other slice types are not checked.
 */
export function emptyReason(slice: Json): string | null {
  const count = (k: string): number => (Array.isArray(slice[k]) ? (slice[k] as unknown[]).length : 0);
  const missing: string[] = [];
  if (slice.sliceType === "STATE_CHANGE") {
    if (count("commands") === 0) missing.push("command");
    if (count("events") === 0) missing.push("event");
  } else if (slice.sliceType === "STATE_VIEW") {
    if (count("readmodels") === 0) missing.push("read model");
  } else {
    return null;
  }
  return missing.length ? `the ${String(slice.sliceType)} slice ${String(slice.title)} has no ${missing.join(" and no ")} on the board` : null;
}

/** Compare the slice and source events about to be dispatched with the baseline the base commit holds. */
export function compare(prev: Baseline | null, since: { commit: string; recordedAt: string } | null, slice: Json, sourceEvents: SourceEventEntry[]): Changes {
  const empty: Changes = {
    verdict: "NEW",
    since: null,
    slice: { changed: [] },
    elements: { changed: [], added: [], removed: [] },
    sourceEvents: { changed: [], added: [], removed: [] },
  };
  if (!prev) return empty;
  const out: Changes = { ...empty, verdict: "UNCHANGED", since };

  const was = sliceFields(prev.slice);
  const is = sliceFields(slice);
  for (const k of Array.from(new Set([...Object.keys(was), ...Object.keys(is)])).sort()) {
    if (hash(was[k]) !== hash(is[k])) out.slice.changed.push(k);
  }

  const before = elementsOf(prev.slice);
  const now = elementsOf(slice);
  for (const [key, { kind, element }] of now) {
    const old = before.get(key);
    const ref = { kind, id: String(element.id), title: titleOf(element) };
    if (!old) out.elements.added.push(ref);
    else if (hash(without(old.element, VOLATILE_ELEMENT_KEYS)) !== hash(without(element, VOLATILE_ELEMENT_KEYS))) out.elements.changed.push({ ...ref, before: old.element });
  }
  for (const [key, { kind, element }] of before) {
    if (!now.has(key)) out.elements.removed.push({ kind, id: String(element.id), title: titleOf(element), before: element });
  }

  const evBefore = new Map((prev.sourceEvents ?? []).map((s) => [String(s.event.id), s]));
  const evNow = new Map(sourceEvents.map((s) => [String(s.event.id), s]));
  for (const [id, s] of evNow) {
    const old = evBefore.get(id);
    const ref = { id, title: titleOf(s.event), owner: s.owner.title };
    if (!old) out.sourceEvents.added.push(ref);
    else if (hash(without(old.event, VOLATILE_ELEMENT_KEYS)) !== hash(without(s.event, VOLATILE_ELEMENT_KEYS))) out.sourceEvents.changed.push({ ...ref, before: old.event });
  }
  for (const [id, s] of evBefore) {
    if (!evNow.has(id)) out.sourceEvents.removed.push({ id, title: titleOf(s.event), owner: s.owner.title, before: s.event });
  }

  const lists = [out.slice.changed, out.elements.changed, out.elements.added, out.elements.removed, out.sourceEvents.changed, out.sourceEvents.added, out.sourceEvents.removed];
  if (lists.some((l) => l.length > 0)) out.verdict = "CHANGED";
  return out;
}

/** One line per change, for events and notes. */
export function summarise(c: Changes): string {
  if (c.verdict !== "CHANGED") return c.verdict;
  const parts: string[] = [];
  if (c.slice.changed.length) parts.push(`slice ${c.slice.changed.join(", ")}`);
  const list = (label: string, refs: { title: string }[]): void => {
    if (refs.length) parts.push(`${label} ${refs.map((r) => r.title).join(", ")}`);
  };
  list("changed", c.elements.changed);
  list("added", c.elements.added);
  list("removed", c.elements.removed);
  list("source events changed", c.sourceEvents.changed);
  list("source events added", c.sourceEvents.added);
  list("source events removed", c.sourceEvents.removed);
  return `CHANGED: ${parts.join("; ")}`;
}
