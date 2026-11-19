/**
 * checks: the slice commit-scope checks (agentics/builders/supabase-api/checks.ts) on everything changed in the app since
 * base. The agent's `done` tool runs the same checks and the agent fixes what they list; this step is the backstop
 * after done.
 */
import { allChanges, builderExceptions, formatViolations, runChecks } from "../../agentics/builders/supabase-api/checks.ts";
import type { StepContext } from "../types.ts";
import type { PrepareOutput } from "./prepare.ts";

export async function commitScopeChecks(ctx: StepContext): Promise<{ violations: [] }> {
  const { appDir } = ctx.get<PrepareOutput>("prepare");
  const violations = runChecks(appDir, allChanges(appDir, ctx.job.dispatch.repo.base), builderExceptions());
  if (violations.length) throw new Error(`slice commit-scope checks failed after done:\n${formatViolations(violations)}`);
  return { violations: [] };
}
