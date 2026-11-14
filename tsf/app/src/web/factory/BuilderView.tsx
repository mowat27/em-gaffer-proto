/** Builder screen: controls, the current job, the pi agent configuration, server settings, timeline and job log. */
import { useMemo, useState } from "react";
import { Play, RefreshCw, Square } from "lucide-react";
import { Alert, Button, Card } from "@pw/ui/react";
import type { Json } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useModels } from "../state/queries.ts";
import { Pre, RecentEvents, ScreenTabs, SettingsForm, StatusChip, Timeline, ago, type FactoryEvent, type ScreenTab } from "./common.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";

interface BuilderStatus {
  running: boolean;
  pid: number | null;
  url: string;
  workspaceDir: string;
  lastEvent: FactoryEvent | null;
}
interface Health {
  ok: boolean;
  busy: boolean;
  job: { jobId: string; title: string; context: string; attempt: number; step: string; startedAt: number } | null;
  lastJob: { jobId: string; title: string; outcome: string; endedAt: number } | null;
  pi?: { provider: string; model: string; thinking: string; agentDir: string };
  error?: string;
}

const THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function BuilderView() {
  const status = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const health = useLayerQuery<Health>("builder", "health", {}, 4000);
  const settings = useLayerQuery<Record<string, Json>>("builder", "settings");
  const events = useLayerQuery<{ events: FactoryEvent[] }>("builder", "events", { limit: 120 });
  const jobLog = useLayerQuery<{ jobId: string | null; tail: string }>("builder", "job_log", { lines: 300 }, 5000);
  const log = useLayerQuery<{ tail: string }>("builder", "log", { lines: 120 }, 10000);
  const act = useLayerAction("builder");
  const [tab, setTab] = useState<ScreenTab>("dashboard");
  const [refreshing, setRefreshing] = useState(false);
  const models = useModels();

  const s = status.data;
  const h = health.data;
  const restartNeeded = (changed: string[]): boolean => changed.some((k) => k === "host" || k === "port");
  const [note, setNote] = useState<string | null>(null);

  const providerVal = String(settings.data?.pi_provider ?? "");
  const modelList = models.data ?? [];
  const providers = useMemo(() => [...new Set(modelList.map((m) => m.provider))], [modelList]);
  const providerModels = modelList.filter((m) => m.provider === providerVal);
  const modelOptions = (providerModels.length ? providerModels : modelList)
    .map((m) => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} (${m.id})` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const syncPiRuntime = async (changes: Record<string, Json>): Promise<void> => {
    const map: Record<string, string> = { pi_provider: "defaultProvider", pi_model: "defaultModel", pi_thinking: "defaultThinkingLevel" };
    const updates = Object.entries(changes).filter(([key, value]) => map[key] && typeof value === "string");
    if (!updates.length) return;
    const current = await api.builderAgent.read("settings.json");
    const config = JSON.parse(current.content) as Record<string, unknown>;
    for (const [key, value] of updates) config[map[key]] = value;
    await api.builderAgent.write("settings.json", `${JSON.stringify(config, null, 2)}\n`);
  };

  const refreshModels = (): void => {
    setRefreshing(true);
    api.models
      .refresh()
      .catch((err) => setNote(`Model list not refreshed: ${errorMessage(err)}`))
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="tsf-fx-screen" data-testid="builder-view">
      <div className="tsf-fx-head">
        <h1>Builder</h1>
        {s && <StatusChip state={!s.running ? "stopped" : h?.busy ? "busy" : "idle"} label={!s.running ? "Stopped" : h?.busy ? "Building" : `Idle (pid ${s.pid})`} />}
        <div className="tsf-fx-actions">
          {s?.running ? (
            <Button size="sm" variant="secondary" icon={Square} loading={act.busy === "stop"} onClick={() => void act.run("stop")}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={Play} loading={act.busy === "start"} onClick={() => void act.run("start")}>
              Start
            </Button>
          )}
        </div>
        <p className="tsf-fx-head-sub">
          The build server (<code>builder/server.ts</code>): one job at a time, a fresh clone at the requested base, the pi agent run inside it, the commits sent back as a patch. No board
          access, no write access to the repository.
        </p>
      </div>

      {act.error && (
        <Alert tone="error" soft onDismiss={act.clearError}>
          {act.error}
        </Alert>
      )}
      {note && (
        <Alert tone="info" soft onDismiss={() => setNote(null)}>
          {note}
        </Alert>
      )}

      <ScreenTabs value={tab} onChange={setTab} />

      {tab === "timeline" && (
        <Card title="Timeline" description={s?.lastEvent ? `Last event ${ago(s.lastEvent.ts)}` : "Nothing yet"} actions={<Button size="sm" variant="ghost" onClick={() => void act.run("clear_events")}>Clear</Button>}>
          <Timeline events={events.data?.events ?? []} limit={200} />
        </Card>
      )}

      {tab === "logs" && (
        <>
          <Card title={jobLog.data?.jobId ? `Job log ${jobLog.data.jobId.slice(0, 8)}` : "Job log"} description="The pi command, prompt and output of the latest job.">
            <Pre text={jobLog.data?.tail ?? ""} />
          </Card>
          <Card title="Server log" description="The build server's own output.">
            <Pre text={log.data?.tail ?? ""} />
          </Card>
        </>
      )}

      {tab === "dashboard" && (
      <div className="tsf-fx-cols">
        <Card title="Current job" description={s?.url ? `POST ${s.url}/slices` : ""}>
          {h?.busy && h.job ? (
            <dl className="tsf-fx-kv">
              <dt>Slice</dt>
              <dd>
                {h.job.context}/{h.job.title} (attempt {h.job.attempt})
              </dd>
              <dt>Step</dt>
              <dd>
                <StatusChip state="busy" label={h.job.step} />
              </dd>
              <dt>Started</dt>
              <dd>{ago(h.job.startedAt)}</dd>
              <dt>Job</dt>
              <dd className="tsf-fx-mono">{h.job.jobId}</dd>
            </dl>
          ) : h?.lastJob ? (
            <dl className="tsf-fx-kv">
              <dt>Idle</dt>
              <dd>waiting for a dispatch</dd>
              <dt>Last job</dt>
              <dd>
                {h.lastJob.title}: <StatusChip state={h.lastJob.outcome === "done" ? "ok" : "error"} label={h.lastJob.outcome} /> {ago(h.lastJob.endedAt)}
              </dd>
            </dl>
          ) : (
            <p className="tsf-fx-muted">{s?.running ? (h?.ok ? "Idle, no job yet." : `Server not answering: ${h?.error ?? ""}`) : "Start the server to accept jobs."}</p>
          )}
          {h?.pi && (
            <p className="tsf-fx-muted" style={{ marginTop: "var(--pw-sp-3)" }}>
              Loaded pi config: {h.pi.provider}/{h.pi.model}
              {h.pi.thinking ? `, thinking ${h.pi.thinking}` : ""}
            </p>
          )}
        </Card>

        <Card title="Server" description="Host and port need a stop and start; the rest applies to the next job.">
          <SettingsForm
            layer="builder"
            values={settings.data}
            fields={[
              { key: "host", label: "Listen host" },
              { key: "port", label: "Listen port", kind: "number" },
              { key: "capabilities", label: "Capabilities", help: "requires entries it meets, comma-separated" },
              { key: "logbookFile", label: "Logbook file", mono: true },
              { key: "workspaceDir", label: "Workspace directory", mono: true },
              { key: "jobTimeoutMinutes", label: "Job timeout (minutes)", kind: "number" },
            ]}
            saveLabel="Save server"
            onSaved={(changed) => {
              if (restartNeeded(changed)) setNote("Host or port changed: stop and start the server to apply it.");
            }}
          />
        </Card>

        <Card
          title="pi agent"
          description="The CLI invocation. Saved values apply to the next job; no restart needed."
          actions={
            <Button size="sm" variant="ghost" icon={RefreshCw} loading={refreshing} onClick={refreshModels}>
              Refresh models
            </Button>
          }
        >
          <SettingsForm
            layer="builder"
            values={settings.data}
            fields={[
              { key: "pi_provider", label: "Provider", kind: providers.length ? { select: providers } : "text" },
              { key: "pi_model", label: "Model", mono: true, kind: modelOptions.length ? { select: modelOptions } : "text", help: modelOptions.length ? undefined : "No models loaded; refresh or check the provider layer." },
              { key: "pi_thinking", label: "Thinking", kind: { select: THINKING } },
              { key: "pi_timeoutMinutes", label: "Timeout (minutes)", kind: "number" },
              { key: "pi_command", label: "pi command", mono: true, help: "The pi binary; the factory already runs under the vault" },
              { key: "pi_agentDir", label: "Agent dir", mono: true, help: "PI_CODING_AGENT_DIR: settings.json, AGENTS.md, prompts/, extensions/, skills/; empty = ~/.pi/agent" },
              { key: "pi_args", label: "Flags", mono: true, wide: true, help: "Shell-style; placed before -p" },
            ]}
            saveLabel="Save agent"
            onSaved={(_changed, changes) => {
              void syncPiRuntime(changes).catch((err) => setNote(`Pi settings were saved but could not be synchronised: ${errorMessage(err)}`));
            }}
          />
          <p className="tsf-fx-muted" style={{ marginTop: "var(--pw-sp-3)" }}>
            Instructions, prompts, extensions and skills are real files in <code>builder/pi-agent/</code>, read directly by Pi for each job. Open <button type="button" className="tsf-link-button" onClick={() => setView("pi-agent")}>Pi agent</button> to browse their current contents.
          </p>
        </Card>

        <RecentEvents events={events.data?.events ?? []} onMore={() => setTab("timeline")} />
      </div>
      )}
    </div>
  );
}
