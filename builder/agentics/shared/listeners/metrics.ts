/**
 * metrics: running totals per step and per tool over a workflow run and its child runs, written to the workflow
 * run's summary.json under `listeners.metrics`:
 *
 *   steps: { <step>: { status?, ms?, turns, toolCalls, toolErrors, tokens: { input, output, cacheRead }, cost } }
 *   tools: { <tool>: { calls, errors, ms } }
 *
 * Loaded for every workflow run (agentics/shared/listeners/). One workflow run per process, so the totals live in the
 * module.
 */
import { defineListener } from "../../../engine/listeners.ts";

interface StepTotals {
  status?: string;
  ms?: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokens: { input: number; output: number; cacheRead: number };
  cost: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const steps: Record<string, StepTotals> = {};
const tools: Record<string, { calls: number; errors: number; ms: number }> = {};

const stepOf = (name: string | undefined): StepTotals =>
  (steps[name ?? "(none)"] ??= { turns: 0, toolCalls: 0, toolErrors: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, cost: 0 });

export default defineListener({
  name: "metrics",
  on: "*",
  handle(e, api) {
    const d = e.data ?? {};
    switch (e.kind) {
      case "step.end": {
        const s = stepOf(e.step);
        s.status = String(d.status ?? "");
        s.ms = num(d.ms);
        break;
      }
      case "turn.end":
        stepOf(e.step).turns++;
        break;
      case "tool.end": {
        const s = stepOf(e.step);
        const t = (tools[String(d.tool ?? "?")] ??= { calls: 0, errors: 0, ms: 0 });
        s.toolCalls++;
        t.calls++;
        t.ms += num(d.ms);
        if (d.isError === true) {
          s.toolErrors++;
          t.errors++;
        }
        break;
      }
      case "model.usage": {
        const s = stepOf(e.step);
        s.tokens.input += num(d.input);
        s.tokens.output += num(d.output);
        s.tokens.cacheRead += num(d.cacheRead);
        s.cost += num(d.cost);
        break;
      }
      default:
        return;
    }
    api.summary({ steps, tools });
  },
});
