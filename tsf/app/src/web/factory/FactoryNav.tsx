/** The left pane's factory section: Overview, Gaffer and Builder with live status dots, above the page tree. */
import { Hammer, LayoutDashboard, Radio, TerminalSquare } from "lucide-react";
import { useLayerQuery } from "./useLayer.ts";
import { setView, useView, type View } from "./viewStore.ts";

interface GafferStatus {
  running: boolean;
  ready: boolean;
  tokenPresent: boolean;
  lastEvent: { kind: string } | null;
}
interface BuilderStatus {
  running: boolean;
  lastEvent: { kind: string } | null;
}

export function gafferDot(s: GafferStatus | null): string {
  if (!s) return "unknown";
  if (!s.running) return s.ready && s.tokenPresent ? "stopped" : "warn";
  const k = s.lastEvent?.kind ?? "";
  if (/fail/.test(k)) return "error";
  if (/turn\.start|dispatch|waiting|apply|gate|merged|listener|accepted|base|push/.test(k) && !/turn\.end|settled/.test(k)) return "busy";
  return "running";
}

export function builderDot(s: BuilderStatus | null, busy: boolean): string {
  if (!s) return "unknown";
  if (!s.running) return "stopped";
  if (busy) return "busy";
  if (/fail/.test(s.lastEvent?.kind ?? "")) return "error";
  return "running";
}

export function FactoryNav() {
  const view = useView();
  const gaffer = useLayerQuery<GafferStatus>("gaffer", "status", {}, 5000);
  const builder = useLayerQuery<BuilderStatus>("builder", "status", {}, 5000);
  const health = useLayerQuery<{ ok: boolean; busy: boolean }>("builder", "health", {}, 4000);
  const items: { id: View; label: string; icon: typeof Radio; dot?: string }[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "gaffer", label: "Gaffer", icon: Radio, dot: gafferDot(gaffer.data) },
    { id: "builder", label: "Builder", icon: Hammer, dot: builderDot(builder.data, !!health.data?.busy) },
    { id: "pi-terminal", label: "Pi terminal", icon: TerminalSquare }, 
  ];
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
