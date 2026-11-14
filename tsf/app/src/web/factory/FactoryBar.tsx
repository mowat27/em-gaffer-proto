/**
 * The top bar's factory strip: a minimal stage summary (Board, Gaffer, Builder, Repository as status dots), the latest
 * commit on main in the gaffer's clone, and quick actions: plan a slice, set the builder's model and thinking effort.
 * Everything goes through the same layer queries and actions the screens and the agent use.
 */
import { useMemo } from "react";
import { useModels } from "../state/queries.ts";
import { ago } from "./common.tsx";
import { builderDot, gafferDot } from "./FactoryNav.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";

interface GafferStatus {
  running: boolean;
  ready: boolean;
  tokenPresent: boolean;
  head: { sha: string; subject: string; author: string; date: string } | null;
  lastEvent: { kind: string; msg: string; ts: string } | null;
}
interface BuilderStatus {
  running: boolean;
  lastEvent: { kind: string } | null;
}
interface Slice {
  id: string;
  title: string;
  status: string | null;
}

const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function FactoryBar() {
  const gaffer = useLayerQuery<GafferStatus>("gaffer", "status", {}, 5000);
  const builder = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const health = useLayerQuery<{ ok: boolean; busy: boolean }>("builder", "health", {}, 4000);
  const slices = useLayerQuery<{ slices: Slice[]; summary: string }>("gaffer", "slices", {}, 15000);
  const bSettings = useLayerQuery<{ pi_provider: string; pi_model: string; pi_thinking: string }>("builder", "settings");
  const gAct = useLayerAction("gaffer");
  const bAct = useLayerAction("builder");
  const models = useModels();

  const g = gaffer.data;
  const b = builder.data;
  const boardOk = !!g?.tokenPresent && !slices.data?.summary.startsWith("board unavailable");
  const stages = [
    { label: "Board", dot: boardOk ? "running" : g?.tokenPresent ? "error" : "warn", view: "gaffer" as const },
    { label: "Gaffer", dot: gafferDot(g), view: "gaffer" as const },
    { label: "Builder", dot: builderDot(b, !!health.data?.busy), view: "builder" as const },
    { label: "Repo", dot: g?.ready ? "running" : "warn", view: "overview" as const },
  ];

  const plannable = (slices.data?.slices ?? []).filter((s) => s.status !== "Planned" && s.status !== "InProgress");
  const modelList = models.data ?? [];
  const provider = bSettings.data?.pi_provider ?? "";
  const modelOptions = useMemo(() => {
    const own = modelList.filter((m) => m.provider === provider);
    return (own.length ? own : modelList).map((m) => ({ value: m.id, label: m.name || m.id })).sort((a, b) => a.label.localeCompare(b.label));
  }, [modelList, provider]);
  const model = bSettings.data?.pi_model ?? "";
  const effort = bSettings.data?.pi_thinking ?? "";

  const set = (key: string, value: string): void => {
    void bAct.run("set_setting", { key, value }).then(() => bSettings.refresh());
  };

  return (
    <div className="tsf-fxbar" data-testid="factory-bar">
      <ul className="tsf-fxbar-stages" aria-label="Pipeline">
        {stages.map((st) => (
          <li key={st.label}>
            <button type="button" className="tsf-fxbar-stage" onClick={() => setView(st.view)} title={`${st.label}: ${st.dot}`}>
              <span className="tsf-fx-dot" data-state={st.dot} aria-hidden="true" />
              <span>{st.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="tsf-fxbar-commit" title={g?.head ? `${g.head.sha} ${g.head.subject}\n${g.head.author}, ${ago(g.head.date)}` : "No clone yet"}>
        {g?.head ? (
          <>
            <code>{g.head.sha}</code>
            <span className="tsf-fxbar-subject">{g.head.subject}</span>
            <em>{ago(g.head.date)}</em>
          </>
        ) : (
          <span className="tsf-fx-muted">no commit</span>
        )}
      </div>

      <div className="tsf-fxbar-actions">
        <label className="tsf-fxbar-field">
          <span>Plan</span>
          <select
            className="tsf-fx-mini-select"
            value=""
            disabled={!boardOk || gAct.busy === "plan_slice"}
            aria-label="Plan a slice"
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              void gAct.run("plan_slice", { slice: id, status: "Planned" }).then(() => slices.refresh());
            }}
          >
            <option value="">{gAct.busy === "plan_slice" ? "planning…" : plannable.length ? "slice…" : "nothing to plan"}</option>
            {plannable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} ({s.status ?? "none"})
              </option>
            ))}
          </select>
        </label>
        <label className="tsf-fxbar-field">
          <span>Model</span>
          <select className="tsf-fx-mini-select" value={model} aria-label="Builder model" disabled={bAct.busy !== null} onChange={(e) => set("pi_model", e.target.value)}>
            {!modelOptions.some((m) => m.value === model) && model && <option value={model}>{model}</option>}
            {modelOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tsf-fxbar-field">
          <span>Effort</span>
          <select className="tsf-fx-mini-select" value={effort} aria-label="Builder thinking effort" disabled={bAct.busy !== null} onChange={(e) => set("pi_thinking", e.target.value)}>
            <option value="">default</option>
            {EFFORT.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        {(gAct.error || bAct.error) && (
          <span className="tsf-fxbar-error" role="alert" title={gAct.error ?? bAct.error ?? ""}>
            failed
          </span>
        )}
      </div>
    </div>
  );
}
