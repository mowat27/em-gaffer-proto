/** Overview: the pipeline (board, gaffer, repository), a getting-started checklist and the gaffer timeline. */
import { ArrowRight, CheckCircle2, Circle, GitBranch, KanbanSquare, Radio } from "lucide-react";
import { Alert, Button, Card } from "@pw/ui/react";
import { useState } from "react";
import { RecentEvents, ScreenTabs, StatusChip, Timeline, ago, type FactoryEvent, type ScreenTab } from "./common.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";
import { gafferDot } from "./FactoryNav.tsx";

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
  const slices = useLayerQuery<{ slices: Slice[]; summary: string }>("gaffer", "slices", {}, 15000);
  const gEvents = useLayerQuery<{ events: FactoryEvent[] }>("gaffer", "events", { limit: 60 });
  const gAct = useLayerAction("gaffer");
  const [tab, setTab] = useState<ScreenTab>("dashboard");

  const g = gaffer.data;
  const gDot = gafferDot(g);
  const merged = gEvents.data?.events ?? [];
  const counts = (slices.data?.slices ?? []).reduce<Record<string, number>>((acc, s) => {
    const k = s.status ?? "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const boardOk = !!g?.tokenPresent && !slices.data?.summary.startsWith("board unavailable");

  const steps = [
    { done: !!g?.tokenPresent, title: "Connect the board", hint: "Board id, organisation, token", action: () => setView("gaffer") },
    { done: !!g?.ready, title: "Set up the gaffer", hint: "Clone the target repository and install the gaffer kit", action: () => void gAct.run("setup"), busy: gAct.busy === "setup", label: "Set up" },
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

      {gAct.error && (
        <Alert tone="error" soft onDismiss={gAct.clearError}>
          {gAct.error}
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
        <Card title="Timeline" description="Gaffer events, newest first.">
          <Timeline events={merged} showSource limit={200} />
        </Card>
      )}
    </div>
  );
}
