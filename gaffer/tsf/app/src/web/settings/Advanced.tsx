/**
 * Settings > Advanced (spec 8.4): the layer stack in load order with enable and disable, the providers, the permissions
 * ceiling (read-only: the file is read once at startup and no route writes it) and the runs list. Layers, ceiling and
 * runs are in the snapshot and kept current by `layers.changed` and `run.recorded`.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Field, Input, StatusLine, Textarea, useToast } from "@pw/ui/react";
import type { JevVerdict, LayerInfo, RebuildWebResult, RunDetail, RunSummary, ScreenshotResult } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { tokens } from "../lib/usage.ts";
import { useModels } from "../state/queries.ts";
import { useFactory } from "../state/store.ts";
import { LayerAuthoringRow, LayerToolbar, SettingsBlock } from "./LayerAuthoring.tsx";
import { Tabs, Toggle, type TabItem } from "./controls.tsx";

export const ADVANCED_TABS: readonly TabItem[] = [
  { id: "layers", label: "Layers" },
  { id: "providers", label: "Providers" },
  { id: "ceiling", label: "Permissions ceiling" },
  { id: "runs", label: "Runs" },
  { id: "jev", label: "jev" },
  { id: "factory", label: "Factory" },
];

function LayerRow({ layer, onToggle }: { layer: LayerInfo; onToggle: (v: boolean) => void }) {
  return (
    <li className="tsf-layer" data-testid={`layer-${layer.name}`} data-enabled={layer.enabled ? "true" : "false"} data-status={layer.status}>
      <span className="tsf-layer-order">{layer.order + 1}</span>
      <div className="tsf-layer-main">
        <Toggle
          label={
            <>
              <strong>{layer.title}</strong> <code>{layer.name}</code>
            </>
          }
          checked={layer.enabled}
          disabled={layer.required || layer.status === "failed"}
          onChange={onToggle}
          data-cap="layers.set_enabled"
          data-testid={`layer-toggle-${layer.name}`}
        />
        <p className="tsf-set-note">{layer.description}</p>
        <div className="tsf-layer-badges">
          <Badge tone="neutral">{layer.kind}</Badge>
          <Badge tone="neutral">{layer.source}</Badge>
          {layer.version !== undefined && <Badge tone="neutral" data-testid={`layer-version-${layer.name}`}>v{layer.version}</Badge>}
          {layer.origin !== undefined && <Badge tone="neutral" data-testid={`layer-origin-${layer.name}`}>{layer.origin}</Badge>}
          {layer.required && <Badge tone="info">Required</Badge>}
          {layer.status === "failed" && <Badge tone="error">Failed to load</Badge>}
          <Badge tone="neutral">{layer.tools.length} tools</Badge>
          {layer.toolsOutsideCeiling.length > 0 && <Badge tone="warning">{layer.toolsOutsideCeiling.length} outside the ceiling</Badge>}
        </div>
        {layer.requires && (layer.requires.core !== undefined || (layer.requires.layers?.length ?? 0) > 0) && (
          <p className="tsf-set-note" data-testid={`layer-requires-${layer.name}`}>
            Requires {[layer.requires.core !== undefined ? `core ${layer.requires.core}` : "", ...(layer.requires.layers ?? [])].filter(Boolean).join(", ")}
          </p>
        )}
        {layer.error && <p className="tsf-set-note" role="alert" data-testid={`author-error-${layer.name}`}>Status: failed. {layer.error}</p>}
        <LayerAuthoringRow layer={layer} />
      </div>
    </li>
  );
}

function LayersPanel() {
  const layers = useFactory((s) => s.layers);
  const { toast } = useToast();
  // Bottom-up: the last layer applied is at the top, factory_harness (loaded first) at the bottom.
  const sorted = useMemo(() => [...layers].sort((a, b) => b.order - a.order), [layers]);
  return (
    <div className="tsf-set-panel" data-testid="panel-layers">
      <LayerToolbar />
      <SettingsBlock />
      <section className="tsf-set-group" data-cap="layers.list" data-testid="layer-stack">
        <p className="tsf-set-note">Layers bottom-up: the first loaded is at the bottom, the last applied at the top. A layer that is off adds no tools, prompt sections or widgets from the next request.</p>
        <ol className="tsf-layers">
          {sorted.map((l) => (
            <LayerRow
              key={l.name}
              layer={l}
              onToggle={(v) =>
                api.layerStack.setEnabled(l.name, v).catch((e: unknown) => toast({ tone: "error", title: `${l.title} was not switched`, description: errorMessage(e) }))
              }
            />
          ))}
        </ol>
      </section>
    </div>
  );
}

function ProvidersPanel() {
  const layers = useFactory((s) => s.layers).filter((l) => l.kind === "provider");
  const current = useFactory((s) => s.chat?.meta.model ?? s.settings?.model ?? null);
  const models = useModels();
  const { toast } = useToast();
  const counts = new Map<string, number>();
  for (const m of models.data ?? []) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  return (
    <div className="tsf-set-panel" data-testid="panel-providers">
      <section className="tsf-set-group" data-cap="layers.list">
        <p className="tsf-set-note">Provider layers supply the models. Keys come from <code>tsf/.env</code> and are never shown.</p>
        {layers.length === 0 && <p className="tsf-set-note">No provider layer is loaded.</p>}
        <ul className="tsf-layers">
          {layers.map((l) => (
            <li key={l.name} className="tsf-layer" data-testid={`provider-${l.name}`} data-enabled={l.enabled ? "true" : "false"}>
              <div className="tsf-layer-main">
                <Toggle
                  label={
                    <>
                      <strong>{l.title}</strong> <code>{l.name}</code>
                    </>
                  }
                  checked={l.enabled}
                  disabled={l.required}
                  onChange={(v) => api.layerStack.setEnabled(l.name, v).catch((e: unknown) => toast({ tone: "error", title: "The provider was not switched", description: errorMessage(e) }))}
                  data-cap="layers.set_enabled"
                  data-testid={`provider-toggle-${l.name}`}
                />
                <div className="tsf-layer-badges">
                  {l.env.map((v) => (
                    <Badge key={v.name} tone={v.present ? "success" : v.required ? "error" : "neutral"}>
                      {v.name}: {v.present ? "set" : "missing"}
                    </Badge>
                  ))}
                  {current && counts.has(current.provider) && l.name.includes(current.provider) && <Badge tone="info">In use</Badge>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {counts.size > 0 && (
          <StatusLine>
            Models offered: {[...counts].map(([p, n]) => `${p} ${n}`).join(", ")}.
          </StatusLine>
        )}
      </section>
    </div>
  );
}

function List({ title, items, testId }: { title: string; items: readonly string[]; testId: string }) {
  return (
    <div className="tsf-set-group" data-testid={testId}>
      <h4 className="tsf-set-h2">{title}</h4>
      {items.length === 0 ? (
        <p className="tsf-set-note">None.</p>
      ) : (
        <ul className="tsf-chips">
          {items.map((i) => (
            <li key={i}>
              <code>{i}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CeilingPanel() {
  const ceiling = useFactory((s) => s.ceiling);
  if (!ceiling) return <p className="tsf-set-note">Loading</p>;
  return (
    <div className="tsf-set-panel" data-testid="panel-ceiling" data-cap="ceiling.view">
      <Alert tone="info" soft>
        The ceiling is read from <code>{ceiling.file}</code> ({ceiling.source === "file" ? "file found" : "no file, everything allowed"}) when the factory starts. It cannot be changed here or by the agent; edit the file and restart.
      </Alert>
      <div className="tsf-set-grid">
        <List title="Allow" items={ceiling.allow} testId="ceiling-allow" />
        <List title="Deny" items={ceiling.deny} testId="ceiling-deny" />
        {ceiling.cliPatterns !== null && <List title="--tools for this run" items={ceiling.cliPatterns} testId="ceiling-cli" />}
      </div>
      <div className="tsf-set-grid">
        <List title={`Allowed tools (${ceiling.allowed.length})`} items={ceiling.allowed} testId="ceiling-allowed" />
        <List title={`Denied tools (${ceiling.denied.length})`} items={ceiling.denied} testId="ceiling-denied" />
      </div>
    </div>
  );
}

const when = (t: number): string => new Date(t).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" });
const secs = (ms: number | null): string => (ms === null ? "running" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function RunsPanel() {
  const recent = useFactory((s) => s.runs);
  const [older, setOlder] = useState<RunSummary[]>([]);
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runs = useMemo(() => {
    const seen = new Set(recent.map((r) => r.id));
    return [...recent, ...older.filter((r) => !seen.has(r.id))];
  }, [recent, older]);

  useEffect(() => {
    if (open === null) {
      setDetail(null);
      return;
    }
    let live = true;
    setError(null);
    api.runs.get(open).then(
      (d) => live && setDetail(d),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [open, recent.find((r) => r.id === open)?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = (): void => {
    const oldest = runs[runs.length - 1];
    api.runs.list(oldest?.id).then(
      (list) => {
        setOlder((prev) => [...prev, ...list]);
        setMore(list.length >= 20);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };

  return (
    <div className="tsf-set-panel" data-testid="panel-runs">
      <section className="tsf-set-group" data-cap="runs.list">
        {runs.length === 0 ? (
          <p className="tsf-set-note" data-testid="runs-empty">No runs yet. Send the agent a message.</p>
        ) : (
          <table className="tsf-runs" data-testid="runs-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Started</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Tools</th>
                <th>Tokens</th>
                <th>Time</th>
                <th>Prompt</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} data-testid={`run-${r.id}`} data-status={r.status} data-open={open === r.id ? "true" : "false"}>
                  <td>
                    <Button variant="ghost" size="sm" aria-expanded={open === r.id} data-cap="runs.get" data-testid={`run-open-${r.id}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      #{r.id}
                    </Button>
                  </td>
                  <td>{when(r.startedAt)}</td>
                  <td>{r.trigger}</td>
                  <td>
                    <Badge tone={r.status === "answered" ? "success" : r.status === "failed" ? "error" : r.status === "running" ? "info" : "neutral"}>{r.status}</Badge>
                  </td>
                  <td>{r.toolCalls}</td>
                  <td>{tokens(r.usage.totalTokens)}</td>
                  <td>{secs(r.durationMs)}</td>
                  <td className="tsf-runs-prompt">{r.prompt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {more && runs.length >= 20 && (
          <div className="tsf-set-row">
            <Button variant="secondary" size="sm" data-cap="runs.list" data-testid="runs-older" onClick={loadOlder}>
              Load older runs
            </Button>
          </div>
        )}
        {error !== null && <p className="tsf-set-note" role="alert">{error}</p>}
      </section>
      {detail && open !== null && (
        <section className="tsf-set-group" data-cap="runs.get" data-testid="run-detail">
          <h3 className="tsf-set-h">Run #{detail.id}</h3>
          <p className="tsf-set-note">
            {detail.model ?? "unknown model"}, {detail.turns} turns, cost {detail.usage.costUsd.toFixed(4)} USD ({detail.costSource}).
            {detail.failure ? ` Failed: ${detail.failure}` : ""}
          </p>
          {detail.tools.length === 0 ? (
            <p className="tsf-set-note">No tool calls.</p>
          ) : (
            <ul className="tsf-chips" data-testid="run-tools">
              {detail.tools.map((t) => (
                <li key={t.callId} title={t.diagnostic ?? undefined}>
                  <code>{t.name}</code> <Badge tone={t.status === "done" ? "success" : "warning"}>{t.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** One yes/no question to jev (TypeSafe System One); choice and score questions are for the agent's jev_judge tool. */
function JevPanel() {
  const layers = useFactory((s) => s.layers);
  const keySet = layers.find((l) => l.name === "factory_harness")?.env.find((v) => v.name === "TYPESAFE_API_KEY")?.present ?? false;
  const [question, setQuestion] = useState("Is this text polite?");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<JevVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  const judge = (): void => {
    setBusy(true);
    setError(null);
    setVerdict(null);
    api.jev.judge({ kind: "noul", question, state: text }).then(
      (v) => {
        setVerdict(v);
        setBusy(false);
      },
      (e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      },
    );
  };

  return (
    <div className="tsf-set-panel" data-testid="panel-jev">
      <section className="tsf-set-group">
        <p className="tsf-set-note">
          jev is TypeSafe's System One model: it answers one narrow question about some text with a probability. The agent uses the same service through its <code>jev_judge</code> tool.
        </p>
        {!keySet && (
          <Alert tone="warning" soft data-testid="jev-no-key">
            <code>TYPESAFE_API_KEY</code> is not set, so jev cannot answer. Add it to <code>tsf/.env</code> (on a vault-routed VM the value is <code>agent-vault</code>) and restart.
          </Alert>
        )}
        <Field label="Question (yes or no)">
          {(f) => <Input {...f} value={question} onChange={(e) => setQuestion(e.target.value)} spellCheck={false} autoComplete="off" data-testid="jev-question" />}
        </Field>
        <Field label="Text to judge">
          {(f) => <Textarea {...f} value={text} rows={4} onChange={(e) => setText(e.target.value)} data-testid="jev-text" />}
        </Field>
        <div className="tsf-set-row">
          <Button variant="primary" size="sm" disabled={busy || text.trim() === "" || question.trim() === ""} data-cap="jev.judge" data-testid="jev-judge" onClick={judge}>
            {busy ? "Judging" : "Judge"}
          </Button>
        </div>
        {verdict !== null && verdict.kind === "noul" && (
          <div data-testid="jev-result">
            <StatusLine>
              Probability of yes: {(verdict.probability * 100).toFixed(1)}% ({verdict.model}).
            </StatusLine>
          </div>
        )}
        {error !== null && <p className="tsf-set-note" role="alert" data-testid="jev-error">{error}</p>}
      </section>
    </div>
  );
}

/** The factory's own web build, process and rendered UI (P9 "Liquid core"): rebuild, restart and screenshot. */
function FactoryPanel() {
  const web = useFactory((s) => s.status?.web ?? null);
  const webError = useFactory((s) => s.webError);
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState<RebuildWebResult | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [shot, setShot] = useState<ScreenshotResult | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);

  const rebuild = (): void => {
    setBuilding(true);
    setBuilt(null);
    setBuildError(null);
    api.factory.rebuildWeb().then(
      (r) => {
        setBuilt(r);
        setBuilding(false);
      },
      (e: unknown) => {
        setBuildError(errorMessage(e));
        setBuilding(false);
      },
    );
  };
  const restart = (): void => {
    setConfirmRestart(false);
    setRestartNote(null);
    api.factory.restart("Settings > Advanced > Factory").then(
      (r) => setRestartNote(`Restarting in ${(r.restartingInMs / 1000).toFixed(1)} s. This page reconnects by itself.`),
      (e: unknown) => setRestartNote(errorMessage(e)),
    );
  };
  const screenshot = (): void => {
    setShooting(true);
    setShot(null);
    setShotError(null);
    api.factory.screenshot({}).then(
      (r) => {
        setShot(r);
        setShooting(false);
      },
      (e: unknown) => {
        setShotError(errorMessage(e));
        setShooting(false);
      },
    );
  };

  return (
    <div className="tsf-set-panel" data-testid="panel-factory">
      <section className="tsf-set-group">
        <p className="tsf-set-note">
          The factory's own source is in <code>tsf/app</code> (a project made with <code>--no-app</code> runs the shared app instead). Edits to <code>src/web</code> rebuild by themselves;
          edits to the server or core need a restart. The agent has the same three controls as tools.
        </p>
      </section>

      <section className="tsf-set-group" data-testid="factory-web">
        <h3 className="tsf-set-h">Web build</h3>
        <p className="tsf-set-note">
          {web?.hash ? (
            <>
              Serving build <code data-testid="factory-web-hash">{web.hash}</code>
              {web.building ? " (building)" : ""}.
            </>
          ) : (
            "No built web app is being served by this process."
          )}
        </p>
        {webError !== null && (
          <Alert tone="error" soft data-testid="factory-web-error">
            <pre className="tsf-web-error-text">{webError}</pre>
          </Alert>
        )}
        <div className="tsf-set-row">
          <Button variant="secondary" size="sm" disabled={building} data-cap="factory.rebuild_web" data-testid="factory-rebuild-web" onClick={rebuild}>
            {building ? "Rebuilding" : "Rebuild web"}
          </Button>
        </div>
        {built !== null && (
          <div data-testid="factory-rebuild-result" data-ok={built.ok ? "true" : "false"}>
            <StatusLine>
              {built.ok ? `Built ${built.hash ?? ""} in ${built.durationMs} ms.` : `Build failed after ${built.durationMs} ms: ${built.error ?? "unknown error"}`}
            </StatusLine>
          </div>
        )}
        {buildError !== null && <p className="tsf-set-note" role="alert" data-testid="factory-rebuild-error">{buildError}</p>}
      </section>

      <section className="tsf-set-group" data-testid="factory-restart">
        <h3 className="tsf-set-h">Process</h3>
        <p className="tsf-set-note">Restarting stops the server cleanly and starts it again. The conversation continues; open pages reconnect.</p>
        <div className="tsf-set-row">
          <Button variant="danger" size="sm" data-cap="factory.restart" data-testid="factory-restart-button" onClick={() => setConfirmRestart(true)}>
            Restart factory
          </Button>
        </div>
        <ConfirmDialog open={confirmRestart} onOpenChange={setConfirmRestart} title="Restart factory" confirmLabel="Restart" onConfirm={restart}>
          The factory restarts in a moment. A turn the agent is working on continues afterwards.
        </ConfirmDialog>
        {restartNote !== null && <p className="tsf-set-note" data-testid="factory-restart-result">{restartNote}</p>}
      </section>

      <section className="tsf-set-group" data-testid="factory-screenshot">
        <h3 className="tsf-set-h">Screenshot</h3>
        <p className="tsf-set-note">
          Captures this factory's page with headless Chromium. Needs the browser installed once: <code>npx playwright install chromium</code> inside <code>tsf/app</code>.
        </p>
        <div className="tsf-set-row">
          <Button variant="secondary" size="sm" disabled={shooting} data-cap="ui.screenshot" data-testid="factory-screenshot-button" onClick={screenshot}>
            {shooting ? "Capturing" : "Screenshot"}
          </Button>
        </div>
        {shot !== null && (
          <figure className="tsf-shot" data-testid="factory-screenshot-result">
            <img src={shot.url} alt={`Screenshot ${shot.file}`} width={shot.width} height={shot.height} className="tsf-shot-img" />
            <figcaption className="tsf-set-note">
              {shot.file} ({shot.width} x {shot.height})
            </figcaption>
          </figure>
        )}
        {shotError !== null && <p className="tsf-set-note" role="alert" data-testid="factory-screenshot-error">{shotError}</p>}
      </section>
    </div>
  );
}

export function Advanced({ tab, onTab }: { tab: string; onTab: (id: string) => void }) {
  return (
    <>
      <Tabs items={ADVANCED_TABS} value={tab} onChange={onTab} label="Advanced" className="tsf-tabs-sub" testId="settings-advanced" />
      {tab === "layers" && <LayersPanel />}
      {tab === "providers" && <ProvidersPanel />}
      {tab === "ceiling" && <CeilingPanel />}
      {tab === "runs" && <RunsPanel />}
      {tab === "jev" && <JevPanel />}
      {tab === "factory" && <FactoryPanel />}
    </>
  );
}
