/** Pieces the factory screens share: status chips, the event timeline, a settings form with dirty tracking. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, CircleDot, Clock, Loader2, Play, XCircle } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from "@pw/ui/react";
import { Tabs } from "../settings/controls.tsx";
import type { Json } from "../../shared/types.ts";
import { saveSettings } from "./useLayer.ts";

export interface FactoryEvent {
  ts: string;
  source: string;
  kind: string;
  msg: string;
  jobId?: string;
  slice?: string;
  [k: string]: unknown;
}

export type Tone = "success" | "warning" | "error" | "info" | "neutral";

export function toneOf(kind: string): Tone {
  if (/fail|error|reject|abandoned|gone|stale|exit|timeout/.test(kind)) return "error";
  if (/busy|retry|stop|skip/.test(kind)) return "warning";
  if (/done|ok|merged|settled|accepted|patch|applied|end|listening|start|setup/.test(kind)) return "success";
  return "info";
}

export function StatusChip({ state, label }: { state: "running" | "stopped" | "missing" | "busy" | "idle" | "ok" | "warn" | "error"; label: string }) {
  const map = {
    running: { tone: "success" as Tone, icon: CircleDot },
    busy: { tone: "info" as Tone, icon: Loader2 },
    idle: { tone: "success" as Tone, icon: CheckCircle2 },
    ok: { tone: "success" as Tone, icon: CheckCircle2 },
    stopped: { tone: "neutral" as Tone, icon: Circle },
    missing: { tone: "warning" as Tone, icon: AlertTriangle },
    warn: { tone: "warning" as Tone, icon: AlertTriangle },
    error: { tone: "error" as Tone, icon: XCircle },
  };
  const m = map[state];
  return (
    <Badge tone={m.tone} icon={m.icon} className={state === "busy" ? "tsf-fx-spin-icon" : undefined}>
      {label}
    </Badge>
  );
}

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ago(ts: string | number | null | undefined): string {
  if (ts === null || ts === undefined) return "";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The event timeline, newest first, grouped by job. */
export function Timeline({ events, empty = "No events yet.", showSource = false, limit = 80 }: { events: FactoryEvent[]; empty?: string; showSource?: boolean; limit?: number }) {
  const rows = events.slice(0, limit);
  if (rows.length === 0) return <p className="tsf-fx-muted">{empty}</p>;
  return (
    <ol className="tsf-fx-timeline" aria-label="Events">
      {rows.map((e, i) => {
        const tone = toneOf(e.kind);
        const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Clock;
        const newJob = e.jobId && (i === rows.length - 1 || rows[i + 1]?.jobId !== e.jobId);
        return (
          <li key={`${e.ts}-${i}`} className="tsf-fx-event" data-tone={tone}>
            <span className="tsf-fx-event-time" title={e.ts}>
              {fmtTime(e.ts)}
            </span>
            <Icon className="tsf-fx-event-icon" aria-hidden="true" />
            <span className="tsf-fx-event-body">
              <span className="tsf-fx-event-kind">
                {showSource && <span className="tsf-fx-event-source">{e.source}</span>}
                {e.kind}
                {e.slice && <span className="tsf-fx-event-slice">{e.slice}</span>}
                {newJob && e.jobId && <span className="tsf-fx-event-job">job {e.jobId.slice(0, 8)}</span>}
              </span>
              <span className="tsf-fx-event-msg">{e.msg}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export type SelectOption = string | { value: string; label: string };
export type FieldKind = "text" | "number" | "toggle" | "textarea" | "password" | { select: readonly SelectOption[] };

export interface FieldSpec {
  key: string;
  label: string;
  kind?: FieldKind;
  help?: string;
  wide?: boolean;
  mono?: boolean;
}

/**
 * A settings form: the current values come from the layer, edits are kept locally until Save, and only changed keys
 * are sent. `extra` renders after the fields, inside the form (for example a token field with its own action).
 */
export function SettingsForm({
  layer,
  values,
  fields,
  onSaved,
  saveLabel = "Save",
  children,
}: {
  layer: string;
  values: Record<string, Json> | null;
  fields: FieldSpec[];
  onSaved?: (changed: string[]) => void;
  saveLabel?: string;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<Record<string, Json>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    // Values arrived or changed elsewhere: drop drafts that now equal the stored value.
    if (!values) return;
    setDraft((d) => {
      const next = { ...d };
      for (const k of Object.keys(next)) if (JSON.stringify(values[k]) === JSON.stringify(next[k])) delete next[k];
      return Object.keys(next).length === Object.keys(d).length ? d : next;
    });
  }, [values]);
  const dirty = useMemo(() => Object.keys(draft).filter((k) => values && JSON.stringify(values[k]) !== JSON.stringify(draft[k])), [draft, values]);

  const current = (k: string): Json => (k in draft ? draft[k] : (values?.[k] ?? null));
  const set = (k: string, v: Json): void => setDraft((d) => ({ ...d, [k]: v }));

  const save = async (): Promise<void> => {
    if (!values || dirty.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const changes: Record<string, Json> = {};
      for (const k of dirty) changes[k] = draft[k];
      await saveSettings(layer, changes);
      setDraft({});
      setSavedAt(Date.now());
      onSaved?.(dirty);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="tsf-fx-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="tsf-fx-fields">
        {fields.map((f) => {
          const v = current(f.key);
          const kind = f.kind ?? "text";
          const cls = `tsf-fx-field${f.wide ? " tsf-fx-field-wide" : ""}`;
          if (kind === "toggle") {
            return (
              <div key={f.key} className={cls}>
                <Field label={f.label} help={f.help}>
                  {(p) => (
                    <Select {...p} value={v === true ? "on" : "off"} onChange={(e) => set(f.key, e.target.value === "on")} disabled={!values}>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </Select>
                  )}
                </Field>
              </div>
            );
          }
          if (typeof kind === "object") {
            const opts = kind.select.map((o) => (typeof o === "string" ? { value: o, label: o || "(pi default)" } : o));
            const val = String(v ?? "");
            const known = opts.some((o) => o.value === val);
            return (
              <div key={f.key} className={cls}>
                <Field label={f.label} help={f.help}>
                  {(p) => (
                    <Select {...p} value={val} onChange={(e) => set(f.key, e.target.value)} disabled={!values}>
                      {!known && val !== "" && <option value={val}>{val}</option>}
                      {opts.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            );
          }
          if (kind === "textarea") {
            return (
              <div key={f.key} className={`${cls} tsf-fx-field-wide`}>
                <Field label={f.label} help={f.help}>
                  {(p) => <Textarea {...p} rows={6} className={f.mono ? "tsf-fx-mono" : undefined} value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} disabled={!values} />}
                </Field>
              </div>
            );
          }
          return (
            <div key={f.key} className={cls}>
              <Field label={f.label} help={f.help}>
                {(p) => (
                  <Input
                    {...p}
                    type={kind === "number" ? "number" : kind === "password" ? "password" : "text"}
                    className={f.mono ? "tsf-fx-mono" : undefined}
                    value={v === null || v === undefined ? "" : String(v)}
                    onChange={(e) => set(f.key, kind === "number" ? Number(e.target.value) : e.target.value)}
                    disabled={!values}
                  />
                )}
              </Field>
            </div>
          );
        })}
      </div>
      {children}
      {error && (
        <Alert tone="error" soft onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      <div className="tsf-fx-form-actions">
        <Button type="submit" variant="primary" size="sm" icon={Play} loading={saving} disabled={dirty.length === 0}>
          {saveLabel}
          {dirty.length > 0 ? ` (${dirty.length})` : ""}
        </Button>
        {dirty.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({})} disabled={saving}>
            Discard
          </Button>
        )}
        {savedAt && dirty.length === 0 && <span className="tsf-fx-muted">Saved {ago(savedAt)}</span>}
      </div>
    </form>
  );
}

export function Pre({ text, max = 400 }: { text: string; max?: number }) {
  const lines = text.split("\n");
  const shown = lines.length > max ? lines.slice(-max).join("\n") : text;
  return <pre className="tsf-fx-pre">{shown || "(empty)"}</pre>;
}

/** The most recent few events, with a link to the full timeline tab. */
export function RecentEvents({ events, n = 5, onMore, showSource = false }: { events: FactoryEvent[]; n?: number; onMore: () => void; showSource?: boolean }) {
  const last = events[0];
  return (
    <Card
      title="Recent events"
      description={last ? `Last event ${ago(last.ts)}` : "Nothing yet"}
      actions={
        <Button size="sm" variant="ghost" onClick={onMore}>
          Full timeline ({events.length})
        </Button>
      }
    >
      <Timeline events={events} limit={n} showSource={showSource} />
    </Card>
  );
}

export type ScreenTab = "dashboard" | "timeline" | "logs";

/** The tab strip at the top of a factory screen. */
export function ScreenTabs({ value, onChange, logs = true }: { value: ScreenTab; onChange: (t: ScreenTab) => void; logs?: boolean }) {
  const items = [{ id: "dashboard", label: "Dashboard" }, { id: "timeline", label: "Timeline" }, ...(logs ? [{ id: "logs", label: "Logs" }] : [])];
  return <Tabs items={items} value={value} onChange={(id) => onChange(id as ScreenTab)} label="Screen sections" className="tsf-fx-tabs" />;
}
