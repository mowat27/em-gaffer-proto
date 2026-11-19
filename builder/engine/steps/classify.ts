/**
 * classify: the slice's kind and verdict, from the dispatch alone. Generic: it reads the slice's shape, not any stack.
 *
 * Rules, in this order (the classification build.md asked the model to do):
 *   - no slice, or no commands, events, read models, screens or processors: the step fails
 *   - sliceType WEBHOOK: webhook
 *   - sliceType TRANSLATION: translation
 *   - processors: automation
 *   - sliceType STATE_VIEW, or read models without commands: state-view
 *   - otherwise: state-change
 * The verdict is the dispatch's `changes.verdict`: CHANGED, else NEW (also when the dispatch has no `changes`).
 */
import type { Dispatch, StepContext } from "../types.ts";

export type SliceKind = "state-change" | "state-view" | "automation" | "webhook" | "translation";
export type Verdict = "NEW" | "CHANGED";

export interface Classification {
  kind: SliceKind;
  verdict: Verdict;
  /** The slice's context, as the dispatch names it (task.context). */
  context: string;
  /** The slice's title, as the dispatch names it (task.title). */
  slice: string;
  /** The slice's own sliceType, or null when it has none. */
  sliceType: string | null;
}

export const EMPTY_SLICE = "the slice has no commands, events, read models, screens or processors";

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** NEW or CHANGED, from the dispatch's changes. */
export function verdictOf(d: Pick<Dispatch, "changes">): Verdict {
  const v = d.changes && typeof d.changes === "object" ? (d.changes as { verdict?: unknown }).verdict : undefined;
  return typeof v === "string" && v.toUpperCase() === "CHANGED" ? "CHANGED" : "NEW";
}

/** The classification of a dispatch. Throws EMPTY_SLICE when there is nothing to build. */
export function classifyDispatch(d: Pick<Dispatch, "slice" | "changes" | "task">): Classification {
  const s = d.slice && typeof d.slice === "object" && !Array.isArray(d.slice) ? (d.slice as Record<string, unknown>) : null;
  if (!s) throw new Error(EMPTY_SLICE);
  const [commands, events, readmodels, screens, processors] = ["commands", "events", "readmodels", "screens", "processors"].map((k) => list(s[k]));
  if (![commands, events, readmodels, screens, processors].some((l) => l.length)) throw new Error(EMPTY_SLICE);
  const sliceType = typeof s.sliceType === "string" && s.sliceType ? s.sliceType : null;
  const type = sliceType?.toUpperCase() ?? "";
  let kind: SliceKind;
  if (type === "WEBHOOK") kind = "webhook";
  else if (type === "TRANSLATION") kind = "translation";
  else if (processors.length) kind = "automation";
  else if (type === "STATE_VIEW" || (readmodels.length && !commands.length)) kind = "state-view";
  else kind = "state-change";
  return { kind, verdict: verdictOf(d), context: d.task.context, slice: d.task.title, sliceType };
}

/** The step: classifies the job's dispatch. */
export async function classify(ctx: StepContext): Promise<Classification> {
  const c = classifyDispatch(ctx.job.dispatch);
  ctx.emit("classify", `${c.context}/${c.slice}: ${c.kind}, ${c.verdict}`, { kind: c.kind, verdict: c.verdict, sliceType: c.sliceType });
  return c;
}
