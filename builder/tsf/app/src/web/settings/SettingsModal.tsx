/**
 * The settings modal (spec 8.4, DESIGN 11). Sections: Essentials (theme, layout and widgets, hotkeys, animations),
 * Core 4 (context, model, prompts, tools) and Advanced (layers, providers, ceiling, runs). It opens on the `ui.open` event, which the Settings button, the hotkey and the agent's
 * `open_panel` tool all cause through `api.ui.open`, so every way of opening it takes one path. Layers add their own
 * settings panels to a section as declarative controls (LayerControl).
 */
import { useEffect, useState } from "react";
import { Dialog } from "@pw/ui/react";
import { LayerControl } from "../layers/LayerControl.tsx";
import { useFactory } from "../state/store.ts";
import { Advanced, ADVANCED_TABS } from "./Advanced.tsx";
import { AnimationsPanel } from "./AnimationsPanel.tsx";
import { Core4, CORE4_TABS } from "./Core4.tsx";
import { Tabs, type TabItem } from "./controls.tsx";
import { HotkeysPanel } from "./HotkeysPanel.tsx";
import { LayoutPanel } from "./LayoutPanel.tsx";
import { ThemeEditor } from "./ThemeEditor.tsx";

export type SettingsSection = "essentials" | "core4" | "advanced";

const SECTIONS: readonly (TabItem & { id: SettingsSection })[] = [
  { id: "essentials", label: "Essentials" },
  { id: "core4", label: "Core 4" },
  { id: "advanced", label: "Advanced" },
];

const ESSENTIALS: readonly TabItem[] = [
  { id: "theme", label: "Theme" },
  { id: "layout", label: "Layout and widgets" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "animations", label: "Animations" },
];

const TABS: Record<SettingsSection, readonly TabItem[]> = { essentials: ESSENTIALS, core4: CORE4_TABS, advanced: ADVANCED_TABS };

/**
 * "essentials.hotkeys" -> section essentials, tab hotkeys; "core4.tools", "advanced.runs" likewise. A bare tab name
 * ("tools", "hotkeys") finds its section; anything unknown opens the first tab of the first section.
 */
export function parseSection(section: string | undefined): { section: SettingsSection; tab: string } {
  const [a, b] = (section ?? "").split(".");
  const known = SECTIONS.find((s) => s.id === a);
  if (known) return { section: known.id, tab: TABS[known.id].find((t) => t.id === b)?.id ?? TABS[known.id][0]!.id };
  const bare = SECTIONS.find((s) => TABS[s.id].some((t) => t.id === a));
  if (bare) return { section: bare.id, tab: a! };
  return { section: "essentials", tab: "theme" };
}

function LayerPanels({ section }: { section: SettingsSection }) {
  const layers = useFactory((s) => s.layers);
  const panels = layers
    .filter((l) => l.enabled)
    .flatMap((l) => l.ui.settingsPanels.filter((p) => p.section === section).map((p) => ({ layer: l.name, panel: p })));
  return (
    <>
      {panels.map(({ layer, panel }) => (
        <section key={panel.id} className="tsf-set-group" data-testid={`layer-panel-${panel.id}`}>
          <h3 className="tsf-set-h">{panel.title}</h3>
          {panel.controls.map((c, i) => (
            <LayerControl key={`${c.kind}-${i}`} layer={layer} control={c} />
          ))}
        </section>
      ))}
    </>
  );
}

export function SettingsModal({ open, section, onClose }: { open: boolean; section?: string | undefined; onClose: () => void }) {
  const wanted = parseSection(section);
  const [current, setCurrent] = useState<SettingsSection>(wanted.section);
  // The tab last used in each section, so switching sections and back keeps the place.
  const [tabs, setTabs] = useState<Record<SettingsSection, string>>({ essentials: "theme", core4: "context", advanced: "layers", [wanted.section]: wanted.tab });
  const tab = tabs[current];
  const setTab = (id: string): void => setTabs((t) => ({ ...t, [current]: id }));
  // Opening again with another section (the agent's open_panel, a hotkey) moves to it.
  useEffect(() => {
    if (!open) return;
    setCurrent(wanted.section);
    setTabs((t) => ({ ...t, [wanted.section]: wanted.tab }));
  }, [open, wanted.section, wanted.tab]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Settings" size="lg" className="tsf-settings" closeButton>
      <div data-testid="settings-modal" data-section={current} data-cap="ui_config.get">
        <Tabs items={SECTIONS} value={current} onChange={(id) => setCurrent(id as SettingsSection)} label="Settings sections" testId="settings-sections" />
        <div className="tsf-set-body" role="tabpanel">
          {current === "essentials" && (
            <>
              <Tabs items={ESSENTIALS} value={tab} onChange={setTab} label="Essentials" className="tsf-tabs-sub" testId="settings-essentials" />
              {tab === "theme" && <ThemeEditor />}
              {tab === "layout" && <LayoutPanel />}
              {tab === "hotkeys" && <HotkeysPanel />}
              {tab === "animations" && <AnimationsPanel />}
            </>
          )}
          {current === "core4" && <Core4 tab={tab} onTab={setTab} />}
          {current === "advanced" && <Advanced tab={tab} onTab={setTab} />}
          <LayerPanels section={current} />
        </div>
      </div>
    </Dialog>
  );
}
