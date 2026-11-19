/**
 * supabase-api-verified: the supabase-api build, then the verifier's verdict on it (design section 12). The build runs
 * inline as a workflow step (clone, prepare, classify, scaffold, implement, checks, commit, all in this run's context
 * store); the verify step judges the committed build against the slice with the verifier agent's current rules and
 * stores its verdict as verify.json (`context_get(run, "verify")`). A `fail` verdict fails the run with the verdict's
 * summary as the reason, so a run is done only when the build passed. The dev loop runs it (agents/dev/slice-lab), with
 * the `app` repository cloned from a local folder or from the previous run's workspace through `input.repos`.
 *
 * It provides what supabase-api provides, so it can also be the active builder; a job then gets a patch only when the
 * verifier passes it.
 */
import { verifyStep } from "../../../engine/steps/verify.ts";
import { code, defineBuilder, workflow } from "../../../engine/workflow.ts";
import { DEFAULTS } from "../supabase-api/builder.ts";

/** The verifier's code checks plus one Jev request, which it retries for up to about 8 minutes when Jev is slow. */
export const VERIFY_BUDGET_MINUTES = 10;

export default defineBuilder({
  name: "supabase-api-verified",
  provides: DEFAULTS.provides,
  budgetMinutes: DEFAULTS.budgetMinutes + VERIFY_BUDGET_MINUTES,
  steps: [workflow("build", "supabase-api"), code("verify", verifyStep, { budgetMinutes: VERIFY_BUDGET_MINUTES })],
});
