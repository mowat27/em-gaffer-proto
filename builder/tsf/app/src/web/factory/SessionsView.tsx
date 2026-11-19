/**
 * Builder > Sessions: the story of a run, from its journals (`builder tool run_story`), as the previous design's pi
 * session view showed it. A build-duration chart over the runs with a story (jobs and runs started directly), a picker,
 * the run's headline numbers, filters by message type and by tool, a sort order, and each entry: the thinking, the
 * text, the tool calls with their arguments, the tool output, the tokens of each response and the raw journal events.
 * A job's story is its whole tree of runs (the job, its agent, the tool summarisers) in one list.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, Button, Card, Field, Input, Kpi, KpiGrid, Select } from "@pw/ui/react";
import { StatusChip } from "./common.tsx";
import { useLayerQuery } from "./useLayer.ts";

type Kind = "run" | "step" | "meta" | "system" | "user" | "assistant" | "tool" | "tool-error" | "other";

const KIND_LABEL: Record<Kind, string> = {
  run: "run",
  step: "step",
  meta: "config",
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool result",
  "tool-error": "tool error",
  other: "other",
};

/** The entry colours of the session list (the chips and entries use data-kind). */
const STYLE: Record<Kind, string> = { run: "session", step: "session", meta: "meta", system: "system", user: "user", assistant: "assistant", tool: "tool", "tool-error": "tool-error", other: "other" };

interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}
interface Entry {
  n: number;
  ts: string;
  runId: string;
  agent?: string;
  step?: string;
  kind: Kind;
  tools: string[];
  line?: string;
  text?: string;
  thinking?: string;
  sections?: Record<string, string | null>;
  toolsAdded?: string[];
  toolsRemoved?: string[];
  calls?: { id: string; name: string; input: unknown }[];
  usage?: Usage;
  thinkingLevel?: string;
  stopReason?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  ms?: number;
  outcome?: string;
  gates?: { gate: string; decision: string; reason?: string }[];
  raw: unknown[];
}
interface Metrics {
  entries: number;
  durationMs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string;
  models: string[];
  thinking: string;
  topTools: [string, number][];
}
interface Row {
  id: string;
  kind: string;
  target: string;
  state: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  job?: string;
  jobId?: string;
  name?: string;
  slice?: string;
  outcome?: string;
  reason?: string;
}
interface Story extends Row {
  runId: string;
  runs: { runId: string; parent: string | null; agent?: string; step?: string; events: number }[];
  metrics: Metrics;
  entries: Entry[];
}

const PERIODS = [
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time", ms: Infinity },
] as const;

const LIVE = new Set(["starting", "running"]);

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export const fmtNum = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A tool call's arguments in a few words: the command, the path, or the JSON. */
export function argSummary(name: string, input: unknown): string {
  const a = rec(input);
  if (name === "bash" && typeof a.command === "string") return a.command;
  const path = str(a.path) || str(a.file_path);
  if (path) return path;
  if (typeof input === "string") return input;
  const json = JSON.stringify(input ?? {});
  return json === "{}" ? "" : json;
}

const fmtClock = (ts: string): string => {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** Text cut to `max` characters, with a button to show it all. */
function Clip({ text, max = 600, className = "tsf-ss-text" }: { text: string; max?: number; className?: string }) {
  const [all, setAll] = useState(false);
  if (!text) return null;
  const long = text.length > max;
  return (
    <span className={className}>
      {all || !long ? text : `${text.slice(0, max)}…`}
      {long && (
        <>
          {" "}
          <button type="button" className="tsf-link-button" onClick={() => setAll((v) => !v)}>
            {all ? "Show less" : `Show all (${fmtNum(text.length)} chars)`}
          </button>
        </>
      )}
    </span>
  );
}

const usageLine = (u: Usage): string =>
  `${fmtNum(u.input)} in · ${fmtNum(u.output)} out · ${fmtNum(u.cacheRead)} cached${u.cacheWrite ? ` · ${fmtNum(u.cacheWrite)} cache write` : ""} · $${u.cost.toFixed(4)}`;

/** The readable body of one entry. */
function Body({ entry: e }: { entry: Entry }): ReactNode {
  switch (e.kind) {
    case "system": {
      const names = Object.keys(e.sections ?? {});
      return (
        <>
          <span className="tsf-ss-line">system prompt sections: {names.join(", ") || "(none)"}</span>
          {e.text && <Clip text={e.text} />}
          {e.toolsAdded?.length ? <span className="tsf-ss-dim tsf-ss-line">tools added: {e.toolsAdded.join(", ")}</span> : null}
          {e.toolsRemoved?.length ? <span className="tsf-ss-dim tsf-ss-line">tools removed: {e.toolsRemoved.join(", ")}</span> : null}
          {names.map((name) => (
            <details key={name} className="tsf-ss-raw">
              <summary>{name}</summary>
              <pre className="tsf-fx-pre">{e.sections?.[name] ?? "(removed)"}</pre>
            </details>
          ))}
        </>
      );
    }
    case "user":
      return (
        <>
          {e.line && <span className="tsf-ss-dim tsf-ss-line">{e.line}</span>}
          <Clip text={e.text ?? ""} />
        </>
      );
    case "assistant":
      return (
        <>
          {e.thinking && <Clip text={e.thinking} max={400} className="tsf-ss-text tsf-ss-thinking" />}
          {e.text && <Clip text={e.text} />}
          {(e.calls ?? []).map((c) => (
            <span key={c.id} className="tsf-ss-call">
              <strong>{c.name}</strong> <code>{argSummary(c.name, c.input).slice(0, 300)}</code>
            </span>
          ))}
          {e.line && <span className="tsf-ss-line">{e.line}</span>}
          {e.usage && <span className="tsf-ss-dim tsf-ss-line">{usageLine(e.usage)}</span>}
        </>
      );
    case "tool":
    case "tool-error":
      return (
        <>
          <span className="tsf-ss-line">
            <strong>{e.tool}</strong>
            {e.ms ? <span className="tsf-ss-dim"> · {e.ms}ms</span> : null}
            {e.outcome && e.outcome !== "ok" ? <span className="tsf-ss-dim"> · {e.outcome}</span> : null}
            {e.input !== undefined && argSummary(e.tool ?? "", e.input) ? <code> {argSummary(e.tool ?? "", e.input).slice(0, 200)}</code> : null}
          </span>
          {(e.gates ?? []).map((g, i) => (
            <span key={i} className="tsf-ss-dim tsf-ss-line">
              gate {g.gate}: {g.decision}
              {g.reason ? ` (${g.reason})` : ""}
            </span>
          ))}
          {e.outcome === "running" ? <span className="tsf-ss-dim tsf-ss-line">(running)</span> : <Clip text={e.output || "(no output)"} max={400} />}
        </>
      );
    default:
      return <span className="tsf-ss-line">{e.line}</span>;
  }
}

/** The raw journal events, rendered only once the panel is opened. */
function Raw({ events }: { events: unknown[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="tsf-ss-raw" onToggle={(ev) => setOpen(ev.currentTarget.open)}>
      <summary>Raw event{events.length > 1 ? `s (${events.length})` : ""}</summary>
      {open && <pre className="tsf-fx-pre">{events.map((x) => JSON.stringify(x, null, 2)).join("\n")}</pre>}
    </details>
  );
}

const label = (r: Row): string => `${new Date(r.startedAt).toLocaleString()} · ${r.job ?? r.name ?? r.target}${r.slice ? ` · ${r.slice}` : ""} · ${fmtDuration(r.durationMs)}${LIVE.has(r.state) ? " · running" : r.outcome === "failed" ? " · failed" : ""}`;

export function SessionsView() {
  const sessions = useLayerQuery<{ total: number; runs: Row[] }>("builder", "sessions", { limit: 300 }, 10000);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("7d");
  const [selected, setSelected] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [filter, setFilter] = useState("");
  const [kinds, setKinds] = useState<Set<Kind>>(new Set());
  const [toolSel, setToolSel] = useState<Set<string>>(new Set());

  const runs = sessions.data?.runs ?? [];
  const filteredRuns = useMemo(() => {
    const active = PERIODS.find((p) => p.value === period) ?? PERIODS[1];
    return runs.filter((r) => Date.parse(r.startedAt) >= Date.now() - active.ms);
  }, [runs, period]);
  useEffect(() => {
    if (filteredRuns.length && !filteredRuns.some((r) => r.id === selected)) setSelected(filteredRuns[0].id);
  }, [filteredRuns, selected]);
  useEffect(() => {
    setKinds(new Set());
    setToolSel(new Set());
  }, [selected]);
  const run = runs.find((r) => r.id === selected);
  const live = !!run && LIVE.has(run.state);
  const story = useLayerQuery<Story>("builder", "story", { run: selected || "latest" }, live ? 3000 : 0);
  const current = story.data && story.data.runId === selected ? story.data : null;
  const entries = current?.entries ?? [];
  const metrics = current?.metrics;

  const kindCounts = useMemo(() => {
    const counts = new Map<Kind, number>();
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return (Object.keys(KIND_LABEL) as Kind[]).filter((k) => counts.has(k)).map((k): [Kind, number] => [k, counts.get(k) ?? 0]);
  }, [entries]);
  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) for (const t of e.tools) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [entries]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = entries.filter(
      (e) => (kinds.size === 0 || kinds.has(e.kind)) && (toolSel.size === 0 || e.tools.some((t) => toolSel.has(t))) && (needle === "" || JSON.stringify(e).toLowerCase().includes(needle)),
    );
    return newestFirst ? [...rows].reverse() : rows;
  }, [entries, filter, kinds, toolSel, newestFirst]);
  const multiRun = (current?.runs.length ?? 0) > 1;
  const filtering = filter.trim() !== "" || kinds.size > 0 || toolSel.size > 0;
  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };
  const maxDuration = Math.max(1, ...filteredRuns.map((r) => r.durationMs));
  const error = sessions.error ?? story.error;

  return (
    <div className="tsf-ss" data-testid="sessions-view">
      {error && (
        <Alert tone="error" soft>
          {error}
        </Alert>
      )}

      <Card
        title="Build duration"
        description="Each bar is a run: a job, or a run started directly. Start time on the x-axis and duration on the y-axis. Select a bar to open its story."
        actions={
          <div className="tsf-ss-period">
            <Select aria-label="Time period" value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {filteredRuns.length > 0 ? (
          <div className="tsf-ss-histogram" role="list" aria-label={`Build duration by start time; maximum duration ${fmtDuration(maxDuration)}`}>
            <span className="tsf-ss-axis-label">{fmtDuration(maxDuration)}</span>
            {filteredRuns
              .slice()
              .reverse()
              .map((r) => {
                const height = Math.max(8, Math.round((r.durationMs / maxDuration) * 100));
                return (
                  <button key={r.id} type="button" role="listitem" className="tsf-ss-bar" aria-pressed={selected === r.id} title={label(r)} onClick={() => setSelected(r.id)}>
                    <span className="tsf-ss-bar-fill" style={{ height: `${height}%` }} />
                    <span className="tsf-ss-bar-label">{new Date(r.startedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  </button>
                );
              })}
          </div>
        ) : (
          <p className="tsf-fx-muted">No runs in this period.</p>
        )}
      </Card>

      <Card
        title="Session log"
        description="The run's story from its journals: for a job, the job, its agent and the tool summarisers in one list. The time period applies to the chart and the picker."
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={story.loading || sessions.loading} onClick={() => (sessions.refresh(), story.refresh())}>
            Refresh
          </Button>
        }
      >
        <Field label="Session">
          {(p) => (
            <Select {...p} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={filteredRuns.length === 0}>
              {filteredRuns.length === 0 && <option value="">No runs in this period</option>}
              {filteredRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {label(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {run && (
          <p className="tsf-fx-muted" style={{ marginTop: "var(--pw-sp-2)" }}>
            <StatusChip state={live ? "busy" : run.outcome === "done" || run.state === "done" ? "ok" : run.state === "stopped" ? "stopped" : "error"} label={run.state} /> <span className="tsf-fx-mono">{run.id}</span>
            {current && current.runs.length > 1 && <> · {current.runs.length} runs: {current.runs.map((r) => r.agent ?? r.step ?? (r.parent ? r.runId : "job")).join(", ")}</>}
            {live && " · read again every 3 s"}
            {run.reason && <> · {run.reason}</>}
          </p>
        )}
      </Card>

      {metrics && entries.length > 0 && (
        <>
          <KpiGrid>
            <Kpi label="Entries" value={metrics.entries} />
            <Kpi label="Duration" value={fmtDuration(run?.durationMs ?? metrics.durationMs)} />
            <Kpi label="Assistant turns" value={metrics.turns} />
            <Kpi label="Tool calls" value={metrics.toolCalls} />
            <Kpi label="Tool errors" value={metrics.toolErrors} />
            <Kpi label="Tokens in / out" value={`${fmtNum(metrics.input)} / ${fmtNum(metrics.output)}`} />
            <Kpi label="Cache read" value={fmtNum(metrics.cacheRead)} />
            <Kpi label="Cost" value={`$${metrics.cost.toFixed(3)}`} />
          </KpiGrid>
          <p className="tsf-fx-muted">
            {metrics.model && (
              <>
                Model <code>{metrics.model}</code>
                {metrics.thinking ? `, thinking ${metrics.thinking}` : ""}
                {metrics.models.length > 1 ? ` (also ${metrics.models.slice(1).join(", ")})` : ""}.{" "}
              </>
            )}
            {metrics.topTools.length > 0 && <>Tools: {metrics.topTools.map(([name, count]) => `${name} ${count}`).join(" · ")}.</>}
          </p>

          <div className="tsf-ss-controls">
            <Field label="Filter">{(p) => <Input {...p} type="search" placeholder="Search every entry" value={filter} onChange={(e) => setFilter(e.target.value)} />}</Field>
            <Field label="Sort by timestamp">
              {(p) => (
                <Select {...p} value={newestFirst ? "newest" : "oldest"} onChange={(e) => setNewestFirst(e.target.value === "newest")}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </Select>
              )}
            </Field>
          </div>
          <div className="tsf-ss-chips" role="group" aria-label="Filter by message type">
            <span className="tsf-ss-chips-label">Type</span>
            {kindCounts.map(([k, count]) => (
              <button key={k} type="button" className="tsf-ss-chip" data-kind={STYLE[k]} aria-pressed={kinds.has(k)} onClick={() => setKinds((cur) => toggle(cur, k))}>
                {KIND_LABEL[k]} <span className="tsf-ss-chip-count">{count}</span>
              </button>
            ))}
          </div>
          {toolCounts.length > 0 && (
            <div className="tsf-ss-chips" role="group" aria-label="Filter by tool">
              <span className="tsf-ss-chips-label">Tool</span>
              {toolCounts.map(([name, count]) => (
                <button key={name} type="button" className="tsf-ss-chip" data-kind="tool-name" aria-pressed={toolSel.has(name)} onClick={() => setToolSel((cur) => toggle(cur, name))}>
                  {name} <span className="tsf-ss-chip-count">{count}</span>
                </button>
              ))}
            </div>
          )}
          <p className="tsf-fx-muted" aria-live="polite">
            Showing {shown.length} of {entries.length} entries.
            {filtering && (
              <>
                {" "}
                <button
                  type="button"
                  className="tsf-link-button"
                  onClick={() => {
                    setFilter("");
                    setKinds(new Set());
                    setToolSel(new Set());
                  }}
                >
                  Clear filters
                </button>
              </>
            )}
          </p>

          <ol className="tsf-ss-list" aria-label="Session entries">
            {shown.map((e) => (
              <li key={e.n} className="tsf-ss-entry" data-kind={STYLE[e.kind]}>
                <div className="tsf-ss-head">
                  <span className="tsf-ss-kind">{KIND_LABEL[e.kind]}</span>
                  <span className="tsf-ss-time" title={e.ts}>
                    {fmtClock(e.ts)}
                  </span>
                  {multiRun && (e.agent || e.step) && <span className="tsf-ss-dim">{e.agent ?? e.step}</span>}
                  <span className="tsf-ss-n">#{e.n}</span>
                </div>
                <div className="tsf-ss-body">
                  <Body entry={e} />
                </div>
                <Raw events={e.raw} />
              </li>
            ))}
          </ol>
        </>
      )}
      {current && entries.length === 0 && <p className="tsf-fx-muted">This run has no journal events.</p>}
    </div>
  );
}
