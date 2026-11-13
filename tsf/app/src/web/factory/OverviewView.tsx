/** Overview: the pipeline (board, gaffer, builder, repository), a getting-started checklist and the merged timeline. */
import { ArrowRight, CheckCircle2, Circle, GitBranch, Hammer, KanbanSquare, Radio } from "lucide-react";
import { Alert, Button, Card } from "@pw/ui/react";
import { useState } from "react";
import { RecentEvents, ScreenTabs, StatusChip, Timeline, ago, type FactoryEvent, type ScreenTab } from "./common.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";
import { builderDot, gafferDot } from "./FactoryNav.tsx";

interface GafferStatus {
  running: boolean;
  pid: number | null;
  ready: boolean;
  tokenPresent: boolean;
  builderUrl: string;
  board: { boardId: string; orgId: string; baseUrl: string };
  handover: boolean;
  lastEvent: FactoryEvent | null;
}
interface BuilderStatus {
  running: boolean;
  pid: number | null;
  url: string;
  pi: { provider: string; model: string };
  lastEvent: FactoryEvent | null;
}
interface Health {
  ok: boolean;
  busy: boolean;
  job: { title: string; context: string; step: string; startedAt: number } | null;
  lastJob: { title: string; outcome: string; endedAt: number } | null;
  error?: string;
}
interface Slice {
  id: string;
  title: string;
  status: string | null;
}
interface Settings {
  repoUrl: string;
  name: string;
}

function chipOf(dot: string): { state: "running" | "stopped" | "missing" | "busy" | "idle" | "ok" | "warn" | "error"; label: string } {
  switch (dot) {
    case "running":
      return { state: "running", label: "Running" };
    case "busy":
      return { state: "busy", label: "Working" };
    case "stopped":
      return { state: "stopped", label: "Stopped" };
    case "warn":
      return { state: "warn", label: "Needs setup" };
    case "error":
      return { state: "error", label: "Failed" };
    default:
      return { state: "stopped", label: "Unknown" };
  }
}

export function OverviewView() {
  const gaffer = useLayerQuery<GafferStatus>("gaffer", "status", {}, 5000);
  const settings = useLayerQuery<Settings>("gaffer", "settings");
  const builder = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const health = useLayerQuery<Health>("builder", "health", {}, 4000);
  const slices = useLayerQuery<{ slices: Slice[]; summary: string }>("gaffer", "slices", {}, 15000);
  const gEvents = useLayerQuery<{ events: FactoryEvent[] }>("gaffer", "events", { limit: 60 });
  const bEvents = useLayerQuery<{ events: FactoryEvent[] }>("builder", "events", { limit: 60 });
  const gAct = useLayerAction("gaffer");
  const bAct = useLayerAction("builder");
  const [tab, setTab] = useState<ScreenTab>("dashboard");

  const g = gaffer.data;
  const b = builder.data;
  const h = health.data;
  const gDot = gafferDot(g);
  const bDot = builderDot(b, !!h?.busy);
  const merged = [...(gEvents.data?.events ?? []), ...(bEvents.data?.events ?? [])].sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  const counts = (slices.data?.slices ?? []).reduce<Record<string, number>>((acc, s) => {
    const k = s.status ?? "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const boardOk = !!g?.tokenPresent && !slices.data?.summary.startsWith("board unavailable");

  const steps = [
    { done: !!g?.tokenPresent, title: "Connect the board", hint: "Board id, organisation, token", action: () => setView("gaffer") },
    { done: !!g?.ready, title: "Set up the gaffer", hint: "Clone the target repository and install the gaffer kit", action: () => void gAct.run("setup"), busy: gAct.busy === "setup", label: "Set up" },
    { done: !!b?.running, title: "Start the build server", hint: b?.url ?? "", action: () => void bAct.run("start"), busy: bAct.busy === "start", label: "Start" },
    { done: !!g?.running, title: "Start the gaffer", hint: "Polls the board and builds Planned slices", action: () => void gAct.run("start"), busy: gAct.busy === "start", label: "Start" },
    { done: (counts.Planned ?? 0) + (counts.InProgress ?? 0) + (counts.Done ?? 0) > 0, title: "Plan a slice", hint: "Set a slice to Planned on the Gaffer screen", action: () => setView("gaffer") },
  ];
  const allDone = steps.every((s) => s.done);
  const settled = (gEvents.data?.events ?? []).filter((e) => e.kind === "settled" || e.kind === "turn.fail").slice(0, 5);

  return (
    <div className="tsf-fx-screen" data-testid="overview-view">
      <div className="tsf-fx-head">
        <h1>Overview</h1>
        <p className="tsf-fx-head-sub">Board to repository: the gaffer claims Planned slices, the builder implements them, the gaffer merges and settles.</p>
      </div>

      {(gAct.error || bAct.error) && (
        <Alert
          tone="error"
          soft
          onDismiss={() => {
            gAct.clearError();
            bAct.clearError();
          }}
        >
          {gAct.error ?? bAct.error}
        </Alert>
      )}

      <ScreenTabs value={tab} onChange={setTab} logs={false} />

      {tab === "dashboard" && (
      <>
      <div className="tsf-fx-pipeline">
        <div className="tsf-fx-stage" data-state={boardOk ? "ok" : "warn"}>
          <div className="tsf-fx-stage-head">
            <KanbanSquare className="tsf-fx-stage-icon" aria-hidden="true" />
            <span className="tsf-fx-stage-title">Board</span>
            <StatusChip state={boardOk ? "ok" : "warn"} label={boardOk ? "Connected" : g?.tokenPresent ? "Unreachable" : "No token"} />
          </div>
          <div className="tsf-fx-stage-body">
            {slices.data?.slices.length ? (
              Object.entries(counts).map(([k, n]) => (
                <div key={k}>
                  {n} {k}
                </div>
              ))
            ) : (
              <span>{g?.tokenPresent ? (slices.data?.summary ?? "Loading…") : "Enter the board token on the Gaffer screen."}</span>
            )}
          </div>
          <div className="tsf-fx-stage-foot">
            <Button size="sm" variant="secondary" onClick={() => setView("gaffer")}>
              Slices
            </Button>
          </div>
          <ArrowRight className="tsf-fx-stage-arrow" aria-hidden="true" />
        </div>

        <div className="tsf-fx-stage" data-state={gDot}>
          <div className="tsf-fx-stage-head">
            <Radio className="tsf-fx-stage-icon" aria-hidden="true" />
            <span className="tsf-fx-stage-title">Gaffer</span>
            <StatusChip {...chipOf(gDot)} />
          </div>
          <div className="tsf-fx-stage-body">
            {g?.lastEvent ? (
              <span>
                {g.lastEvent.kind}: {g.lastEvent.msg} <em>({ago(g.lastEvent.ts)})</em>
              </span>
            ) : (
              <span>{g?.ready ? "Idle, nothing claimed yet." : "Not set up."}</span>
            )}
          </div>
          <div className="tsf-fx-stage-foot">
            {g?.running ? (
              <Button size="sm" variant="secondary" loading={gAct.busy === "stop"} onClick={() => void gAct.run("stop")}>
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!g?.ready} loading={gAct.busy === "start"} onClick={() => void gAct.run("start")}>
                Start
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setView("gaffer")}>
              Open
            </Button>
          </div>
          <ArrowRight className="tsf-fx-stage-arrow" aria-hidden="true" />
        </div>

        <div className="tsf-fx-stage" data-state={bDot}>
          <div className="tsf-fx-stage-head">
            <Hammer className="tsf-fx-stage-icon" aria-hidden="true" />
            <span className="tsf-fx-stage-title">Builder</span>
            <StatusChip {...chipOf(bDot)} />
          </div>
          <div className="tsf-fx-stage-body">
            {h?.busy && h.job ? (
              <span>
                Building {h.job.context}/{h.job.title} ({h.job.step}, {ago(h.job.startedAt)})
              </span>
            ) : h?.lastJob ? (
              <span>
                Last job {h.lastJob.title}: {h.lastJob.outcome} ({ago(h.lastJob.endedAt)})
              </span>
            ) : (
              <span>{b?.running ? "Idle." : "Stopped."}</span>
            )}
            {b && (
              <div>
                pi: {b.pi.provider}/{b.pi.model}
              </div>
            )}
          </div>
          <div className="tsf-fx-stage-foot">
            {b?.running ? (
              <Button size="sm" variant="secondary" loading={bAct.busy === "stop"} onClick={() => void bAct.run("stop")}>
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" loading={bAct.busy === "start"} onClick={() => void bAct.run("start")}>
                Start
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setView("builder")}>
              Open
            </Button>
          </div>
          <ArrowRight className="tsf-fx-stage-arrow" aria-hidden="true" />
        </div>

        <div className="tsf-fx-stage" data-state={g?.ready ? "ok" : "stopped"}>
          <div className="tsf-fx-stage-head">
            <GitBranch className="tsf-fx-stage-icon" aria-hidden="true" />
            <span className="tsf-fx-stage-title">Repository</span>
            <StatusChip state={g?.ready ? "ok" : "stopped"} label={g?.ready ? "Cloned" : "Not cloned"} />
          </div>
          <div className="tsf-fx-stage-body">
            <span className="tsf-fx-mono">{settings.data?.repoUrl ?? "…"}</span>
            <div>main is pushed before every dispatch and after every merge.</div>
          </div>
          <div className="tsf-fx-stage-foot">
            {settings.data?.repoUrl && /github\.com/.test(settings.data.repoUrl) && (
              <Button size="sm" variant="ghost" onClick={() => window.open(`https://github.com/${settings.data!.repoUrl.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "")}/commits/main`, "_blank", "noopener")}>
                Commits
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="tsf-fx-cols">
        {!allDone ? (
          <Card title="Getting started" description="Each step is one click. Done steps stay checked.">
            <ol className="tsf-fx-steps">
              {steps.map((s) => (
                <li key={s.title} className="tsf-fx-step" data-done={s.done}>
                  {s.done ? <CheckCircle2 className="tsf-fx-step-icon" aria-hidden="true" /> : <Circle className="tsf-fx-step-icon" aria-hidden="true" />}
                  <span>
                    <span className="tsf-fx-step-title">{s.title}</span>
                    <span className="tsf-fx-step-hint">{s.hint}</span>
                  </span>
                  {!s.done && (
                    <Button size="sm" variant={s.label ? "primary" : "secondary"} loading={"busy" in s && s.busy} onClick={s.action}>
                      {s.label ?? "Open"}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        ) : (
          <Card title="Latest builds" description="The last slices the gaffer settled.">
            {settled.length ? (
              <ol className="tsf-fx-steps">
                {settled.map((e) => (
                  <li key={e.ts} className="tsf-fx-step" data-done="true">
                    <CheckCircle2 className="tsf-fx-step-icon" aria-hidden="true" />
                    <span>
                      <span className="tsf-fx-step-title">{e.slice}</span>
                      <span className="tsf-fx-step-hint">
                        {e.msg} · {ago(e.ts)}
                      </span>
                    </span>
                    <span />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="tsf-fx-muted">No slice settled yet.</p>
            )}
          </Card>
        )}

        <RecentEvents events={merged} showSource onMore={() => setTab("timeline")} />
      </div>
      </>
      )}

      {tab === "timeline" && (
        <Card title="Timeline" description="Gaffer and builder events, newest first.">
          <Timeline events={merged} showSource limit={200} />
        </Card>
      )}
    </div>
  );
}
