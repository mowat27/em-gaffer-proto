/**
 * Builder screen: the build server's state, its current and last job (the machine feed, `builder events`), its controls
 * (`builder server start|stop|restart`), an agent's model (a versioned `agent_update` of its settings.json), the
 * timeline, the job and server logs, each run's story from its journals (Sessions), the operator's notifications (Ops)
 * and the machine config. Everything goes through the builder layer, which calls the builder CLI.
 * The server has no settings here: they are machine config, edited by the operator in a layer.
 */
import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { Alert, Button, Card, Field, Select } from "@pw/ui/react";
import type { Json } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useModels } from "../state/queries.ts";
import { Pre, RecentEvents, ScreenTabs, StatusChip, Timeline, ago, type FactoryEvent, type ScreenTab } from "./common.tsx";
import { OpsView } from "./OpsView.tsx";
import { SessionsView } from "./SessionsView.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";

export interface BuilderStatus {
  running: boolean;
  state: "stopped" | "idle" | "busy" | "draining";
  pid: number | null;
  url: string | null;
  builder: string | null;
  job: { jobId: string; name: string; runId: string; step: string; slice: string; attempt: number | null; startedAt: string | null } | null;
  lastJob: { jobId: string | null; name: string | null; slice: string | null; outcome: string; reason: string | null; endedAt: string } | null;
  lastEvent: FactoryEvent | null;
  followError: string | null;
  summary: string;
}

export interface AgentModel {
  agent: string;
  provider: string;
  model: string;
  thinking: string;
}

/** The agent the model picker changes: the agent of supabase-api's implement step. */
export const MODEL_AGENT = "supabase-api";
export const THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface Instance {
  instance: string | null;
  version: string | null;
  runsDir: string;
  layers: string[];
  config: Record<string, Json>;
  sources: Record<string, string>;
}

/** The value at a dotted path. */
const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

function ConfigView() {
  const config = useLayerQuery<Instance>("builder", "config");
  const c = config.data;
  return (
    <Card title="Machine config" description="builder config: the merged layers, lowest first, and the layer each value came from. To change a value, edit a layer (~/.gaffer/config.yml, $GAFFER_CONFIG or --config) and run builder config reload; no tool changes it.">
      {config.error && (
        <Alert tone="error" soft>
          {config.error}
        </Alert>
      )}
      {c && (
        <>
          <dl className="tsf-fx-kv">
            <dt>Instance</dt>
            <dd>{c.instance ?? "(none)"}</dd>
            <dt>Version</dt>
            <dd className="tsf-fx-mono">{c.version ?? "(unknown)"}</dd>
            <dt>Runs</dt>
            <dd className="tsf-fx-mono">{c.runsDir}</dd>
            <dt>Layers</dt>
            <dd>{c.layers.map((l, i) => <div key={l}>{`${i + 1}. ${l}`}</div>)}</dd>
          </dl>
          <table className="tsf-fx-table" style={{ marginTop: "var(--pw-sp-3)" }}>
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Layer</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(c.sources)
                .sort()
                .map((k) => (
                  <tr key={k}>
                    <td className="tsf-fx-mono">{k}</td>
                    <td className="tsf-fx-mono">{JSON.stringify(at(c.config, k))}</td>
                    <td>{c.sources[k]}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function ModelCard() {
  const model = useLayerQuery<AgentModel>("builder", "model", { agent: MODEL_AGENT });
  const act = useLayerAction("builder");
  const models = useModels();
  const [draft, setDraft] = useState<Partial<AgentModel>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setDraft({}), [model.data]);
  const cur = { ...model.data, ...draft } as Partial<AgentModel>;
  const modelList = models.data ?? [];
  const providers = useMemo(() => [...new Set(modelList.map((m) => m.provider))], [modelList]);
  const own = modelList.filter((m) => m.provider === cur.provider);
  const options = (own.length ? own : modelList).map((m) => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} (${m.id})` })).sort((a, b) => a.label.localeCompare(b.label));
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    const out = await act.run("set_model", { agent: MODEL_AGENT, ...draft } as Json);
    if (out !== null) {
      setDraft({});
      model.refresh();
    }
  };
  const refreshModels = (): void => {
    setRefreshing(true);
    api.models
      .refresh()
      .catch((err) => setNote(`Model list not refreshed: ${errorMessage(err)}`))
      .finally(() => setRefreshing(false));
  };
  const select = (key: keyof AgentModel, label: string, opts: { value: string; label: string }[]) => (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={String(cur[key] ?? "")} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} disabled={!model.data || act.busy !== null}>
          {!opts.some((o) => o.value === String(cur[key] ?? "")) && <option value={String(cur[key] ?? "")}>{String(cur[key] ?? "") || "(pi default)"}</option>}
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  return (
    <Card
      title={`Model: ${MODEL_AGENT}`}
      description={`The agent's settings.json. Saving is a versioned change (agent_update); it applies from the agent's next run.`}
      actions={
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={refreshing} onClick={refreshModels}>
          Refresh models
        </Button>
      }
    >
      {(model.error || act.error || note) && (
        <Alert tone={note && !model.error && !act.error ? "info" : "error"} soft onDismiss={() => (act.clearError(), setNote(null))}>
          {model.error ?? act.error ?? note}
        </Alert>
      )}
      <div className="tsf-fx-fields">
        {select("provider", "Provider", providers.map((p) => ({ value: p, label: p })))}
        {select("model", "Model", options)}
        {select("thinking", "Thinking", THINKING.map((t) => ({ value: t, label: t || "(pi default)" })))}
      </div>
      <div className="tsf-fx-form-actions">
        <Button size="sm" variant="primary" icon={Play} loading={act.busy === "set_model"} disabled={!dirty} onClick={() => void save()}>
          Save model
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft({})}>
            Discard
          </Button>
        )}
      </div>
    </Card>
  );
}

interface LogTail {
  runId: string;
  kind: string;
  state: string;
  job?: string;
  text: string;
}

/** The latest job's log (its steps' commands, the pi command, prompt and output) and the build server's, secrets hidden. */
function LogsView({ job }: { job: string | null }) {
  const jobLog = useLayerQuery<LogTail>("builder", "log_tail", { run: job ?? "latest", lines: 300 }, 5000);
  const serverLog = useLayerQuery<LogTail>("builder", "log_tail", { run: "server", lines: 120 }, 10000);
  return (
    <>
      <Card title={jobLog.data?.job ? `Job log ${jobLog.data.job}` : "Job log"} description="The latest job's log: its steps' commands, the pi command, prompt and output.">
        {jobLog.error && (
          <Alert tone="error" soft>
            {jobLog.error}
          </Alert>
        )}
        <Pre text={jobLog.data?.text ?? ""} max={300} />
      </Card>
      <Card title="Server log" description="The build server's own output.">
        {serverLog.error && (
          <Alert tone="error" soft>
            {serverLog.error}
          </Alert>
        )}
        <Pre text={serverLog.data?.text ?? ""} max={120} />
      </Card>
    </>
  );
}

export function BuilderView() {
  const status = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const events = useLayerQuery<{ events: FactoryEvent[] }>("builder", "events", { limit: 200 });
  const act = useLayerAction("builder");
  const [tab, setTab] = useState<ScreenTab>("dashboard");
  const s = status.data;
  const chip = !s ? null : s.state === "stopped" ? { state: "stopped" as const, label: "Stopped" } : s.state === "busy" ? { state: "busy" as const, label: "Building" } : s.state === "draining" ? { state: "warn" as const, label: "Draining" } : { state: "idle" as const, label: `Idle (pid ${s.pid})` };

  return (
    <div className="tsf-fx-screen" data-testid="builder-view">
      <div className="tsf-fx-head">
        <h1>Builder</h1>
        {chip && <StatusChip state={chip.state} label={chip.label} />}
        <div className="tsf-fx-actions">
          {s?.running ? (
            <>
              <Button size="sm" variant="secondary" icon={RotateCw} loading={act.busy === "restart"} onClick={() => void act.run("restart")}>
                Restart
              </Button>
              <Button size="sm" variant="secondary" icon={Square} loading={act.busy === "stop"} onClick={() => void act.run("stop")}>
                Stop
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon={Play} loading={act.busy === "start"} onClick={() => void act.run("start")}>
              Start
            </Button>
          )}
        </div>
        <p className="tsf-fx-head-sub">
          The build server (<code>builder server run</code>): one slice job at a time on <code>POST /slices</code>, each job a workflow run of the active builder, the patch sent back to the gaffer. Status is the machine feed (
          <code>builder events</code>); the buttons run <code>builder server start|stop|restart</code>. Its settings are machine config.
        </p>
      </div>

      {act.error && (
        <Alert tone="error" soft onDismiss={act.clearError}>
          {act.error}
        </Alert>
      )}
      {s?.followError && (
        <Alert tone="warning" soft>
          {s.followError}
        </Alert>
      )}

      <ScreenTabs value={tab} onChange={setTab} />

      {tab === "logs" && <LogsView job={s?.job?.jobId ?? s?.lastJob?.jobId ?? null} />}
      {tab === "sessions" && <SessionsView />}
      {tab === "ops" && <OpsView />}
      {tab === "config" && <ConfigView />}

      {tab === "timeline" && (
        <Card title="Timeline" description={s?.lastEvent ? `The machine feed, newest first. Last event ${ago(s.lastEvent.ts)}` : "Nothing yet"}>
          <Timeline events={events.data?.events ?? []} limit={200} />
        </Card>
      )}

      {tab === "dashboard" && (
        <div className="tsf-fx-cols">
          <Card title="Current job" description={s?.url ? `POST ${s.url}/slices${s.builder ? `, builder ${s.builder}` : ""}` : ""}>
            {s?.job ? (
              <dl className="tsf-fx-kv">
                <dt>Slice</dt>
                <dd>
                  {s.job.slice || "?"}
                  {s.job.attempt !== null ? ` (attempt ${s.job.attempt})` : ""}
                </dd>
                <dt>Step</dt>
                <dd>
                  <StatusChip state="busy" label={s.job.step || "starting"} />
                </dd>
                <dt>Started</dt>
                <dd>{ago(s.job.startedAt)}</dd>
                <dt>Job</dt>
                <dd>
                  {s.job.name ? `${s.job.name} ` : ""}
                  <span className="tsf-fx-mono">{s.job.jobId}</span>
                </dd>
                <dt>Run</dt>
                <dd className="tsf-fx-mono">{s.job.runId}</dd>
              </dl>
            ) : s?.lastJob ? (
              <dl className="tsf-fx-kv">
                <dt>{s.running ? "Idle" : "Stopped"}</dt>
                <dd>{s.running ? "waiting for a dispatch" : "start the server to accept jobs"}</dd>
                <dt>Last job</dt>
                <dd>
                  {s.lastJob.name ? `${s.lastJob.name}, ` : ""}
                  {s.lastJob.slice ?? ""}: <StatusChip state={s.lastJob.outcome === "done" ? "ok" : "error"} label={s.lastJob.outcome} /> {ago(s.lastJob.endedAt)}
                </dd>
                {s.lastJob.reason && (
                  <>
                    <dt>Reason</dt>
                    <dd>{s.lastJob.reason}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="tsf-fx-muted">{s?.running ? "Idle, no job yet." : "Start the server to accept jobs."}</p>
            )}
          </Card>

          <ModelCard />

          <RecentEvents events={events.data?.events ?? []} onMore={() => setTab("timeline")} />
        </div>
      )}
    </div>
  );
}
