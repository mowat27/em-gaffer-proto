/**
 * Settings > Essentials > Layout and widgets (spec 8.4): which panes show, which navbars show, and the widgets in each
 * navbar (add, remove, move, full width). Everything applies at once through the Service routes; the page follows the
 * `ui_config.changed` event, so what is shown here is always the stored document.
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Select, StatusLine, useToast } from "@pw/ui/react";
import type { LayerInfo, NavbarId, NavbarSlot, WidgetPlacement } from "../../shared/types.ts";
import { BUILTIN_WIDGETS } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { WIDGET_TITLES } from "../navbar/widgets.tsx";
import { acceptUiConfig, useFactory } from "../state/store.ts";
import { Toggle } from "./controls.tsx";
import { WidgetTypes } from "./WidgetTypes.tsx";

const NAVBARS: readonly { id: NavbarId; title: string }[] = [
  { id: "global", title: "Global navbar" },
  { id: "agent", title: "Agent navbar" },
];
const SLOTS: readonly NavbarSlot[] = ["left", "center", "right"];

interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly navbars: readonly NavbarId[];
}

/** Built-in widgets plus the widgets of enabled layers. */
export function widgetCatalog(layers: readonly LayerInfo[]): CatalogEntry[] {
  const builtin = BUILTIN_WIDGETS.map((id) => ({ id, title: WIDGET_TITLES[id].title, navbars: ["global", "agent"] as const }));
  const contributed = layers
    .filter((l) => l.enabled)
    .flatMap((l) => l.ui.widgets.map((w) => ({ id: w.id, title: w.title, navbars: w.navbars })));
  return [...builtin, ...contributed];
}

export function LayoutPanel() {
  const config = useFactory((s) => s.uiConfig);
  const layers = useFactory((s) => s.layers);
  const { toast } = useToast();
  const catalog = useMemo(() => widgetCatalog(layers), [layers]);
  const titleOf = (widget: string): string => catalog.find((c) => c.id === widget)?.title ?? widget;

  const [addBar, setAddBar] = useState<NavbarId>("agent");
  const [addWidget, setAddWidget] = useState<string>("context_bar");
  const [addSlot, setAddSlot] = useState<NavbarSlot>("left");
  const choices = catalog.filter((c) => c.navbars.includes(addBar));
  const widget = choices.some((c) => c.id === addWidget) ? addWidget : (choices[0]?.id ?? "");

  const fail = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });
  const patch = (body: Record<string, unknown>, title: string): void => {
    api.uiConfig
      .update(body as never)
      .then(acceptUiConfig)
      .catch(fail(title));
  };

  const row = (bar: NavbarId, p: WidgetPlacement, items: readonly WidgetPlacement[]) => {
    const sameSlot = items.filter((i) => i.slot === p.slot);
    const at = sameSlot.findIndex((i) => i.id === p.id);
    const swapWith = (other: WidgetPlacement | undefined): void => {
      if (!other) return;
      api.widgets.move({ id: p.id, index: items.findIndex((i) => i.id === other.id) }).catch(fail("The widget was not moved"));
    };
    return (
      <li key={p.id} className="tsf-set-widget" data-testid={`layout-widget-${p.id}`}>
        <div className="tsf-set-widget-name">
          <span>{titleOf(p.widget)}</span>
          <code>{p.id}</code>
        </div>
        <Field label="Slot" className="tsf-set-widget-slot">
          {(f) => (
            <Select
              {...f}
              value={p.slot}
              data-cap="widgets.move"
              data-testid={`layout-slot-${p.id}`}
              onChange={(e) =>
                api.widgets.move({ id: p.id, slot: e.target.value as NavbarSlot, index: items.length }).catch(fail("The widget was not moved"))
              }
            >
              {SLOTS.map((s) => (
                <option key={s} value={s}>
                  {s === "left" ? "Left" : s === "center" ? "Centre" : "Right"}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Toggle
          label="Full width"
          checked={p.options.fullWidth === true}
          data-cap="widgets.options"
          data-testid={`layout-full-${p.id}`}
          onChange={(v) => api.widgets.options(p.id, { fullWidth: v }).catch(fail("The option was not saved"))}
        />
        <div className="tsf-set-widget-actions">
          <IconButton
            size="sm"
            variant="ghost"
            label={`Move ${titleOf(p.widget)} earlier`}
            icon={ArrowUp}
            disabled={at <= 0}
            data-cap="widgets.move"
            onClick={() => swapWith(sameSlot[at - 1])}
          />
          <IconButton
            size="sm"
            variant="ghost"
            label={`Move ${titleOf(p.widget)} later`}
            icon={ArrowDown}
            disabled={at < 0 || at >= sameSlot.length - 1}
            data-cap="widgets.move"
            onClick={() => swapWith(sameSlot[at + 1])}
          />
          <IconButton
            size="sm"
            variant="ghost"
            label={`Remove ${titleOf(p.widget)} from the ${bar} navbar`}
            icon={Trash2}
            data-cap="widgets.remove"
            data-testid={`layout-remove-${p.id}`}
            onClick={() => api.widgets.remove(p.id).catch(fail("The widget was not removed"))}
          />
        </div>
      </li>
    );
  };

  return (
    <div className="tsf-set-panel" data-testid="panel-layout">
      <section className="tsf-set-group">
        <h3 className="tsf-set-h">Panes</h3>
        <Toggle
          label="Pages pane"
          checked={config.panes.left.visible}
          data-cap="layout.panes"
          data-testid="layout-pane-left"
          onChange={(v) => patch({ panes: { left: { visible: v } } }, "The layout was not saved")}
        />
        <Toggle
          label="Agent pane"
          checked={config.panes.right.visible || config.panes.agentMaximised}
          data-cap="layout.panes"
          data-testid="layout-pane-right"
          onChange={(v) => patch({ panes: { right: { visible: v }, ...(v ? {} : { agentMaximised: false }) } }, "The layout was not saved")}
        />
        <Toggle
          label="Agent over the page"
          checked={config.panes.agentMaximised}
          data-cap="layout.panes"
          data-testid="layout-pane-max"
          onChange={(v) => patch({ panes: { agentMaximised: v, ...(v ? { right: { visible: true } } : {}) } }, "The layout was not saved")}
        />
      </section>

      {NAVBARS.map(({ id, title }) => {
        const bar = config.navbars[id];
        return (
          <section key={id} className="tsf-set-group" data-cap="widgets.list" data-testid={`layout-navbar-${id}`}>
            <h3 className="tsf-set-h">{title}</h3>
            <Toggle
              label="Show this navbar"
              checked={bar.visible}
              data-cap="layout.panes"
              data-testid={`layout-navbar-visible-${id}`}
              onChange={(v) => patch({ navbars: { [id]: { visible: v } } }, "The navbar was not saved")}
            />
            {bar.items.length === 0 ? (
              <StatusLine tone="warning">No widgets in this navbar.</StatusLine>
            ) : (
              <ul className="tsf-set-widgets">{bar.items.map((p) => row(id, p, bar.items))}</ul>
            )}
          </section>
        );
      })}

      <section className="tsf-set-group" data-testid="layout-add">
        <h3 className="tsf-set-h">Add a widget</h3>
        <div className="tsf-set-add">
          <Field label="Navbar">
            {(f) => (
              <Select {...f} value={addBar} data-testid="layout-add-navbar" onChange={(e) => setAddBar(e.target.value as NavbarId)}>
                <option value="global">Global</option>
                <option value="agent">Agent</option>
              </Select>
            )}
          </Field>
          <Field label="Widget">
            {(f) => (
              <Select {...f} value={widget} data-testid="layout-add-widget" onChange={(e) => setAddWidget(e.target.value)}>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Slot">
            {(f) => (
              <Select {...f} value={addSlot} data-testid="layout-add-slot" onChange={(e) => setAddSlot(e.target.value as NavbarSlot)}>
                {SLOTS.map((s) => (
                  <option key={s} value={s}>
                    {s === "left" ? "Left" : s === "center" ? "Centre" : "Right"}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            variant="secondary"
            disabled={widget === ""}
            data-cap="widgets.add"
            data-testid="layout-add-submit"
            onClick={() => api.widgets.add({ navbar: addBar, widget, slot: addSlot }).catch(fail("The widget was not added"))}
          >
            Add widget
          </Button>
        </div>
      </section>
      <WidgetTypes />
    </div>
  );
}
