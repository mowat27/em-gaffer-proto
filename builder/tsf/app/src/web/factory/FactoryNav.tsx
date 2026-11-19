/** The left pane's factory section: Builder with a live status dot (the machine feed), above the agent tree and the page tree. */
import { Hammer } from "lucide-react";
import { useLayerQuery } from "./useLayer.ts";
import { setView, useView, type View } from "./viewStore.ts";

interface BuilderStatus {
  running: boolean;
  state: string;
  lastEvent: { kind: string } | null;
}

export function builderDot(s: BuilderStatus | null): string {
  if (!s) return "unknown";
  if (!s.running) return "stopped";
  if (s.state === "busy") return "busy";
  if (s.state === "draining") return "warn";
  if (/fail|gone|abandoned/.test(s.lastEvent?.kind ?? "")) return "error";
  return "running";
}

export function FactoryNav() {
  const view = useView();
  const builder = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const items: { id: View; label: string; icon: typeof Hammer; dot?: string }[] = [{ id: "builder", label: "Builder", icon: Hammer, dot: builderDot(builder.data) }];
  return (
    <nav className="tsf-fx-nav" aria-label="Factory">
      <h3 className="tsf-fx-nav-title">Factory</h3>
      <ul className="tsf-fx-nav-list">
        {items.map((it) => (
          <li key={it.id}>
            <button type="button" className="tsf-fx-nav-item" aria-current={view === it.id ? "page" : undefined} onClick={() => setView(it.id)}>
              <it.icon className="tsf-fx-nav-icon" aria-hidden="true" />
              <span className="tsf-fx-nav-label">{it.label}</span>
              {it.dot && <span className="tsf-fx-dot" data-state={it.dot} aria-label={it.dot} title={it.dot} />}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
