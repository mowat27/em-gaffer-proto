/** Settings > Core 4 (spec 8.5): Context, Model, Prompts, Tools, one sub-tab each. */
import { Tabs, type TabItem } from "./controls.tsx";
import { ContextPanel } from "./ContextPanel.tsx";
import { ModelPanel } from "./ModelPanel.tsx";
import { PromptsPanel } from "./PromptsPanel.tsx";
import { ToolsPanel } from "./ToolsPanel.tsx";

export const CORE4_TABS: readonly TabItem[] = [
  { id: "context", label: "Context" },
  { id: "model", label: "Model" },
  { id: "prompts", label: "Prompts" },
  { id: "tools", label: "Tools" },
];

export function Core4({ tab, onTab }: { tab: string; onTab: (id: string) => void }) {
  return (
    <>
      <Tabs items={CORE4_TABS} value={tab} onChange={onTab} label="Core 4" className="tsf-tabs-sub" testId="settings-core4" />
      {tab === "context" && <ContextPanel />}
      {tab === "model" && <ModelPanel />}
      {tab === "prompts" && <PromptsPanel />}
      {tab === "tools" && <ToolsPanel />}
    </>
  );
}
