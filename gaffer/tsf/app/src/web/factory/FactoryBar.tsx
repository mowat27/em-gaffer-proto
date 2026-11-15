/**
 * The top bar's factory strip: a minimal stage summary (Board, Gaffer, Repository as status dots), the latest commit on
 * main in the gaffer's clone, and the quick action to plan a slice. Everything goes through the same layer queries and
 * actions the screens and the agent use.
 */
import { ago } from "./common.tsx";
import { gafferDot } from "./FactoryNav.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";

interface GafferStatus {
  running: boolean;
  ready: boolean;
  tokenPresent: boolean;
  head: { sha: string; subject: string; author: string; date: string } | null;
  lastEvent: { kind: string; msg: string; ts: string } | null;
}
interface Slice {
  id: string;
  title: string;
  status: string | null;
}

export function FactoryBar() {
  const gaffer = useLayerQuery<GafferStatus>("gaffer", "status", {}, 5000);
  const slices = useLayerQuery<{ slices: Slice[]; summary: string }>("gaffer", "slices", {}, 15000);
  const gAct = useLayerAction("gaffer");

  const g = gaffer.data;
  const boardOk = !!g?.tokenPresent && !slices.data?.summary.startsWith("board unavailable");
  const stages = [
    { label: "Board", dot: boardOk ? "running" : g?.tokenPresent ? "error" : "warn", view: "gaffer" as const },
    { label: "Gaffer", dot: gafferDot(g), view: "gaffer" as const },
    { label: "Repo", dot: g?.ready ? "running" : "warn", view: "overview" as const },
  ];

  const plannable = (slices.data?.slices ?? []).filter((s) => s.status !== "Planned" && s.status !== "InProgress");

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
        {gAct.error && (
          <span className="tsf-fxbar-error" role="alert" title={gAct.error}>
            failed
          </span>
        )}
      </div>
    </div>
  );
}
