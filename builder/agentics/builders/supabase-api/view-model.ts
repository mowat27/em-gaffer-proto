/**
 * The supabase-api scaffold's view model: what a kind's template set (templates/<kind>/) renders from.
 *
 * viewModel(classification, ctx) gathers the input from the job's dispatch and the app directory (the context and
 * slice folders as they exist there, the context folder's files, the migrations already there, the app's modeled
 * endpoints), then calls the kind's pure function:
 *   state-change   view-model/state-change.ts  stateChangeModel(input)
 *   state-view     view-model/state-view.ts    stateViewModel(input)
 * Other kinds have no template set, so the template step skips before it asks for a model (and modelFor throws).
 * The input types and shared utilities (names, nextMigrationNumber) are in view-model/common.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Classification } from "../../../engine/steps/classify.ts";
import { pascal } from "../../../engine/templates.ts";
import type { PrepareOutput } from "../../../engine/steps/prepare.ts";
import type { Dispatch, StepContext } from "../../../engine/types.ts";
import { normalize } from "./checks.ts";
import { parseModeledEndpoints, type Changes, type Slice, type SourceEvent, type ViewModelInput } from "./view-model/common.ts";
import { stateChangeModel, type StateChangeModel } from "./view-model/state-change.ts";
import { stateViewModel, type StateViewModel } from "./view-model/state-view.ts";

export type { ViewModelInput } from "./view-model/common.ts";
export { stateChangeModel, type StateChangeModel, stateViewModel, type StateViewModel };

const sorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Directory entries of `dir` (sorted), or [] when it does not exist. */
function entries(dir: string, what: "dirs" | "files"): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return sorted(readdirSync(dir, { withFileTypes: true }).filter((e) => (what === "dirs" ? e.isDirectory() : e.isFile())).map((e) => e.name));
}

/** The view model's input for a dispatch built in `appDir`. */
export function viewModelInput(c: Classification, d: Pick<Dispatch, "slice" | "changes" | "sourceEvents">, appDir: string): ViewModelInput {
  const existing = entries(join(appDir, "src", "slices"), "dirs").find((name) => normalize(name) === normalize(c.context));
  const context = existing ?? c.context;
  const contextDir = join(appDir, "src", "slices", context);
  const sliceFolder = entries(contextDir, "dirs").find((name) => normalize(name) === normalize(c.slice));
  const endpointsFile = join(appDir, "src", "common", "modeledEndpoints.ts");
  return {
    slice: (d.slice ?? {}) as Slice,
    changes: d.changes && typeof d.changes === "object" ? (d.changes as unknown as Changes) : null,
    sourceEvents: Array.isArray(d.sourceEvents) ? (d.sourceEvents as SourceEvent[]) : [],
    context,
    existingMigrations: entries(join(appDir, "supabase", "migrations"), "files"),
    verdict: c.verdict,
    sliceFolder: sliceFolder ?? pascal(c.slice),
    contextFiles: entries(contextDir, "files"),
    modeledEndpoints: existsSync(endpointsFile) && statSync(endpointsFile).isFile() ? parseModeledEndpoints(readFileSync(endpointsFile, "utf8")) : [],
  };
}

/** The kind's model for `input`. Throws for a kind with no view model. */
export function modelFor(c: Classification, input: ViewModelInput): StateChangeModel | StateViewModel {
  switch (c.kind) {
    case "state-change":
      return stateChangeModel(input);
    case "state-view":
      return stateViewModel(input);
    default:
      throw new Error(`no view model for ${c.kind} slices`);
  }
}

/** The template step's `data`: the model for the classified slice, built in the prepare step's app directory. */
export function viewModel(c: Classification, ctx: StepContext): StateChangeModel | StateViewModel {
  return modelFor(c, viewModelInput(c, ctx.job.dispatch, ctx.get<PrepareOutput>("prepare").appDir));
}
