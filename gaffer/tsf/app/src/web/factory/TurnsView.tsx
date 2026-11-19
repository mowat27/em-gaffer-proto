/**
 * Gaffer > Turns: every turn gaffer.ts ran, captured in full (kit/templates/build-kit/capture.ts). Pick a turn and read
 * what it received, sent and changed: the runner's prompt and log, slice data, every board call and the whole-board
 * download, the dispatch, every callback, git, the gate and the merge. Bodies open inline or in a new tab; patches
 * open in a diff viewer.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, FileDiff, RefreshCw } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Input, Kpi, KpiGrid, Select } from "@pw/ui/react";
import { api, errorMessage, type CapturedBlob, type CapturedEntry, type CapturedTurn } from "../api/client.ts";

const KIND_LABEL: Record<string, string> = {
  prompt: "Prompt",
  env: "Environment",
  config: "Config",
  task: "Task",
  "slice.stub": "Slice stub",
  "slice.full": "Slice",
  "source.events": "Source events",
  board: "Board API",
  "board.download": "Board download",
  dispatch: "Dispatch",
  callback: "Callback",
  git: "Git",
  cli: "CLI",
  applied: "Applied",
  gate: "Gate",
  event: "Event",
  "runner.log": "Runner log",
  error: "Error",
};
const DIR_LABEL: Record<CapturedEntry["dir"], string> = { in: "← in", out: "→ out", local: "· local" };
const OUTCOME_TONE: Record<string, "success" | "error" | "neutral" | "info"> = { merged: "success", unchanged: "success", blocked: "error", failed: "error", skipped: "neutral" };
/** Blobs larger than this open in a new tab instead of inline. */
const INLINE_VIEW_MAX = 2 * 1024 * 1024;

const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;
const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtMs = (ms: number | undefined): string => (ms === undefined ? "…" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const fmtClock = (ts: string): string => {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const isDiff = (b: CapturedBlob): boolean => b.name.endsWith(".patch") || b.name.endsWith(".diff");

function pretty(text: string, type: string): string {
  if (!type.includes("json")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One blob: size, open in a new tab, the diff viewer for patches, and an inline view loaded on demand. */
function BlobRow({ turn, blob }: { turn: string; blob: CapturedBlob }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooBig = blob.bytes > INLINE_VIEW_MAX;
  useEffect(() => {
    if (!open || text !== null || tooBig) return;
    api.gafferCaptures.blob(turn, blob.file).then(
      (t) => setText(pretty(t, blob.type)),
      (err: unknown) => setError(errorMessage(err)),
    );
  }, [open, text, tooBig, turn, blob]);
  return (
    <div className="tsf-tv-blob">
      <div className="tsf-tv-blob-head">
        <code>{blob.name}</code>
        <span className="tsf-ss-dim">{fmtBytes(blob.bytes)}</span>
        {!tooBig && (
          <button type="button" className="tsf-link-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "View"}
          </button>
        )}
        <a className="tsf-link-button" href={api.gafferCaptures.blobUrl(turn, blob.file)} target="_blank" rel="noreferrer">
          Raw <ExternalLink size={12} aria-hidden />
        </a>
        {isDiff(blob) && (
          <a className="tsf-link-button" href={api.gafferCaptures.diffUrl(turn, blob.file)} target="_blank" rel="noreferrer">
            Diff <FileDiff size={12} aria-hidden />
          </a>
        )}
      </div>
      {open && (error ? <p className="tsf-ss-dim">{error}</p> : <pre className="tsf-fx-pre tsf-tv-pre">{text ?? "Loading…"}</pre>)}
    </div>
  );
}

function EntryItem({ turn, entry }: { turn: string; entry: CapturedEntry }) {
  const [open, setOpen] = useState(false);
  const hasData = Object.keys(entry.data ?? {}).length > 0;
  const event = typeof entry.data?.event === "string" ? entry.data.event : null;
  const failed = entry.kind === "error" || event === "turn.fail" || (typeof entry.data?.exit === "number" && entry.data.exit !== 0) || (typeof entry.data?.status === "number" && entry.data.status >= 400);
  return (
    <li className="tsf-ss-entry tsf-tv-entry" data-kind={entry.kind} data-failed={failed || undefined}>
      <div className="tsf-ss-head">
        <span className="tsf-ss-kind">{kindLabel(entry.kind)}</span>
        {event && <code className="tsf-ss-dim">{event}</code>}
        <span className="tsf-ss-dim">{DIR_LABEL[entry.dir] ?? entry.dir}</span>
        <span className="tsf-ss-time" title={entry.ts}>
          {fmtClock(entry.ts)}
        </span>
        {entry.ms !== undefined && <span className="tsf-ss-dim">{fmtMs(entry.ms)}</span>}
        <span className="tsf-ss-n">#{entry.n}</span>
      </div>
      <div className="tsf-ss-body">
        <span className="tsf-ss-text">{entry.title}</span>
        {entry.blobs.length > 0 && (
          <div className="tsf-tv-blobs">
            {entry.blobs.map((b) => (
              <BlobRow key={b.file} turn={turn} blob={b} />
            ))}
          </div>
        )}
      </div>
      {hasData && (
        <details className="tsf-ss-raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>Details</summary>
          {open && <pre className="tsf-fx-pre tsf-tv-pre">{JSON.stringify(entry.data, null, 2)}</pre>}
        </details>
      )}
    </li>
  );
}

/** The blobs most worth a click, found by kind and name. */
function keyBlobs(entries: CapturedEntry[]): { label: string; blob: CapturedBlob }[] {
  const pick = (kind: string, name: string, label: string): { label: string; blob: CapturedBlob } | null => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind !== kind) continue;
      const blob = e.blobs.find((b) => b.name === name);
      if (blob) return { label, blob };
    }
    return null;
  };
  return [
    pick("callback", "callback.patch", "Patch"),
    pick("applied", "applied.diff", "Applied diff"),
    pick("slice.full", "slice.json", "Slice"),
    pick("source.events", "source-events.json", "Source events"),
    pick("board.download", "board.json", "Whole board"),
    pick("board.download", "board-events.json", "Board events"),
    pick("dispatch", "request.json", "Dispatch request"),
    pick("prompt", "prompt.md", "Prompt"),
    pick("runner.log", "runner.log", "Runner log"),
  ].filter((x): x is { label: string; blob: CapturedBlob } => x !== null);
}

export function TurnsView() {
  const [turns, setTurns] = useState<CapturedTurn[]>([]);
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState("");
  const [entries, setEntries] = useState<CapturedEntry[]>([]);
  const [summary, setSummary] = useState<CapturedTurn | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [dirs, setDirs] = useState<Set<string>>(new Set());
  const [showSkipped, setShowSkipped] = useState(false);

  const refresh = useCallback(() => {
    api.gafferCaptures.turns().then(
      (r) => {
        setRoot(r.root);
        setTurns(r.turns);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  const loadTurn = useCallback((id: string) => {
    if (!id) {
      setEntries([]);
      setSummary(null);
      return;
    }
    setLoading(true);
    api.gafferCaptures
      .turn(id)
      .then(
        (r) => {
          setEntries(r.entries);
          setSummary(r.summary);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const listed = useMemo(() => turns.filter((t) => showSkipped || t.kind !== "skip"), [turns, showSkipped]);
  useEffect(() => {
    if (listed.length && !listed.some((t) => t.id === selected)) setSelected(listed[0].id);
  }, [listed, selected]);
  // Reload the open turn whenever it grows (a turn in progress) or the selection changes.
  const selectedEntries = turns.find((t) => t.id === selected)?.entries ?? 0;
  useEffect(() => {
    loadTurn(selected);
  }, [selected, selectedEntries, loadTurn]);
  useEffect(() => {
    setKinds(new Set());
    setDirs(new Set());
  }, [selected]);

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return [...counts.entries()];
  }, [entries]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = entries.filter(
      (e) =>
        (kinds.size === 0 || kinds.has(e.kind)) &&
        (dirs.size === 0 || dirs.has(e.dir)) &&
        (!q || `${e.kind} ${e.title} ${JSON.stringify(e.data)} ${e.blobs.map((b) => b.name).join(" ")}`.toLowerCase().includes(q)),
    );
    return newestFirst ? out.slice().reverse() : out;
  }, [entries, filter, kinds, dirs, newestFirst]);
  const metrics = useMemo(() => {
    const count = (k: string): number => entries.filter((e) => e.kind === k).length;
    return { board: count("board"), git: count("git"), callbacks: count("callback"), dispatches: count("dispatch"), blobs: entries.reduce((n, e) => n + e.blobs.length, 0) };
  }, [entries]);
  const keys = useMemo(() => keyBlobs(entries), [entries]);
  const toggle = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };
  const filtering = filter.trim() !== "" || kinds.size > 0 || dirs.size > 0;

  return (
    <div className="tsf-ss" data-testid="turns-view">
      {error && (
        <Alert tone="error" soft onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card
        title="Turns"
        description={`Every turn the runner handed to gaffer.ts, captured in full. Stored under ${root || "tsf/data/layers/gaffer/captures"}.`}
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => { refresh(); loadTurn(selected); }}>
            Refresh
          </Button>
        }
      >
        <label className="tsf-tv-check">
          <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show turns that were not builds ({turns.filter((t) => t.kind === "skip").length})
        </label>
        {listed.length ? (
          <div className="tsf-tv-turns">
            <table className="tsf-fx-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Slice</th>
                  <th>Outcome</th>
                  <th>Duration</th>
                  <th>Entries</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((t) => (
                  <tr key={t.id} className="tsf-tv-turn" aria-selected={t.id === selected} tabIndex={0} onClick={() => setSelected(t.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(t.id)}>
                    <td className="tsf-fx-mono">{new Date(t.startedAt).toLocaleString()}</td>
                    <td>
                      <strong>{t.slice ?? (t.kind === "skip" ? "(not a build)" : "?")}</strong>
                      {t.context && <span className="tsf-fx-step-hint">{t.context}</span>}
                    </td>
                    <td>
                      <Badge tone={OUTCOME_TONE[t.outcome ?? ""] ?? "info"}>{t.outcome ?? (t.endedAt ? "unknown" : "running")}</Badge>
                    </td>
                    <td className="tsf-fx-muted">{fmtMs(t.durationMs)}</td>
                    <td className="tsf-fx-muted">{t.entries}</td>
                    <td className="tsf-fx-muted">{fmtBytes(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="tsf-fx-muted">No captured turns yet. Turns are captured once the gaffer has been set up again (gaffer.json names the captures folder) and a slice is built.</p>
        )}
      </Card>

      {summary && (
        <>
          {summary.outcome === "failed" && summary.reason && (
            <Alert tone="error" soft title="Turn failed">
              {summary.reason}
            </Alert>
          )}
          <KpiGrid>
            <Kpi label="Entries" value={entries.length} />
            <Kpi label="Duration" value={fmtMs(summary.durationMs)} />
            <Kpi label="Board calls" value={metrics.board} />
            <Kpi label="Dispatches" value={metrics.dispatches} />
            <Kpi label="Callbacks" value={metrics.callbacks} />
            <Kpi label="Git commands" value={metrics.git} />
            <Kpi label="Blobs" value={metrics.blobs} />
            <Kpi label="Captured" value={fmtBytes(summary.bytes)} />
          </KpiGrid>
          <p className="tsf-fx-muted">
            {summary.jobId && <>Job <code>{summary.jobId}</code>. </>}
            {summary.sliceId && <>Slice <code>{summary.sliceId}</code>. </>}
            Exit code {summary.exitCode ?? "(running)"}.
          </p>
          {keys.length > 0 && (
            <div className="tsf-tv-keys" role="group" aria-label="Key captures">
              {keys.map(({ label, blob }) =>
                isDiff(blob) ? (
                  <a key={blob.file} className="tsf-tv-key" href={api.gafferCaptures.diffUrl(summary.id, blob.file)} target="_blank" rel="noreferrer">
                    <FileDiff size={14} aria-hidden /> {label} <span className="tsf-ss-dim">{fmtBytes(blob.bytes)}</span>
                  </a>
                ) : (
                  <a key={blob.file} className="tsf-tv-key" href={api.gafferCaptures.blobUrl(summary.id, blob.file)} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} aria-hidden /> {label} <span className="tsf-ss-dim">{fmtBytes(blob.bytes)}</span>
                  </a>
                ),
              )}
            </div>
          )}

          <div className="tsf-ss-controls">
            <Field label="Filter">{(p) => <Input {...p} type="search" placeholder="Search titles, data and blob names" value={filter} onChange={(e) => setFilter(e.target.value)} />}</Field>
            <Field label="Order">
              {(p) => (
                <Select {...p} value={newestFirst ? "newest" : "oldest"} onChange={(e) => setNewestFirst(e.target.value === "newest")}>
                  <option value="oldest">As it happened</option>
                  <option value="newest">Newest first</option>
                </Select>
              )}
            </Field>
          </div>
          <div className="tsf-ss-chips" role="group" aria-label="Filter by type">
            <span className="tsf-ss-chips-label">Type</span>
            {kindCounts.map(([k, count]) => (
              <button key={k} type="button" className="tsf-ss-chip" data-kind={k} aria-pressed={kinds.has(k)} onClick={() => setKinds((cur) => toggle(cur, k))}>
                {kindLabel(k)} <span className="tsf-ss-chip-count">{count}</span>
              </button>
            ))}
          </div>
          <div className="tsf-ss-chips" role="group" aria-label="Filter by direction">
            <span className="tsf-ss-chips-label">Way</span>
            {(["in", "out", "local"] as const).map((d) => (
              <button key={d} type="button" className="tsf-ss-chip" aria-pressed={dirs.has(d)} onClick={() => setDirs((cur) => toggle(cur, d))}>
                {DIR_LABEL[d]} <span className="tsf-ss-chip-count">{entries.filter((e) => e.dir === d).length}</span>
              </button>
            ))}
          </div>
          <p className="tsf-fx-muted" aria-live="polite">
            Showing {shown.length} of {entries.length} entries.
            {filtering && (
              <>
                {" "}
                <button type="button" className="tsf-link-button" onClick={() => { setFilter(""); setKinds(new Set()); setDirs(new Set()); }}>
                  Clear filters
                </button>
              </>
            )}
          </p>

          <ol className="tsf-ss-list" aria-label="Turn entries">
            {shown.map((e) => (
              <EntryItem key={e.n} turn={summary.id} entry={e} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
