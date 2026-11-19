// Context: what the run is working on, in front of the agent without a tool call. The context store itself is read
// with the `context_get` tool, which is an ops/core tool (ops/core/observe.ts) the runner registers through
// ops/pi-extension.ts when the agent.yml enables it; this extension and the tool share the one lookup in
// engine/context.ts.
//
// - The job section: the run's BUILDER_* job variables (set by the runtime from the run's dispatch) in the system
//   prompt, as `systemPromptOptions.sections.builder_job`, which pi renders as a `<builder_job>` block. The halt and
//   done files are left out: they are the tools' business, not the agent's. A run without a dispatch
//   ($BUILDER_JOB_ID unset) gets no section.
// - The slice file: a run with a dispatch has it in runs/<id>/context/job.json. When the working directory has no
//   `.slice.json`, or one that is not this dispatch's slice, it is written there and kept out of git through
//   .git/info/exclude, so a directly launched agent starts as a workflow's agent step does (its prepare step writes
//   the same file).
// - The slice section: a short summary of the slice (kind, verdict, its elements, what changed) and, when the
//   workflow above has run its classify and scaffold steps, of the scaffold (files, injections, tasks, BUILD:
//   markers), as `systemPromptOptions.sections.builder_slice`. The full report stays behind context_get.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findStepOutput, readContextJob } from "../../../engine/context.ts";

/** The variables shown to the agent, in order, keyed by name. The agent's instructions map them to tokens. */
const FIELDS = ["BUILDER_SLICE_TITLE", "BUILDER_SLICE_CONTEXT", "BUILDER_SLICE_ID", "BUILDER_SLICE_FILE", "BUILDER_ATTEMPT", "BUILDER_BASE", "BUILDER_JOB_ID"];

export const SLICE_FILE = ".slice.json";

/** The job section's text, or null outside a run with a dispatch. */
export function jobSection(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.BUILDER_JOB_ID) return null;
  const rows = FIELDS.filter((key) => env[key]).map((key) => `| \`${key}\` | \`${env[key]}\` |`);
  return ["You are running in a builder job that builds exactly one slice.", "", "| Variable | Value |", "|---|---|", ...rows].join("\n");
}

/** This run's job.json (the dispatch it works on), or undefined. */
export function readJob(runDir = process.env.BUILDER_RUN_DIR): { dispatch?: { slice?: unknown } } | undefined {
  return readContextJob(runDir) as { dispatch?: { slice?: unknown } } | undefined;
}

/**
 * Write the dispatch's slice to `.slice.json` in `cwd` when it is missing or holds another slice, and exclude it from
 * git. Returns what it did.
 */
export function ensureSliceFile(cwd: string, slice: unknown): "written" | "replaced" | "kept" {
  const file = join(cwd, SLICE_FILE);
  const text = JSON.stringify(slice ?? null, null, 2);
  let did: "written" | "replaced" | "kept" = "kept";
  if (!existsSync(file)) did = "written";
  else if (readFileSync(file, "utf8") !== text) did = "replaced";
  if (did !== "kept") {
    // Removed first so a tracked file or symlink of that name is replaced, never written through.
    rmSync(file, { force: true });
    writeFileSync(file, text);
  }
  try {
    const p = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const exclude = isAbsolute(p) ? p : resolve(cwd, p);
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const entry = `${prefix}${SLICE_FILE}`;
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : [];
    if (!current.includes(entry) && !current.includes(SLICE_FILE) && !current.includes(`/${entry}`)) appendFileSync(exclude, `\n${entry}\n`);
  } catch {
    /* not a git repository: nothing to keep it out of */
  }
  return did;
}

/** A finished step's output: this run's context store first, then each run above it (engine/context.ts). */
export function stepOutput(step: string, runDir = process.env.BUILDER_RUN_DIR): { found: true; value: unknown; run: string } | { found: false } {
  return findStepOutput(step, runDir);
}

// ---- the slice section ----

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const titles = (v: unknown): string[] => arr(v).map((e) => String(rec(e)?.title ?? "?"));
const listed = (xs: string[], max: number) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", ")) || "none";

/** The classify step's output, as far as the summary needs it. */
interface ClassifyLike {
  kind?: string;
  verdict?: string;
}

/** The template step's report (engine/templates.ts ScaffoldReport), as far as the summary needs it. */
interface ReportLike {
  kind?: string;
  skipped?: { reason?: string };
  files?: { path: string; action: string }[];
  injections?: { target: string; key: string; action: string; reason?: string }[];
  tasks?: string[];
  markers?: { path: string; line: number; text: string }[];
}

/**
 * The slice section's text: the slice and what changed, then the scaffold when there is a report. Pure. `dispatch` is
 * the job's dispatch; `classify` and `scaffold` the step outputs, when the workflow above produced them.
 */
export function sliceSummary(dispatch: unknown, classify?: ClassifyLike, scaffold?: ReportLike): string | null {
  const d = rec(dispatch);
  const task = rec(d?.task);
  const slice = rec(d?.slice);
  if (!d || !task) return null;
  const out: string[] = [];
  const kind = classify?.kind ?? scaffold?.kind;
  const verdict = classify?.verdict ?? (String(rec(d.changes)?.verdict ?? "NEW").toUpperCase() === "CHANGED" ? "CHANGED" : "NEW");
  const what = kind ? `a ${kind} slice` : `sliceType ${String(slice?.sliceType ?? "unknown")}`;
  out.push(`Slice ${String(task.context)}/${String(task.title)}: ${what}, verdict ${verdict}${verdict === "NEW" ? " (build the whole slice)" : " (rework what changed)"}.`);
  if (slice) {
    const parts = [`Commands: ${listed(titles(slice.commands), 6)}`, `Events: ${listed(titles(slice.events), 6)}`, `Read models: ${listed(titles(slice.readmodels), 6)}`];
    const sources = arr(d.sourceEvents).map((s) => String(rec(rec(s)?.event)?.title ?? "?"));
    if (sources.length) parts.push(`Source events: ${listed(sources, 6)}`);
    parts.push(`Specifications: ${arr(slice.specifications).length}`);
    out.push(`${parts.join(". ")}.`);
  }
  const changes = rec(d.changes);
  if (verdict === "CHANGED" && changes) {
    const el = rec(changes.elements);
    const se = rec(changes.sourceEvents);
    const group = (g: Rec | null, k: string) => arr(g?.[k]).map((c) => `${String(rec(c)?.kind ?? "")} ${String(rec(c)?.title ?? "?")}`.trim());
    const parts = (["changed", "added", "removed"] as const).map((k) => `${k}: ${listed(group(el, k), 4)}`);
    const src = (["changed", "added", "removed"] as const).flatMap((k) => group(se, k).map((t) => `${t} (${k})`));
    out.push(`Changes since the last build: ${parts.join("; ")}${src.length ? `; source events: ${listed(src, 4)}` : ""}. The details (and \`before\`) are in the job: context_get with no step.`);
  }
  if (scaffold) {
    out.push("");
    if (scaffold.skipped) {
      out.push(`Scaffold: skipped (${scaffold.skipped.reason ?? "no reason"}). Build the slice from the build skill for its kind.`);
    } else {
      const files = scaffold.files ?? [];
      const created = files.filter((f) => f.action === "created").map((f) => f.path);
      const kept = files.filter((f) => f.action === "kept").map((f) => f.path);
      const inj = scaffold.injections ?? [];
      const markers = scaffold.markers ?? [];
      const tasks = scaffold.tasks ?? [];
      out.push('Scaffold (the full report: context_get with step "scaffold"):');
      out.push(`- created: ${listed(created, 8)}`);
      if (kept.length) out.push(`- kept (they existed; not overwritten): ${listed(kept, 8)}`);
      if (inj.length) out.push(`- injections: ${listed(inj.map((i) => `${i.target} ${i.action}`), 8)}`);
      const perFile = new Map<string, number>();
      for (const m of markers) perFile.set(m.path, (perFile.get(m.path) ?? 0) + 1);
      out.push(`- BUILD: markers to fill: ${markers.length}${markers.length ? ` (${listed([...perFile].map(([p, n]) => `${p} ${n}`), 8)})` : ""}`);
      if (tasks.length) out.push(`- tasks: ${tasks.length}; ${listed(tasks.map((t) => t.split("\n")[0]), 4)}`);
    }
  }
  return out.join("\n");
}

/** The slice section for this run: its job, and the classify and scaffold outputs of the workflow above it. */
export function sliceSection(runDir = process.env.BUILDER_RUN_DIR): string | null {
  const job = readJob(runDir);
  if (!job?.dispatch) return null;
  const value = (step: string) => {
    const out = stepOutput(step, runDir);
    return out.found ? (rec(out.value) ?? undefined) : undefined;
  };
  return sliceSummary(job.dispatch, value("classify") as ClassifyLike | undefined, value("scaffold") as ReportLike | undefined);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const job = readJob();
    if (job?.dispatch && "slice" in job.dispatch) ensureSliceFile(ctx.cwd, job.dispatch.slice);
  });

  pi.on("before_agent_start", (event) => {
    const section = jobSection();
    if (section) event.systemPromptOptions.sections.builder_job = section;
    try {
      const slice = sliceSection();
      if (slice) event.systemPromptOptions.sections.builder_slice = slice;
    } catch {
      /* a summary is a convenience: the agent still has context_get */
    }
  });
}
