/**
 * supabase-api: the production build as a workflow. clone the app at base; prepare it (branch, excludes, npm ci, tsc,
 * .slice.json); classify the slice (kind and verdict, in code); scaffold it from the kind's template set
 * (templates/<kind>/, rendered with its view model, view-model.ts); let the agent agentics/agents/supabase-api fill
 * the scaffold with its `/implement` prompt template and hand it over with `done`; rerun the commit-scope checks;
 * commit and return the app's patch. A kind with no template set, or a render error, skips the scaffold and the agent
 * builds from the skills. A sidecar, the tool-summariser agent, summarises every 10 tool calls of the job in two lines
 * (engine/sidecars.ts): a `sidecar.output` event in the workflow run's journal, never on the step path.
 *
 * `supabaseApi(options)` builds the same workflow with other options (the contract tests use it); the default export
 * is the production one.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir } from "../../../runtime/paths.ts";
import { piSettings } from "../../../runtime/pi.ts";
import { commitScopeChecks } from "../../../engine/steps/checks.ts";
import { classify, type Classification, type SliceKind } from "../../../engine/steps/classify.ts";
import { clone } from "../../../engine/steps/clone.ts";
import { commit } from "../../../engine/steps/commit.ts";
import { prepare, type PrepareOutput } from "../../../engine/steps/prepare.ts";
import type { Builder, StepContext } from "../../../engine/types.ts";
import { sidecar, type Sidecar } from "../../../engine/sidecars.ts";
import { agent, code, defineBuilder, template } from "../../../engine/workflow.ts";
import { SLICE_FILE } from "./checks.ts";
import { viewModel } from "./view-model.ts";

/** This builder's template sets, one directory per slice kind. */
export const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "templates");

export interface SupabaseApiOptions {
  provides: string[];
  budgetMinutes: number;
  appDir: string;
  setup: string[];
  baseCheck: string[];
  setupTimeoutMinutes: number;
  /** The implement step's agent: an id in agentics/agents/. */
  agent: string;
  implementBudgetMinutes: number;
  /** Where the template sets are: <templates>/<kind>/. */
  templates: string;
  /** Runs started on batches of the job's journal events (engine/sidecars.ts). */
  sidecars: Sidecar[];
}

export const DEFAULTS: SupabaseApiOptions = {
  // stack:supabase is the capability in docs/contract.md; stack:stub is what the gaffer sends today.
  provides: ["stack:supabase", "stack:stub"],
  budgetMinutes: 20,
  appDir: ".",
  setup: ["npm ci"],
  baseCheck: ["npx tsc --noEmit"],
  setupTimeoutMinutes: 10,
  agent: "supabase-api",
  implementBudgetMinutes: 10,
  templates: TEMPLATES,
  sidecars: [sidecar("tool-summariser", { on: "tool.end", every: 10 })],
};

/** The template set for a slice kind. */
export const templatesDir = (kind: SliceKind, root = TEMPLATES): string => join(root, kind);

/**
 * The `/implement` template's arguments (the agent's prompt, prompts/implement.md): the same `/implement arg1 arg2
 * ...` a human types in an interactive pi session. The runtime starts the agent with them and sets the BUILDER_* job
 * variables from the dispatch, which shared:context puts in the system prompt with the slice and scaffold summary.
 */
export function implementArgs(ctx: StepContext, model: string): string[] {
  const d = ctx.job.dispatch;
  // The slice spec is deliberately first: it is the primary input to every build.
  return [SLICE_FILE, d.task.title, d.task.context, d.task.sliceId, String(d.task.attempt), d.repo.base, model, new Date().toISOString()];
}

export function supabaseApi(options: Partial<SupabaseApiOptions> = {}): Builder {
  const o = { ...DEFAULTS, ...options };
  const appDir = (ctx: StepContext) => ctx.get<PrepareOutput>("prepare").appDir;
  return defineBuilder({
    name: "supabase-api",
    provides: o.provides,
    budgetMinutes: o.budgetMinutes,
    steps: [
      code("clone", clone({ repo: "app" })),
      code("prepare", prepare({ appDir: o.appDir, setup: o.setup, baseCheck: o.baseCheck, setupTimeoutMinutes: o.setupTimeoutMinutes })),
      code("classify", classify),
      template("scaffold", {
        set: (ctx) => templatesDir(ctx.get<Classification>("classify").kind, o.templates),
        data: (ctx) => viewModel(ctx.get<Classification>("classify"), ctx),
        dir: appDir,
      }),
      agent("implement", {
        agent: o.agent,
        args: (ctx) => implementArgs(ctx, piSettings(agentDir(o.agent)).model),
        cwd: appDir,
        budgetMinutes: o.implementBudgetMinutes,
      }),
      code("checks", commitScopeChecks),
      code("commit", commit({ repo: "app" })),
    ],
    sidecars: o.sidecars,
  });
}

export default supabaseApi();
