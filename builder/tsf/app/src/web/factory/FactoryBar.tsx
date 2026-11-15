/**
 * The top bar's factory strip: the builder's stage dot and quick actions to set the builder's model and thinking
 * effort. Everything goes through the same layer queries and actions the screens and the agent use.
 */
import { useMemo } from "react";
import { api } from "../api/client.ts";
import { useModels } from "../state/queries.ts";
import { builderDot } from "./FactoryNav.tsx";
import { useLayerAction, useLayerQuery } from "./useLayer.ts";
import { setView } from "./viewStore.ts";

interface BuilderStatus {
  running: boolean;
  lastEvent: { kind: string } | null;
}

const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function FactoryBar() {
  const builder = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const health = useLayerQuery<{ ok: boolean; busy: boolean }>("builder", "health", {}, 4000);
  const bSettings = useLayerQuery<{ pi_provider: string; pi_model: string; pi_thinking: string }>("builder", "settings");
  const bAct = useLayerAction("builder");
  const models = useModels();

  const b = builder.data;
  const stages = [{ label: "Builder", dot: builderDot(b, !!health.data?.busy), view: "builder" as const }];

  const modelList = models.data ?? [];
  const provider = bSettings.data?.pi_provider ?? "";
  const modelOptions = useMemo(() => {
    const own = modelList.filter((m) => m.provider === provider);
    return (own.length ? own : modelList).map((m) => ({ value: m.id, label: m.name || m.id })).sort((a, b) => a.label.localeCompare(b.label));
  }, [modelList, provider]);
  const model = bSettings.data?.pi_model ?? "";
  const effort = bSettings.data?.pi_thinking ?? "";

  const set = (key: string, value: string): void => {
    void (async () => {
      const saved = await bAct.run("set_setting", { key, value });
      if (saved === null) return;
      const piKey: Record<string, string> = {
        pi_provider: "defaultProvider",
        pi_model: "defaultModel",
        pi_thinking: "defaultThinkingLevel",
      };
      if (piKey[key]) {
        const current = await api.builderAgent.read("settings.json");
        const settings = JSON.parse(current.content) as Record<string, unknown>;
        settings[piKey[key]] = value;
        await api.builderAgent.write("settings.json", `${JSON.stringify(settings, null, 2)}\n`);
      }
      bSettings.refresh();
    })();
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
        {bAct.error && (
          <span className="tsf-fxbar-error" role="alert" title={bAct.error}>
            failed
          </span>
        )}
      </div>
    </div>
  );
}
