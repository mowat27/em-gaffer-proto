/**
 * Settings > Core 4 > Tools (spec 8.5): a matrix of every tool inside the ceiling, grouped by layer, each with an on/off
 * toggle, and a quick view with the tool's description and full parameters in JSON Schema or as a TypeScript signature.
 * Tools outside the ceiling are never listed (they are not registered). The list is the snapshot's `tools`, kept current
 * by `tools.changed`, so a toggle by the agent shows here at once.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Badge, IconButton, Switch, useToast } from "@pw/ui/react";
import type { ToolInfo } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useFactory } from "../state/store.ts";
import { Tabs } from "./controls.tsx";
import { readDescribe } from "./p5-types.ts";

type Syntax = "json" | "typescript";
const SYNTAXES = [
  { id: "json", label: "JSON Schema" },
  { id: "typescript", label: "TypeScript" },
] as const;

function QuickView({ tool }: { tool: ToolInfo }) {
  const [syntax, setSyntax] = useState<Syntax>("json");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parameters = JSON.stringify(tool.parameters, null, 2);
  useEffect(() => {
    let live = true;
    setCode(null);
    setError(null);
    api.tools.describe(tool.name, syntax).then(
      (r) => live && setCode(readDescribe(r)),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [tool.name, syntax]);
  // The JSON Schema is also in the snapshot, so it still shows when the describe route is unavailable.
  const shown = code ?? (syntax === "json" && error !== null ? parameters : null);
  return (
    <aside className="tsf-quick" data-cap="tools.describe" data-testid="tool-quickview" data-tool={tool.name} data-syntax={syntax}>
      <div className="tsf-quick-head">
        <h4 className="tsf-set-h">
          <code>{tool.name}</code>
        </h4>
        <Badge tone="neutral">{tool.layer}</Badge>
      </div>
      <p className="tsf-set-note" data-testid="tool-description">
        {tool.description}
      </p>
      <Tabs items={SYNTAXES} value={syntax} onChange={(id) => setSyntax(id as Syntax)} label="Parameter syntax" className="tsf-tabs-sub" testId="tool-syntax" />
      {shown === null && error === null && <p className="tsf-set-note">Loading</p>}
      {error !== null && syntax !== "json" && <p className="tsf-set-note" role="alert">{error}</p>}
      {shown !== null && (
        <pre className="tsf-code" data-testid="tool-code">
          {shown}
        </pre>
      )}
    </aside>
  );
}

export function ToolsPanel() {
  const tools = useFactory((s) => s.tools);
  const layers = useFactory((s) => s.layers);
  const [viewing, setViewing] = useState<string | null>(null);
  const { toast } = useToast();

  const groups = useMemo(() => {
    const order = new Map(layers.map((l) => [l.name, l.order]));
    const names = [...new Set(tools.map((t) => t.layer))].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    return names.map((layer) => ({ layer, enabled: layers.find((l) => l.name === layer)?.enabled ?? true, tools: tools.filter((t) => t.layer === layer) }));
  }, [tools, layers]);
  const viewed = tools.find((t) => t.name === viewing) ?? null;

  const toggle = (t: ToolInfo, v: boolean): void => {
    api.tools.setEnabled(t.name, v).catch((e: unknown) => toast({ tone: "error", title: `${t.name} was not switched`, description: errorMessage(e) }));
  };

  return (
    <div className="tsf-tools" data-testid="panel-tools">
      <div className="tsf-set-group" data-cap="tools.list" data-testid="tool-matrix">
        <p className="tsf-set-note">
          Every tool the permissions ceiling allows, by layer. A tool switched off is not offered to the agent on its next request.
        </p>
        {groups.length === 0 && <p className="tsf-set-note">No tools are inside the ceiling.</p>}
        {groups.map((g) => (
          <section key={g.layer} className="tsf-tool-group" data-testid={`tool-group-${g.layer}`}>
            <h4 className="tsf-set-h2">
              {g.layer} {!g.enabled && <Badge tone="warning">Layer off</Badge>}
            </h4>
            <ul className="tsf-tool-list">
              {g.tools.map((t) => (
                <li key={t.name} className="tsf-tool" data-testid={`tool-${t.name}`} data-enabled={t.enabled ? "true" : "false"} data-offered={t.offered ? "true" : "false"} data-viewing={viewing === t.name ? "true" : "false"}>
                  <ToolSwitch tool={t} onChange={(v) => toggle(t, v)} />
                  <span className="tsf-tool-desc">{t.description}</span>
                  <IconButton label={`Quick view of ${t.name}`} icon={Info} data-cap="tools.describe" data-testid={`tool-view-${t.name}`} onClick={() => setViewing(viewing === t.name ? null : t.name)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {viewed && <QuickView tool={viewed} />}
    </div>
  );
}

/** A matrix row's switch: the tool's name is its label, so the row reads "read, On". */
function ToolSwitch({ tool, onChange }: { tool: ToolInfo; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="pw-switch-row tsf-tool-switch">
      <Switch id={id} checked={tool.enabled} onCheckedChange={onChange} aria-labelledby={`${id}-label`} data-cap="tools.set_enabled" data-testid={`tool-toggle-${tool.name}`} />
      <code className="pw-switch-label" id={`${id}-label`}>
        {tool.name}
      </code>
      <span className="pw-switch-state">{tool.enabled ? (tool.offered ? "On" : "On, not offered") : "Off"}</span>
    </div>
  );
}
