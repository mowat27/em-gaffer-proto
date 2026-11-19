/**
 * What every supabase-api view model starts from: the input viewModel() gathers (the slice, its changes and source
 * events, the context folder, the workspace's migrations), the slice's element types as the gaffer sends them
 * (docs/contract.md), and small pure utilities shared by the kinds. Pure: no file system, no clock.
 */
import { camel, kebab, pascal, snake } from "../../../../engine/templates.ts";
import type { Verdict } from "../../../../engine/steps/classify.ts";
import { normalize } from "../checks.ts";

/** One field of a command, event or read model. */
export interface SliceField {
  name: string;
  /** String, UUID, Boolean, Int, Long, Double, Decimal, Date, DateTime or Custom. */
  type: string;
  optional?: boolean;
  /** Single or List. */
  cardinality?: string;
  idAttribute?: boolean;
  generated?: boolean;
  example?: unknown;
  subfields?: SliceField[];
  [key: string]: unknown;
}

/** A command, event, read model, screen or processor. */
export interface SliceElement {
  id: string;
  title: string;
  type?: string;
  description?: string;
  fields?: SliceField[];
  dependencies?: { id: string; type: "INBOUND" | "OUTBOUND" | string; title: string; elementType: string }[];
  [key: string]: unknown;
}

/** One given/when/then step of a specification: an element, with the example values of its fields. */
export interface SpecificationStep {
  id: string;
  title: string;
  type: string;
  fields?: SliceField[];
  [key: string]: unknown;
}

export interface Specification {
  id: string;
  title: string;
  given?: SpecificationStep[];
  when?: SpecificationStep[];
  then?: SpecificationStep[];
  [key: string]: unknown;
}

export interface Slice {
  id: string;
  title: string;
  sliceType?: string;
  context?: string;
  description?: string;
  commands?: SliceElement[];
  events?: SliceElement[];
  readmodels?: SliceElement[];
  screens?: SliceElement[];
  processors?: SliceElement[];
  specifications?: Specification[];
  [key: string]: unknown;
}

/** A STATE_VIEW slice's projected event: its definition from the slice that owns it. */
export interface SourceEvent {
  owner: { sliceId: string; title: string; status?: string; sliceType?: string; [key: string]: unknown };
  event: SliceElement;
}

/** One changed, added or removed element (docs/contract.md, Changes). `before` is the element as last built. */
export interface ElementChange {
  kind: string;
  id: string;
  title: string;
  before?: SliceElement;
  [key: string]: unknown;
}

export interface Changes {
  verdict: Verdict;
  since: { commit: string; recordedAt: string } | null;
  slice?: { changed: unknown[] };
  elements?: { changed: ElementChange[]; added: ElementChange[]; removed: ElementChange[] };
  sourceEvents?: { changed: ElementChange[]; added: ElementChange[]; removed: ElementChange[] };
  [key: string]: unknown;
}

/** What a kind's view model function gets. */
export interface ViewModelInput {
  slice: Slice;
  /** The dispatch's changes, or null when it sent none. */
  changes: Changes | null;
  /** The dispatch's source events ([] for a state-change slice). */
  sourceEvents: SourceEvent[];
  /** The context folder under src/slices/: an existing folder whose name matches the dispatch's context ignoring case, else the context as the dispatch names it. */
  context: string;
  /** File names in the app's supabase/migrations/, sorted. */
  existingMigrations: string[];
  /** The classification's verdict (NEW when the dispatch sent no changes). */
  verdict: Verdict;
  /** The slice folder under the context folder: an existing folder whose name matches the slice title ignoring case, else the title in PascalCase. viewModelInput always sets it. */
  sliceFolder?: string;
  /** File names directly in the context folder (src/slices/{context}/), sorted; [] when it does not exist. viewModelInput always sets it. */
  contextFiles?: string[];
  /** The app's modeled endpoints (`POST createclient`, `GET query/clients-collection`) from src/common/modeledEndpoints.ts, in file order; [] when the file does not exist. viewModelInput always sets it. */
  modeledEndpoints?: string[];
}

/** The endpoint entries (`'METHOD path'` strings) of a modeledEndpoints.ts source, in order; commented-out entries are ignored. */
export function parseModeledEndpoints(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/(['"`])([A-Z]+ [^'"`\s][^'"`]*)\1/g)].map((m) => m[2]);
}

/** Fields every kind's model has. */
export interface BaseModel {
  /** The context folder under src/slices/ (ViewModelInput.context). */
  context: string;
  /** The slice title as the dispatch names it. */
  slice: string;
  verdict: Verdict;
}

export function baseModel(input: ViewModelInput): BaseModel {
  return { context: input.context, slice: input.slice.title, verdict: input.verdict };
}

/** A name in every case. */
export interface Names {
  raw: string;
  pascal: string;
  camel: string;
  kebab: string;
  snake: string;
}

export function names(s: string): Names {
  return { raw: s, pascal: pascal(s), camel: camel(s), kebab: kebab(s), snake: snake(s) };
}

/** The next migration number: the highest `V{n}__*.sql` in `existing`, plus one (1 when there is none). */
export function nextMigrationNumber(existing: string[]): number {
  let max = 0;
  for (const f of existing) {
    const m = /^V(\d+)__.*\.sql$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** The context's events file: the `{Context}Events.ts` that exists (that name first, else the first `*Events.ts`), else that name. `type` is its union type. */
export function eventsFileOf(input: Pick<ViewModelInput, "context" | "contextFiles">): { module: string; type: string } {
  const wanted = `${pascal(input.context)}Events`;
  const existing = (input.contextFiles ?? []).filter((f) => /^[A-Za-z0-9]+Events\.ts$/.test(f)).map((f) => f.slice(0, -".ts".length));
  const module = existing.find((m) => m === wanted) ?? existing.find((m) => normalize(m) === normalize(wanted)) ?? existing[0] ?? wanted;
  return { module, type: /^[A-Z]/.test(module) ? module : pascal(module) };
}

/** What the shared `event-type` partial (agentics/shared/templates/partials/event-type.hbs) prints: one event type of the context's events file. */
export interface EventTypeShape {
  /** The TypeScript type name. */
  name: string;
  /** The event's type string. */
  type: string;
  fields: { prop: string; optional: boolean; ts: string }[];
  /** A BUILD: marker printed above the type, or null. */
  typeMarker: string | null;
}
