/**
 * Renders one navbar of the UI config (DESIGN 11, spec 8.2): its placements in slot order (left, centre, right), array
 * order inside a slot, each wrapped with `data-testid="widget-<placement id>"`. A `fullWidth` option makes the widget take
 * a line of its own. A widget whose layer is switched off is left out. The component has no controls of its own: widgets are added, moved and removed in Settings > Layout
 * (`widgets.*`) or by the agent, and the change arrives as `ui_config.changed`.
 */
import type { NavbarId, NavbarSlot, WidgetPlacement } from "../../shared/types.ts";
import { useFactory } from "../state/store.ts";
import { isSwitchedOff, Widget } from "./widgets.tsx";

const SLOTS: readonly NavbarSlot[] = ["left", "center", "right"];

export function Navbar({ id, className }: { id: NavbarId; className?: string }) {
  const navbar = useFactory((s) => s.uiConfig.navbars[id]);
  const layers = useFactory((s) => s.layers);
  if (!navbar.visible) return null;
  const shown = navbar.items.filter((p) => !isSwitchedOff(p.widget, layers));
  const ordered: WidgetPlacement[] = SLOTS.flatMap((slot) => shown.filter((p) => p.slot === slot));
  const firstCenter = ordered.findIndex((p) => p.slot === "center");
  const firstRight = ordered.findIndex((p) => p.slot === "right");
  return (
    <div className={className ? `tsf-navbar ${className}` : "tsf-navbar"} data-testid={`navbar-${id}`} data-navbar={id}>
      {ordered.map((p, i) => (
        <div
          key={p.id}
          className="tsf-navbar-item"
          data-testid={`widget-${p.id}`}
          data-widget={p.widget}
          data-slot={p.slot}
          data-full={p.options.fullWidth === true ? "true" : "false"}
          data-first={i === firstCenter || i === firstRight ? "true" : undefined}
        >
          <Widget placement={p} navbar={id} />
        </div>
      ))}
    </div>
  );
}
