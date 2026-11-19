/**
 * The top bar's factory strip: the builder's stage dot (the machine feed) and quick pickers for an agent's model and
 * thinking effort. A pick is a versioned `agent_update` of the agent's settings.json, through the builder layer's
 * set_model action (the builder CLI), the same path the Builder screen and the agent use.
 */
import { useMemo } from "react";
import type { Json } from "../../shared/types.ts";
import { useModels } from "../state/queries.ts";
import { MODEL_AGENT, type AgentModel } from "./BuilderView.tsx";
import { builderDot } from "./FactoryNav.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";

interface BuilderStatus {
  running: boolean;
  state: string;
  lastEvent: { kind: string } | null;
}

const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function FactoryBar() {
  const builder = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const agent = useLayerQuery<AgentModel>("builder", "model", { agent: MODEL_AGENT });
  const act = useLayerAction("builder");
  const models = useModels();

  const stages = [{ label: "Builder", dot: builderDot(builder.data), view: "builder" as const }];

  const modelList = models.data ?? [];
  const provider = agent.data?.provider ?? "";
  const modelOptions = useMemo(() => {
    const own = modelList.filter((m) => m.provider === provider);
    return (own.length ? own : modelList).map((m) => ({ value: m.id, label: m.name || m.id })).sort((a, b) => a.label.localeCompare(b.label));
  }, [modelList, provider]);
  const model = agent.data?.model ?? "";
  const effort = agent.data?.thinking ?? "";

  const set = (key: "model" | "thinking", value: string): void => {
    void act.run("set_model", { agent: MODEL_AGENT, [key]: value } as Json).then(() => agent.refresh());
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

      <div className="tsf-fxbar-actions">
        <label className="tsf-fxbar-field">
          <span>Model</span>
          <select className="tsf-fx-mini-select" value={model} aria-label={`${MODEL_AGENT} model`} disabled={act.busy !== null || !agent.data} onChange={(e) => set("model", e.target.value)}>
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
          <select className="tsf-fx-mini-select" value={effort} aria-label={`${MODEL_AGENT} thinking effort`} disabled={act.busy !== null || !agent.data} onChange={(e) => set("thinking", e.target.value)}>
            <option value="">default</option>
            {EFFORT.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        {(act.error || agent.error) && (
          <span className="tsf-fxbar-error" role="alert" title={act.error ?? agent.error ?? ""}>
            failed
          </span>
        )}
      </div>
    </div>
  );
}
