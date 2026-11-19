/** One line per journal or feed event, for `builder logs` and `builder events`. */
import { clock, oneLine } from "./common.ts";

type Data = Record<string, unknown>;
const s = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
/** A payload as written: the value, or a blob marker's preview. */
const text = (v: unknown): string => (v && typeof v === "object" && "preview" in (v as Data) ? s((v as Data).preview) : s(v));

/** What an event says, in a few words. */
export function summary(kind: string, d: Data): string {
  switch (kind) {
    case "tool.start":
      return `${s(d.tool)} ${oneLine(text(d.input), 120)}`;
    case "tool.end":
      return `${s(d.tool)} ${s(d.outcome) || (d.isError ? "error" : "ok")} ${s(d.ms)}ms ${oneLine(text(d.output), 100)}`;
    case "tool.gate":
      return `${s(d.tool)} ${s(d.decision)} by ${s(d.gate)}${d.reason ? `: ${oneLine(s(d.reason), 100)}` : ""}`;
    case "step.start":
      return `${s(d.stepKind)}${d.childRunId ? ` run ${s(d.childRunId)}` : ""}${d.agent ? ` agent ${s(d.agent)}` : ""}`;
    case "step.end":
      return `${s(d.status)} ${s(d.ms)}ms${d.reason ? ` ${oneLine(s(d.reason), 120)}` : ""}`;
    case "run.start":
      return `${d.agent ? `agent ${s(d.agent)}` : d.workflow ? `workflow ${s(d.workflow)}` : s(d.kind)} ${s(d.mode)}${d.parent ? ` parent ${s(d.parent)}` : ""}`;
    case "run.end":
      return `${s(d.state)}${d.reason ? `: ${oneLine(s(d.reason), 120)}` : ""}`;
    case "turn.end":
      return `turn ${s(d.turn)}, ${s(d.toolCalls)} tool call(s)`;
    case "model.usage":
      return `${s(d.model)} in ${s(d.input)} out ${s(d.output)} $${s(d.cost)}`;
    case "server.state":
      return `${s(d.state)}${d.jobId ? ` ${s(d.name) || s(d.jobId)}` : ""}${d.step ? ` at ${s(d.step)}` : ""}`;
    case "job.accepted":
      return `${s(d.name)} ${s(d.slice)} attempt ${s(d.attempt)}`;
    case "job.result":
      return `${s(d.outcome)}${d.reason ? `: ${oneLine(s(d.reason), 120)}` : ""}`;
    case "control.received":
      return `${s(d.action)}${d.by ? ` from ${s(d.by)}` : ""}`;
    case "control.applied": {
      const r = (d.result ?? {}) as Data;
      return `${s(d.action)} ${r.ok ? "applied" : `refused: ${s(r.error)}`}`;
    }
    case "config.loaded":
      return d.ok === false ? `failed: ${oneLine(s(d.error), 120)}` : `${Array.isArray(d.layers) ? d.layers.length : "?"} layer(s)${Array.isArray(d.runs) ? `, ${d.runs.length} live run(s) told` : ""}${Array.isArray(d.removed) && d.removed.length ? `, removed ${d.removed.join(", ")}` : ""}`;
    default:
      return oneLine(d.msg !== undefined ? s(d.msg) : JSON.stringify(d), 160);
  }
}

/** `#12 10:04:11 implement tool.end read ok 3ms …` */
export function eventLine(e: { seq: number; ts: string; kind: string; step?: string; runId?: string; data: Data }, withRun = false): string {
  return [`#${e.seq}`, clock(e.ts), ...(withRun && e.runId ? [e.runId] : []), ...(e.step ? [e.step] : []), e.kind, summary(e.kind, e.data)].filter(Boolean).join(" ");
}
