/**
 * Settings > Core 4 > Context (spec 8.5): the context bar with the tokens used against the two compaction thresholds,
 * the compaction settings and manual compaction with optional instructions. The readings come from `chat.meta` (the
 * agent's newest usage) and `settings.compaction` (the stored points), both kept current by SSE.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Field, Input, StatusLine, Textarea, useToast } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { tokens } from "../navbar/widgets.tsx";
import { useFactory } from "../state/store.ts";
import { Toggle } from "./controls.tsx";

const pctOf = (n: number, window: number): number => (window > 0 ? Math.max(0, Math.min(100, (n / window) * 100)) : 0);

function toInt(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  return Number(text.trim());
}

export function ContextPanel() {
  const meta = useFactory((s) => s.chat?.meta);
  const points = useFactory((s) => s.settings?.compaction);
  const busy = useFactory((s) => s.chat?.live.busy ?? false);
  const compacting = useFactory((s) => (s.chat?.live.compactions.length ?? 0) > 0);
  const { toast } = useToast();

  const used = meta?.contextTokens ?? 0;
  const window = meta?.contextWindow ?? 0;
  const eff = meta?.compaction;
  const bg = eff?.background ?? null;
  const forced = eff?.forced ?? null;

  const [background, setBackground] = useState("");
  const [forcedText, setForcedText] = useState("");
  const [keep, setKeep] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Follow the stored points whenever they change (the agent may change them too).
  useEffect(() => {
    if (!points) return;
    setBackground(String(points.background));
    setForcedText(String(points.forced));
    setKeep(String(points.keepRecentTokens));
    setError(null);
  }, [points?.background, points?.forced, points?.keepRecentTokens]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });

  const b = toInt(background);
  const f = toInt(forcedText);
  const k = toInt(keep);
  const dirty = points !== undefined && (background !== String(points.background) || forcedText !== String(points.forced) || keep !== String(points.keepRecentTokens));
  const save = (): void => {
    if (b === null || f === null || k === null) {
      setError("Enter whole numbers of tokens.");
      return;
    }
    if (b >= f) {
      setError("Background compaction must start below the forced point.");
      return;
    }
    setError(null);
    api.context.setCompaction({ background: b, forced: f, keepRecentTokens: k }).catch((e: unknown) => setError(errorMessage(e)));
  };

  const [instructions, setInstructions] = useState("");
  const [compactingNow, setCompactingNow] = useState(false);
  const compact = (): void => {
    setCompactingNow(true);
    api.context
      .compact(instructions.trim())
      .then(() => {
        setInstructions("");
        toast({ tone: "success", title: "Compaction started" });
      })
      .catch(fail("Compaction did not start"))
      .finally(() => setCompactingNow(false));
  };

  const usedPct = pctOf(used, window);
  const tone = forced !== null && used >= forced ? "error" : bg !== null && used >= bg ? "warning" : "ok";

  return (
    <div className="tsf-set-panel" data-testid="panel-context">
      <section className="tsf-set-group">
        <h3 className="tsf-set-h">Context window</h3>
        <div className="tsf-ctx" data-cap="context.get" data-testid="context-bar" data-tone={tone}>
          <div
            className="tsf-ctx-track"
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={window > 0 ? window : 1}
            aria-valuenow={Math.min(used, window > 0 ? window : used)}
            aria-valuetext={window > 0 ? `${tokens(used)} of ${tokens(window)} tokens` : "no context window known"}
          >
            <div className="tsf-ctx-fill" style={{ width: `${usedPct}%` }} />
            {bg !== null && window > 0 && <div className="tsf-ctx-mark" data-kind="background" style={{ left: `${pctOf(bg, window)}%` }} title={`Background compaction at ${tokens(bg)}`} />}
            {forced !== null && window > 0 && <div className="tsf-ctx-mark" data-kind="forced" style={{ left: `${pctOf(forced, window)}%` }} title={`Forced compaction at ${tokens(forced)}`} />}
          </div>
          <dl className="tsf-ctx-legend">
            <div>
              <dt>Used</dt>
              <dd data-testid="context-used">{used.toLocaleString("en")}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd data-testid="context-window">{window > 0 ? window.toLocaleString("en") : "unknown"}</dd>
            </div>
            <div>
              <dt>Background at</dt>
              <dd data-testid="context-background">{bg !== null ? bg.toLocaleString("en") : "off"}</dd>
            </div>
            <div>
              <dt>Forced at</dt>
              <dd data-testid="context-forced">{forced !== null ? forced.toLocaleString("en") : "off"}</dd>
            </div>
          </dl>
        </div>
        {eff?.clamped === true && (
          <Alert tone="info" soft>
            The stored points do not fit this model's window, so they are clamped to {tokens(eff.background ?? 0)} and {tokens(eff.forced)} while it is in use.
          </Alert>
        )}
        {compacting && <StatusLine>Compaction is running.</StatusLine>}
      </section>

      <section className="tsf-set-group">
        <h3 className="tsf-set-h">Compaction</h3>
        <Toggle
          label="Compact the conversation automatically"
          checked={points?.enabled ?? true}
          onChange={(v) => api.context.setCompaction({ enabled: v }).catch(fail("The setting was not saved"))}
          data-cap="compaction.set"
          data-testid="compaction-enabled"
        />
        <div className="tsf-set-grid">
          <Field label="Background compaction from (tokens)" help="A summary is made in the background from this size." error={error ?? undefined}>
            {(c) => <Input {...c} inputMode="numeric" value={background} data-testid="compaction-background" onChange={(e) => setBackground(e.target.value)} />}
          </Field>
          <Field label="Forced compaction at (tokens)" help="The next request waits for a summary at this size.">
            {(c) => <Input {...c} inputMode="numeric" value={forcedText} data-testid="compaction-forced" onChange={(e) => setForcedText(e.target.value)} />}
          </Field>
          <Field label="Keep recent (tokens)" help="The newest messages kept as they are.">
            {(c) => <Input {...c} inputMode="numeric" value={keep} data-testid="compaction-keep" onChange={(e) => setKeep(e.target.value)} />}
          </Field>
        </div>
        <div className="tsf-set-row">
          <Button variant="primary" size="sm" disabled={!dirty} data-cap="compaction.set" data-testid="compaction-save" onClick={save}>
            Save thresholds
          </Button>
        </div>
      </section>

      <section className="tsf-set-group">
        <h3 className="tsf-set-h">Compact now</h3>
        <Field label="Instructions (optional)" help="What the summary should keep or leave out.">
          {(c) => <Textarea {...c} rows={3} value={instructions} data-testid="compact-instructions" onChange={(e) => setInstructions(e.target.value)} />}
        </Field>
        <div className="tsf-set-row">
          <Button
            variant="secondary"
            size="sm"
            loading={compactingNow}
            loadingLabel="Starting"
            disabled={busy}
            data-cap="compaction.compact"
            data-testid="compact-now"
            onClick={compact}
          >
            Compact now
          </Button>
          {busy && <span className="tsf-set-note">The agent is working; compaction needs it idle.</span>}
        </div>
      </section>
    </div>
  );
}
