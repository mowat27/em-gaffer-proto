/**
 * verify: the verifier's verdict on the build, as a workflow step (agentics/builders/supabase-api-verified). It runs
 * the `verify` tool's logic (ops/core/verify.ts: the verifier agent's checks in a fresh process) on the app directory
 * against the dispatch's slice, measuring the build from the job's base, so a committed build is judged by everything
 * it changed. The verdict is the step's output, `outputs/verify.json` in the context store (`context_get(run,
 * "verify")`). A `fail` verdict fails the run with the verdict's summary as the reason, and its verify.json is still
 * stored (StepFailure), so the findings can be read after the run.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verify, type VerifyResult } from "../../ops/core/verify.ts";
import type { RuntimeOptions } from "../../runtime/run.ts";
import type { StepContext } from "../types.ts";
import { StepFailure } from "../workflow.ts";
import type { PrepareOutput } from "./prepare.ts";

/** The reason a failed verdict gives: `FAIL: <summary>`, then the failed and unsure findings' ids. */
export function verdictReason(v: Pick<VerifyResult, "summary" | "findings">): string {
  const ids = [...v.findings.filter((f) => f.status === "fail").map((f) => f.id), ...v.findings.filter((f) => f.status === "check").map((f) => `${f.id} (unsure)`)];
  return `FAIL: ${v.summary}${ids.length ? `: ${ids.join(", ")}` : ""}`;
}

/** Where the app is: the prepare step's app directory when the workflow has one, else the workspace root. */
function appDirOf(ctx: StepContext): string {
  try {
    return ctx.get<PrepareOutput>("prepare").appDir;
  } catch {
    return ctx.dir;
  }
}

export async function verifyStep(ctx: StepContext): Promise<VerifyResult> {
  const dir = appDirOf(ctx);
  let slice = join(dir, ".slice.json");
  if (!existsSync(slice)) {
    // No prepare step wrote the slice beside the app: the dispatch's goes in the run's folder.
    slice = join(ctx.runtime.dir(ctx.job.runId), "verify-slice.json");
    writeFileSync(slice, JSON.stringify(ctx.job.dispatch.slice ?? null, null, 2));
  }
  const agentics = (ctx.runtime as { options?: RuntimeOptions }).options?.agenticsDir;
  ctx.emit("verify.start", `verifying ${dir} since ${ctx.job.dispatch.repo.base.slice(0, 12)}`);
  const v = await verify(dir, slice, ctx.job.dispatch.repo.base, { signal: ctx.signal, ...(agentics ? { agentics } : {}) });
  ctx.emit("verify.verdict", `${v.verdict.toUpperCase()}: ${v.summary}`, { verdict: v.verdict, summary: v.summary });
  if (v.verdict === "fail") throw new StepFailure(verdictReason(v), v);
  return v;
}
