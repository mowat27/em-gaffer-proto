/** Gaffer screen: controls, board connection (with token entry), builder link, the board's slices, timeline and log. */
import { useState } from "react";
import { KeyRound, Play, RefreshCw, Square, Wrench } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Input } from "@pw/ui/react";
import type { Json } from "../../shared/types.ts";
import { Pre, RecentEvents, ScreenTabs, SettingsForm, StatusChip, Timeline, ago, type FactoryEvent, type ScreenTab } from "./common.tsx";
import { TurnsView } from "./TurnsView.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";

interface GafferStatus {
  running: boolean;
  pid: number | null;
  ready: boolean;
  tokenPresent: boolean;
  home: string;
  builderUrl: string;
  callback: string;
  lastEvent: FactoryEvent | null;
}
interface Slice {
  id: string;
  title: string;
  status: string | null;
  type: string | null;
  context: string | null;
}

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "info" | "neutral" | "accent" | "brand"> = {
  Planned: "brand",
  InProgress: "info",
  Done: "success",
  Waiting: "accent",
  Blocked: "error",
};

const STATUSES = ["Planned", "InProgress", "Done", "Waiting", "Blocked", "Backlog"];

function TokenForm({ present, onSaved }: { present: boolean; onSaved: () => void }) {
  const act = useLayerAction("gaffer");
  const [token, setToken] = useState("");
  const save = async (): Promise<void> => {
    if (!token.trim()) return;
    const r = await act.run("set_token", { token: token.trim() });
    if (r !== null) {
      setToken("");
      onSaved();
    }
  };
  return (
    <form
      className="tsf-fx-inline"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Board token" help={present ? "A token is stored. Paste a new one to replace it; it is never shown." : "From app.eventmodelers.ai > Account > API tokens. Stored with mode 600, never shown or logged."}>
        {(p) => <Input {...p} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={present ? "••••••••" : "paste the token"} />}
      </Field>
      <Button type="submit" variant={present ? "secondary" : "primary"} size="sm" icon={KeyRound} loading={act.busy === "set_token"} disabled={!token.trim()}>
        {present ? "Replace token" : "Save token"}
      </Button>
      {act.error && (
        <Alert tone="error" soft onDismiss={act.clearError}>
          {act.error}
        </Alert>
      )}
    </form>
  );
}

export function GafferView() {
  const status = useLayerQuery<GafferStatus>("gaffer", "status", {}, 5000);
  const settings = useLayerQuery<Record<string, Json>>("gaffer", "settings");
  const slices = useLayerQuery<{ slices: Slice[]; summary: string }>("gaffer", "slices", {}, 15000);
  const events = useLayerQuery<{ events: FactoryEvent[] }>("gaffer", "events", { limit: 120 });
  const log = useLayerQuery<{ tail: string }>("gaffer", "log", { lines: 120 }, 10000);
  const act = useLayerAction("gaffer");
  const [tab, setTab] = useState<ScreenTab>("dashboard");
  const [planStatus, setPlanStatus] = useState("Planned");
  const [planning, setPlanning] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const s = status.data;
  const fullRestart = async (): Promise<void> => {
    setRestarting(true);
    try {
      if (s?.running && await act.run("stop") === null) return;
      if (await act.run("setup") === null) return;
      await act.run("start");
      status.refresh();
    } finally {
      setRestarting(false);
    }
  };
  const plan = async (slice: Slice): Promise<void> => {
    setPlanning(slice.id);
    await act.run("plan_slice", { slice: slice.id, status: planStatus });
    setPlanning(null);
    slices.refresh();
  };
  const blocked = (slices.data?.slices ?? []).filter((sl) => sl.status === "Blocked");
  const boardError = slices.data?.summary.startsWith("board unavailable") ? slices.data.summary : null;

  return (
    <div className="tsf-fx-screen" data-testid="gaffer-view">
      <div className="tsf-fx-head">
        <h1>Gaffer</h1>
        {s && <StatusChip state={s.running ? "running" : s.ready ? "stopped" : "missing"} label={s.running ? `Running (pid ${s.pid})` : s.ready ? "Stopped" : "Not set up"} />}
        <div className="tsf-fx-actions">
          <Button size="sm" variant="primary" icon={RefreshCw} loading={restarting} disabled={!s?.tokenPresent || restarting} onClick={() => void fullRestart()}>
            Restart &amp; set up
          </Button>
          <Button size="sm" variant="secondary" icon={Wrench} loading={act.busy === "setup"} disabled={!s?.tokenPresent} onClick={() => void act.run("setup")}>
            {s?.ready ? "Re-run setup" : "Set up"}
          </Button>
          {s?.running ? (
            <Button size="sm" variant="secondary" icon={Square} loading={act.busy === "stop"} onClick={() => void act.run("stop")}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={Play} disabled={!s?.ready} loading={act.busy === "start"} onClick={() => void act.run("start")}>
              Start
            </Button>
          )}
        </div>
        <p className="tsf-fx-head-sub">
          The eventmodelers shared runner with <code>gaffer.ts</code> as its <code>--exec</code> command, in its own clone of the target repository. It claims Planned slices, sends each to the
          builder, applies the patch, gates, merges, pushes and settles the slice.
        </p>
      </div>

      {act.error && (
        <Alert tone="error" soft onDismiss={act.clearError}>
          {act.error}
        </Alert>
      )}
      {blocked.length > 0 && (
        <Alert tone="error" title={blocked.length === 1 ? "1 slice is Blocked" : `${blocked.length} slices are Blocked`}>
          {blocked.map((sl) => `${sl.context ? `${sl.context}/` : ""}${sl.title}`).join(", ")}: the runner gave up after 5 failed attempts. The reason is in the slice's note on the board and in the timeline
          (slice.blocked). Set a slice back to Planned to retry it.
        </Alert>
      )}
      {s && !s.tokenPresent && (
        <Alert tone="warning" title="Connect the board">
          <p className="tsf-fx-muted" style={{ marginBottom: "var(--pw-sp-2)" }}>
            Paste the board token to connect. Then Set up clones the target repository, and Start begins polling the board.
          </p>
          <TokenForm present={false} onSaved={() => status.refresh()} />
        </Alert>
      )}

      <ScreenTabs value={tab} onChange={setTab} turns />

      {tab === "turns" && <TurnsView />}

      {tab === "timeline" && (
        <Card title="Timeline" description={s?.lastEvent ? `Last event ${ago(s.lastEvent.ts)}` : "Nothing yet"} actions={<Button size="sm" variant="ghost" onClick={() => void act.run("clear_events")}>Clear</Button>}>
          <Timeline events={events.data?.events ?? []} limit={200} />
        </Card>
      )}

      {tab === "logs" && (
        <Card title="Runner log" description="The eventmodelers run output, token masked.">
          <Pre text={log.data?.tail ?? ""} />
        </Card>
      )}

      {tab === "dashboard" && (
      <div className="tsf-fx-cols">
        <Card
          className="tsf-fx-span"
          title="Board slices"
          description={boardError ?? "Set a slice to Planned and the gaffer picks it up on its next poll."}
          actions={
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={slices.refresh} loading={slices.loading}>
              Refresh
            </Button>
          }
        >
          {slices.data?.slices.length ? (
            <>
              <table className="tsf-fx-table">
                <thead>
                  <tr>
                    <th>Slice</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>
                      <select className="tsf-fx-mini-select" value={planStatus} onChange={(e) => setPlanStatus(e.target.value)} aria-label="Status to set">
                        {STATUSES.map((st) => (
                          <option key={st} value={st}>
                            Set to {st}
                          </option>
                        ))}
                      </select>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {slices.data.slices.map((sl) => (
                    <tr key={sl.id}>
                      <td>
                        <strong>{sl.title}</strong>
                        {sl.context && <span className="tsf-fx-step-hint">{sl.context}</span>}
                      </td>
                      <td className="tsf-fx-muted">{sl.type ?? ""}</td>
                      <td>
                        <Badge tone={STATUS_TONE[sl.status ?? ""] ?? "neutral"}>{sl.status ?? "none"}</Badge>
                      </td>
                      <td>
                        <Button size="sm" variant={planStatus === "Planned" ? "primary" : "secondary"} loading={planning === sl.id} disabled={sl.status === planStatus} onClick={() => void plan(sl)}>
                          {planStatus === "Planned" ? "Plan" : "Set"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="tsf-fx-muted">Only slice statuses and comments change on the board; the model itself is left alone.</p>
            </>
          ) : (
            <p className="tsf-fx-muted">{s?.tokenPresent ? (slices.loading ? "Loading…" : (slices.data?.summary ?? "No slices.")) : "Connect the board first."}</p>
          )}
        </Card>

        <Card title="Board connection" description="Which board the gaffer works and where the target code lives. Re-run setup after changing these.">
          <SettingsForm
            layer="gaffer"
            values={settings.data}
            fields={[
              { key: "name", label: "Gaffer name", help: "Names the home folder and the clone" },
              { key: "agentName", label: "Agent name on the board" },
              { key: "boardId", label: "Board id", mono: true },
              { key: "orgId", label: "Organisation id", mono: true },
              { key: "baseUrl", label: "Platform base URL", mono: true },
              { key: "repoUrl", label: "Target repository (git URL)", mono: true, wide: true },
              { key: "branch", label: "Target branch", mono: true, help: "The branch to dispatch builds to and fast-forward after each successful build." },
            ]}
            saveLabel="Save connection"
          >
            <TokenForm present={!!s?.tokenPresent} onSaved={() => status.refresh()} />
          </SettingsForm>
        </Card>

        <Card title="Builder link and build rules" description="Apply at the next start of the gaffer.">
          <SettingsForm
            layer="gaffer"
            values={settings.data}
            fields={[
              { key: "builderHost", label: "Builder host" },
              { key: "builderPort", label: "Builder port", kind: "number" },
              { key: "callbackHost", label: "Callback host (listen)" },
              { key: "callbackPort", label: "Callback port", kind: "number" },
              { key: "handover", label: "Handover", kind: "toggle", help: "On: slices end Waiting for a UI kit. Off: Done." },
              { key: "turnTimeoutMinutes", label: "Turn timeout (minutes)", kind: "number" },
              { key: "requires", label: "Extra requires", help: "Comma-separated; repo:<target> is always added" },
              { key: "gate", label: "Gate command", help: "Run in the clone after the patch; empty = none", mono: true },
            ]}
          />
        </Card>

        <Card title="Addresses" description="Where the gaffer talks to the builder and where its clone lives.">
          {s ? (
            <dl className="tsf-fx-kv">
              <dt>Dispatch</dt>
              <dd className="tsf-fx-mono">POST {s.builderUrl}/slices</dd>
              <dt>Callback</dt>
              <dd className="tsf-fx-mono">{s.callback}</dd>
              <dt>Home</dt>
              <dd className="tsf-fx-mono">{s.home}</dd>
              <dt>Logbook</dt>
              <dd className="tsf-fx-mono">{s.home}/repo/LOGBOOK.md</dd>
            </dl>
          ) : (
            <p className="tsf-fx-muted">Loading…</p>
          )}
        </Card>

        <RecentEvents events={events.data?.events ?? []} onMore={() => setTab("timeline")} />
      </div>
      )}
    </div>
  );
}
