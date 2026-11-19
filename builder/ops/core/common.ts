/** What several core groups share: finding a run by any of its names, and a run in one line. */
import { jobName } from "../../engine/job-name.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { ToolError, type ToolContext } from "./tool.ts";

export const runsDirOf = (ctx: ToolContext): string => ctx.runtime.options.runsDir;

/**
 * A run by reference: its id, the job id or job name of a server job (the job's workflow run), `latest` (the newest
 * run), `self` (the calling agent's run), or the start of an id (unique). Throws a ToolError naming what was tried.
 */
export function findRun(ctx: ToolContext, ref: string): RunRecord {
  const r = ref.trim();
  if (r === "self") {
    if (!ctx.caller.runId) throw new ToolError("invalid", "self names the calling run, and this caller is not a run");
    return findRun(ctx, ctx.caller.runId);
  }
  const exact = ctx.runtime.get(r);
  if (exact) return exact;
  const runs = ctx.runtime.list();
  if (r === "latest") {
    const newest = runs[runs.length - 1];
    if (!newest) throw new ToolError("failed", `no runs in ${runsDirOf(ctx)}`);
    return newest;
  }
  const job = runs.filter((x) => x.job && (x.job.jobId === r || jobName(x.job.jobId) === r));
  if (job.length) return job[job.length - 1];
  const prefix = r.length >= 4 ? runs.filter((x) => x.id.startsWith(r)) : [];
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) throw new ToolError("invalid", `run ${r} is ambiguous: ${prefix.map((x) => x.id).join(", ")}`);
  throw new ToolError("failed", `no run ${r} in ${runsDirOf(ctx)} (a run id, a job id or name, latest or self)`);
}

/** The run a tool works on: the one named, else the calling agent's own. */
export function runOrSelf(ctx: ToolContext, ref: string | undefined, tool: string): RunRecord {
  if (ref) return findRun(ctx, ref);
  if (ctx.caller.runId) return findRun(ctx, ctx.caller.runId);
  throw new ToolError("invalid", `${tool} needs a run`);
}

/** The root of a run's tree: the job's workflow run for any run inside a job. */
export function rootOf(ctx: ToolContext, rec: RunRecord): RunRecord {
  let cur = rec;
  for (let depth = 0; cur.parent && depth < 32; depth++) {
    const up = ctx.runtime.get(cur.parent);
    if (!up) break;
    cur = up;
  }
  return cur;
}

export interface RunSummary {
  id: string;
  kind: RunRecord["kind"];
  /** agent:<id>, workflow:<id>, or the kind of a run that is neither (the server). */
  target: string;
  state: RunRecord["state"];
  step?: string;
  mode?: string;
  parent: string | null;
  startedAt: string;
  endedAt?: string;
  jobId?: string;
  job?: string;
  name?: string;
  outcome?: string;
  reason?: string;
  detach?: boolean;
}

/** A run in one line's worth of fields. */
export function summarizeRun(rec: RunRecord): RunSummary {
  const r = rec.result;
  return {
    id: rec.id,
    kind: rec.kind,
    target: rec.spec.agent ? `agent:${rec.spec.agent}` : rec.spec.workflow ? `workflow:${rec.spec.workflow}` : String(rec.kind),
    state: rec.state,
    ...(rec.step ? { step: rec.step } : {}),
    ...(rec.resolved?.mode ? { mode: rec.resolved.mode } : {}),
    parent: rec.parent,
    startedAt: rec.startedAt,
    ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
    ...(rec.job ? { jobId: rec.job.jobId, job: jobName(rec.job.jobId) } : {}),
    ...(rec.spec.name ? { name: rec.spec.name } : {}),
    ...(r ? { outcome: r.outcome, ...(r.outcome === "failed" ? { reason: r.reason } : {}) } : {}),
    ...(rec.spec.detach ? { detach: true } : {}),
  };
}

/** Is `ancestor` the run itself or above it? */
export function isAncestor(ctx: ToolContext, ancestor: string, rec: RunRecord): boolean {
  let cur: RunRecord | null = rec;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.id === ancestor) return true;
    cur = cur.parent ? ctx.runtime.get(cur.parent) : null;
  }
  return false;
}
