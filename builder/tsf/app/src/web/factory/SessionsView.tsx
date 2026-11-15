/** Builder > Sessions: pick a pi session log and read it as a list of entries, with metrics, sort, a text filter and the raw event. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, Button, Card, Field, Input, Kpi, KpiGrid, Select } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import {
  KIND_LABEL,
  argSummary,
  clip,
  filterEntries,
  fmtDuration,
  fmtNum,
  metricsOf,
  num,
  parseSession,
  parts,
  rec,
  str,
  textOf,
  type Entry,
  type Kind,
  type Rec,
} from "../../../../../pi-session.ts";

interface SessionInfo {
  id: string;
  started: string;
  dir: string;
  jobId: string | null;
  name: string | null;
  size: number;
}
interface SessionRun extends SessionInfo {
  durationMs: number;
}

const PERIODS = [
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time", ms: Infinity },
] as const;

const fmtClock = (ts: number): string => {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** The readable body of one entry. */
function Body({ entry }: { entry: Entry }): ReactNode {
  const { obj } = entry;
  const message = rec(obj.message);
  switch (entry.kind) {
    case "session":
      return <span className="tsf-ss-line">session v{String(obj.version ?? "?")} in <code>{str(obj.cwd)}</code></span>;
    case "meta":
      return <span className="tsf-ss-line">{str(obj.type) === "model_change" ? `model ${str(obj.provider)}/${str(obj.modelId)}` : `thinking level ${str(obj.thinkingLevel)}`}</span>;
    case "system":
      return <span className="tsf-ss-line">system prompt sections: {Object.keys(rec(message.sections)).join(", ") || "(none)"}</span>;
    case "user":
      return <span className="tsf-ss-text">{clip(textOf(message))}</span>;
    case "tool":
    case "tool-error":
      return (
        <>
          <span className="tsf-ss-line">
            <strong>{str(message.toolName)}</strong>
            {num(message.durationMs) > 0 && <span className="tsf-ss-dim"> · {num(message.durationMs)}ms</span>}
          </span>
          <span className="tsf-ss-text">{clip(textOf(message), 400) || "(no output)"}</span>
        </>
      );
    case "assistant": {
      const usage = rec(message.usage);
      return (
        <>
          {parts(message).map((p, i) => {
            if (p.type === "thinking") return <span key={i} className="tsf-ss-text tsf-ss-thinking">{clip(str(p.thinking), 400)}</span>;
            if (p.type === "text") return <span key={i} className="tsf-ss-text">{clip(str(p.text))}</span>;
            if (p.type === "toolCall") {
              return (
                <span key={i} className="tsf-ss-call">
                  <strong>{str(p.name)}</strong> <code>{clip(argSummary(str(p.name), rec(p.arguments)), 300)}</code>
                </span>
              );
            }
            return null;
          })}
          {num(usage.totalTokens) > 0 && (
            <span className="tsf-ss-dim tsf-ss-line">
              {fmtNum(num(usage.input))} in · {fmtNum(num(usage.output))} out · {fmtNum(num(usage.cacheRead))} cached · ${num(rec(usage.cost).total).toFixed(4)}
            </span>
          )}
        </>
      );
    }
    default:
      return <span className="tsf-ss-line">{str(obj.type)}</span>;
  }
}

/** The raw event, rendered only once the panel is opened. */
function Raw({ obj }: { obj: Rec }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="tsf-ss-raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Raw event</summary>
      {open && <pre className="tsf-fx-pre">{JSON.stringify(obj, null, 2)}</pre>}
    </details>
  );
}

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("7d");
  const [selected, setSelected] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [filter, setFilter] = useState("");
  const [kinds, setKinds] = useState<Set<Kind>>(new Set());
  const [toolSel, setToolSel] = useState<Set<string>>(new Set());

  const loadSession = useCallback((id: string) => {
    if (!id) {
      setEntries([]);
      return Promise.resolve();
    }
    setLoading(true);
    return api.builderAgent.session(id).then(
      (file) => {
        setEntries(parseSession(file.content));
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    ).finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(() => {
    api.builderAgent.sessions().then(
      (r) => {
        setSessions(r.sessions);
        setSelected((cur) => (r.sessions.some((s) => s.id === cur) ? cur : (r.sessions[0]?.id ?? "")));
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    let cancelled = false;
    Promise.all(sessions.map(async (session) => {
      const file = await api.builderAgent.session(session.id);
      return { ...session, durationMs: metricsOf(parseSession(file.content)).durationMs };
    })).then((next) => {
      if (!cancelled) setRuns(next);
    }).catch((err: unknown) => {
      if (!cancelled) setError(errorMessage(err));
    });
    return () => { cancelled = true; };
  }, [sessions]);
  const filteredRuns = useMemo(() => {
    const active = PERIODS.find((p) => p.value === period) ?? PERIODS[1];
    return runs.filter((run) => Date.parse(run.started) >= Date.now() - active.ms);
  }, [runs, period]);
  useEffect(() => {
    if (filteredRuns.length && !filteredRuns.some((run) => run.id === selected)) setSelected(filteredRuns[0].id);
  }, [filteredRuns, selected]);
  useEffect(() => {
    setKinds(new Set());
    setToolSel(new Set());
  }, [selected]);
  useEffect(() => {
    void loadSession(selected);
  }, [selected, loadSession]);

  const metrics = useMemo(() => metricsOf(entries), [entries]);
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
  const shown = useMemo(() => filterEntries(entries, { kinds, tools: toolSel, text: filter, newestFirst }), [entries, filter, kinds, toolSel, newestFirst]);
  const filtering = filter.trim() !== "" || kinds.size > 0 || toolSel.size > 0;
  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };

  const label = (s: SessionInfo): string => `${new Date(s.started).toLocaleString()} · ${s.name ?? "manual"} · ${Math.max(1, Math.round(s.size / 1024))} KB`;
  const maxDuration = Math.max(1, ...filteredRuns.map((run) => run.durationMs));

  return (
    <div className="tsf-ss" data-testid="sessions-view">
      {error && (
        <Alert tone="error" soft onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card
        title="Build duration"
        description="Each bar is a session: start time on the x-axis and Pi runtime on the y-axis. Select a bar to open its log."
        actions={<div className="tsf-ss-period"><Select aria-label="Time period" value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></div>}
      >
        {filteredRuns.length > 0 ? <div className="tsf-ss-histogram" role="list" aria-label={`Build duration by session start time; maximum duration ${fmtDuration(maxDuration)}`}>
          <span className="tsf-ss-axis-label">{fmtDuration(maxDuration)}</span>
          {filteredRuns.slice().reverse().map((run) => {
            const height = Math.max(8, Math.round((run.durationMs / maxDuration) * 100));
            const title = `${new Date(run.started).toLocaleString()}: ${fmtDuration(run.durationMs)} · ${run.name ?? "manual"}`;
            return <button key={run.id} type="button" role="listitem" className="tsf-ss-bar" aria-pressed={selected === run.id} title={title} onClick={() => setSelected(run.id)}>
              <span className="tsf-ss-bar-fill" style={{ height: `${height}%` }} />
              <span className="tsf-ss-bar-label">{new Date(run.started).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
            </button>;
          })}
        </div> : <p className="tsf-fx-muted">No sessions in this period.</p>}
      </Card>

      <Card
        title="Session log"
        description="Pi session files under builder/pi-agent/sessions, named by when they started. The time period applies to the chart and session picker."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={RefreshCw}
            loading={loading}
            onClick={() => {
              refresh();
              void loadSession(selected);
            }}
          >
            Refresh
          </Button>
        }
      >
        <Field label="Session">
          {(p) => (
            <Select {...p} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={filteredRuns.length === 0}>
              {filteredRuns.length === 0 && <option value="">No sessions in this period</option>}
              {filteredRuns.map((s) => (
                <option key={s.id} value={s.id}>
                  {label(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Card>

      {entries.length > 0 && (
        <>
          <KpiGrid>
            <Kpi label="Entries" value={metrics.entries} />
            <Kpi label="Duration" value={fmtDuration(metrics.durationMs)} />
            <Kpi label="Assistant turns" value={metrics.turns} />
            <Kpi label="Tool calls" value={metrics.toolCalls} />
            <Kpi label="Tool errors" value={metrics.toolErrors} />
            <Kpi label="Tokens in / out" value={`${fmtNum(metrics.input)} / ${fmtNum(metrics.output)}`} />
            <Kpi label="Cache read" value={fmtNum(metrics.cacheRead)} />
            <Kpi label="Cost" value={`$${metrics.cost.toFixed(3)}`} />
          </KpiGrid>
          <p className="tsf-fx-muted">
            {metrics.model && <>Model <code>{metrics.model}</code>. </>}
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
              <button key={k} type="button" className="tsf-ss-chip" data-kind={k} aria-pressed={kinds.has(k)} onClick={() => setKinds((cur) => toggle(cur, k))}>
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
              <li key={e.n} className="tsf-ss-entry" data-kind={e.kind}>
                <div className="tsf-ss-head">
                  <span className="tsf-ss-kind">{KIND_LABEL[e.kind]}</span>
                  <span className="tsf-ss-time" title={new Date(e.ts).toISOString()}>
                    {fmtClock(e.ts)}
                  </span>
                  <span className="tsf-ss-n">#{e.n}</span>
                </div>
                <div className="tsf-ss-body">
                  <Body entry={e} />
                </div>
                <Raw obj={e.obj} />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
