/**
 * commit: one commit on base in the named repository holding everything left in the workspace, with the job's
 * metadata as git trailers, then `git format-patch base..HEAD` as that repository's patch. The agent's metrics (turns,
 * tool calls, tokens, cost, duration) come from the journal of the agent step's run, the step durations from the
 * workflow run's own journal.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_FILE, journalMetrics, stepDurations, type JournalMetrics } from "../../runtime/journal.ts";
import type { PiSettings } from "../../runtime/pi.ts";
import { jobName } from "../job-name.ts";
import { fmtDuration, fmtNum } from "../pi-session.ts";
import type { Job, StepContext } from "../types.ts";
import { git, repoKey } from "./clone.ts";

/** What an agent step stores: its run id and the agent's done data. */
export interface AgentStepOutput {
  runId: string;
  done?: unknown;
  pi?: PiSettings;
}

/** Slice fields that change without the slice's definition changing: board state, discussion, assignment. */
const VOLATILE_SLICE_FIELDS = new Set(["status", "comments", "assignee", "ticketNumber"]);

/** JSON with object keys sorted at every level, so equal definitions serialise identically. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The slice's version: a hash of its definition (commands, events, read models, screens, specifications...) without
 * the volatile fields. The board keeps no version number, so two builds of an unchanged slice get the same version
 * and any change to the slice in the model gives a new one.
 */
export function sliceVersion(slice: unknown): string {
  const def = slice && typeof slice === "object" && !Array.isArray(slice) ? Object.fromEntries(Object.entries(slice).filter(([k]) => !VOLATILE_SLICE_FIELDS.has(k))) : slice;
  return createHash("sha256").update(canonicalJson(def)).digest("hex").slice(0, 12);
}

/** A run's metrics from its journal, or null when it kept none. */
export function agentMetrics(runDir: string): JournalMetrics | null {
  return existsSync(join(runDir, JOURNAL_FILE)) ? journalMetrics(runDir) : null;
}

/** `clone 3s, prepare 41s, implement 4m 12s`: the finished steps' durations, in order. */
export function formatStepDurations(steps: { step: string; ms: number }[]): string | null {
  return steps.length ? steps.map((s) => `${s.step} ${fmtDuration(s.ms)}`).join(", ") : null;
}

/** The commit message: a plain subject, then the job's metadata as git trailers (`git log --format=%(trailers)`). */
export function commitMessage(job: Job, agent: { pi: PiSettings | null; metrics: JournalMetrics | null }, steps: { step: string; ms: number }[] = []): string {
  const d = job.dispatch;
  const slice = (d.slice && typeof d.slice === "object" ? d.slice : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const live = agent.pi;
  const m = agent.metrics;
  const trailers: [string, string | null][] = [
    ["Slice", d.task.title],
    ["Slice-Id", d.task.sliceId],
    ["Slice-Version", sliceVersion(d.slice)],
    ["Slice-Type", text(slice.sliceType)],
    ["Context", d.task.context],
    ["Chapter", text(slice.chapterTitle) ?? text(slice.chapter)],
    ["Attempt", String(d.task.attempt)],
    ["Handover", d.task.handover ? "on" : "off"],
    ["Job-Id", job.jobId],
    ["Job-Name", jobName(job.jobId)],
    ["Base", d.repo.base],
    ["Repository", repoKey(d.repo.url)],
    ["Builder", job.builder ? job.builder.name : null],
    ["Builder-Version", job.builder?.version ? job.builder.version.slice(0, 12) : null],
    ["Agent", live ? `pi ${live.provider}/${live.model}` : null],
    ["Agent-Thinking", live ? text(live.thinking) : null],
    ["Agent-Duration", m ? fmtDuration(m.durationMs) : null],
    ["Agent-Turns", m ? String(m.turns) : null],
    ["Agent-Tool-Calls", m ? `${m.toolCalls} (${m.toolErrors} errors)` : null],
    ["Agent-Tokens", m ? `input ${fmtNum(m.tokens.input)}, cache read ${fmtNum(m.tokens.cacheRead)}, output ${fmtNum(m.tokens.output)}` : null],
    ["Agent-Cost", m && m.cost ? `$${m.cost.toFixed(4)}` : null],
    ["Step-Durations", formatStepDurations(steps)],
    ["Job-Duration", fmtDuration(Date.now() - job.startedAt)],
    ["Built-At", new Date().toISOString()],
  ];
  return [`Build slice ${d.task.context}/${d.task.title}`, "", ...trailers.filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`)].join("\n");
}

export interface CommitOutput {
  patches: Record<string, string>;
  commits: number;
  bytes: number;
}

/** `agentStep` names the step whose agent run the trailers describe (default "implement"). */
export function commit(o: { repo: "app"; agentStep?: string }): (ctx: StepContext) => Promise<CommitOutput> {
  const agentStep = o.agentStep ?? "implement";
  return async (ctx) => {
    let agent: AgentStepOutput | null = null;
    try {
      agent = ctx.get<AgentStepOutput>(agentStep);
    } catch {
      /* no agent step in this workflow */
    }
    const metrics = agent?.runId ? agentMetrics(ctx.runtime.dir(agent.runId)) : null;
    const steps = stepDurations(ctx.runtime.dir(ctx.job.runId)).filter((s) => s.status === "ok");
    const base = ctx.job.dispatch.repo.base;
    const dirty = git(ctx.dir, ["status", "--porcelain"]);
    if (dirty) {
      git(ctx.dir, ["add", "-A"]);
      git(ctx.dir, ["commit", "-q", "-m", commitMessage(ctx.job, { pi: agent?.pi ?? null, metrics }, steps)]);
    }
    const count = Number(git(ctx.dir, ["rev-list", "--count", `${base}..HEAD`]));
    if (!count) throw new Error("the agent produced no changes");
    const patch = git(ctx.dir, ["format-patch", "--stdout", `${base}..HEAD`]);
    ctx.emit("patch", `${count} commit(s), patch ${patch.length} bytes`, { commits: count, bytes: patch.length });
    return { patches: { [o.repo]: patch }, commits: count, bytes: patch.length };
  };
}
