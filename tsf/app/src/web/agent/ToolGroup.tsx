import { ActivityLog, ActivityStep, type ActivityStatus } from "@pw/ui/react";
import type { ChatItem, ToolStatus } from "../../shared/types.ts";

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const DETAIL_CAP = 2_000;

/** `create_page` -> "Create page". */
export function humanise(name: string): string {
  const words = name.replace(/[_.-]+/g, " ").trim();
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function cap(text: string): string {
  return text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}\n... (${text.length - DETAIL_CAP} more characters)` : text;
}

/** The first short string argument (`path`, `from`, `command`, `query`), for the step's one-line note. */
function argSummary(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "from", "command", "query", "name", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      const one = value.split("\n")[0]!;
      return one.length > 80 ? `${one.slice(0, 77)}...` : one;
    }
  }
  return undefined;
}

/**
 * `blocked`, `interrupted` and `unavailable` show as failed with the diagnostic as the note (DESIGN 11). A tool still
 * pending or running when no run is live was cut off, so it shows as stopped rather than spinning for ever.
 */
export function stepStatus(status: ToolStatus, busy: boolean): ActivityStatus {
  switch (status) {
    case "done":
      return "done";
    case "pending":
    case "running":
      return busy ? "running" : "stopped";
    default:
      return "failed";
  }
}

function groupStatus(steps: readonly ActivityStatus[]): ActivityStatus {
  if (steps.includes("running")) return "running";
  if (steps.includes("failed")) return "failed";
  if (steps.includes("stopped")) return "stopped";
  return "done";
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n").find((l) => l.trim() !== "");
  return line === undefined ? undefined : line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function Step({ tool, busy }: { tool: ToolItem; busy: boolean }) {
  const status = stepStatus(tool.status, busy);
  const failed = status === "failed";
  const note = failed ? [tool.diagnostic, firstLine(tool.output)].filter(Boolean).join(": ") || undefined : argSummary(tool.args);
  const argsText = JSON.stringify(tool.args, null, 2);
  const hasArgs = argsText !== undefined && argsText !== "{}";
  const detail =
    hasArgs || tool.output ? (
      <>
        {hasArgs && (
          <pre>
            <code>{cap(argsText)}</code>
          </pre>
        )}
        {tool.output && (
          <pre>
            <code>{cap(tool.output)}</code>
          </pre>
        )}
      </>
    ) : undefined;
  return (
    <ActivityStep
      status={status}
      name={humanise(tool.name)}
      tool={tool.name}
      note={note}
      time={tool.durationMs !== undefined ? formatDuration(tool.durationMs) : undefined}
      detail={detail}
      detailLabel="Arguments and result"
    />
  );
}

export interface ToolGroupProps {
  readonly tools: readonly ToolItem[];
  /** A run is live (`ChatLive.busy`). */
  readonly busy: boolean;
  /** Offered on a group that is still running. */
  readonly onStop?: () => void;
}

/** Consecutive tool items as one pw-ui ActivityLog of steps, with the group's status, title and elapsed time. */
export function ToolGroup({ tools, busy, onStop }: ToolGroupProps) {
  const statuses = tools.map((t) => stepStatus(t.status, busy));
  const status = groupStatus(statuses);
  const done = statuses.filter((s) => s === "done").length;
  const title =
    status === "running"
      ? `Running tools, ${done} of ${tools.length} done`
      : `${status === "stopped" ? "Stopped after " : "Ran "}${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  const durations = tools.map((t) => t.durationMs);
  const elapsed = durations.every((d): d is number => d !== undefined) ? formatDuration(durations.reduce((a, b) => a + b, 0)) : undefined;
  return (
    <div className="tsf-tool-group" data-testid="tool-group" data-status={status}>
      <ActivityLog status={status} title={title} elapsed={elapsed} {...(onStop ? { onStop } : {})}>
        {tools.map((t) => (
          <Step key={t.id} tool={t} busy={busy} />
        ))}
      </ActivityLog>
    </div>
  );
}
