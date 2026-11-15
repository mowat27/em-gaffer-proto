/**
 * The built-in navbar widgets (DESIGN 11, spec 8.2): context_bar, agent_status, factory_name, cron_status. Each reads the
 * store and draws with pw-ui. A widget whose type is not built in is a layer contribution ("<layer>.<widget>") and is
 * drawn by the generic LayerControl. `WIDGET_TITLES` also feeds the Settings > Layout panel's widget picker.
 */
import type { ComponentType } from "react";
import { CircleCheck, Clock, Factory, Gauge } from "lucide-react";
import { AgentStatus, Badge, Button, type ActivityStatus } from "@pw/ui/react";
import { agentActivity, type AgentActivity, type AgentState } from "../../shared/agent-activity.ts";
import type { BuiltinWidget, NavbarId, WidgetPlacement } from "../../shared/types.ts";
import { api } from "../api/client.ts";
import { money, tokens } from "../lib/usage.ts";
import { LayerControl } from "../layers/LayerControl.tsx";
import { useFactory } from "../state/store.ts";

export interface WidgetProps {
  readonly placement: WidgetPlacement;
  readonly navbar: NavbarId;
}

export const WIDGET_TITLES: Record<BuiltinWidget, { title: string; description: string }> = {
  context_bar: { title: "Context bar", description: "How much of the model's context window the conversation uses, and what the conversation has cost." },
  agent_status: { title: "Agent status", description: "What the agent is doing: idle, waiting, thinking, writing, running tools, retrying or compacting." },
  factory_name: { title: "Factory name", description: "The name of this factory." },
  cron_status: { title: "Cron status", description: "Scheduled prompts; opens the cron panel." },
};

/** The agent's state from the live view (shared/agent-activity.ts); also read by the rail, the header's Stop and the tab. */
export function useAgentState(): AgentActivity {
  const live = useFactory((s) => s.chat?.live);
  return agentActivity(live);
}

function ContextBar({ placement }: WidgetProps) {
  const meta = useFactory((s) => s.chat?.meta);
  const used = meta?.contextTokens ?? 0;
  const window = meta?.contextWindow ?? 0;
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  const tone = pct >= 90 ? "error" : pct >= 70 ? "warning" : "ok";
  const cost = meta ? money(meta.usage.costUsd) : null;
  const background = window > 0 ? (meta?.compaction.background ?? null) : null;
  const forced = window > 0 && meta ? meta.compaction.forced : null;
  const summary = [
    window > 0 ? `${used.toLocaleString("en")} of ${window.toLocaleString("en")} tokens (${pct}%)` : `${used.toLocaleString("en")} tokens`,
    background !== null ? `background compaction at ${tokens(background)}` : null,
    forced !== null ? `forced at ${tokens(forced)}` : null,
    cost !== null ? `${cost} spent in this conversation` : null,
  ]
    .filter((x) => x !== null)
    .join(", ");
  return (
    <div className="tsf-context" data-tone={tone} data-full={placement.options.fullWidth === true ? "true" : "false"} title={summary}>
      <Gauge className="tsf-context-icon" aria-hidden="true" />
      <span className="tsf-context-label">Context</span>
      <div
        className="tsf-context-track"
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={window > 0 ? window : 1}
        aria-valuenow={Math.min(used, window > 0 ? window : used)}
        aria-valuetext={window > 0 ? `${tokens(used)} of ${tokens(window)} tokens, ${pct} percent` : "no context window known"}
      >
        <div className="tsf-context-fill" style={{ width: `${pct}%` }} />
        {background !== null && <div className="tsf-context-mark" data-kind="background" style={{ left: `${Math.min(100, (background / window) * 100)}%` }} />}
        {forced !== null && <div className="tsf-context-mark" data-kind="forced" style={{ left: `${Math.min(100, (forced / window) * 100)}%` }} />}
      </div>
      <span className="tsf-context-num">{window > 0 ? `${tokens(used)} / ${tokens(window)}` : tokens(used)}</span>
      {cost !== null && (
        <span className="tsf-context-cost" data-testid="context-cost" aria-label={`Conversation cost ${cost}`}>
          {cost}
        </span>
      )}
    </div>
  );
}

const STATUS: Record<AgentState, ActivityStatus> = { idle: "skipped", working: "running", retrying: "running", compacting: "running" };

function AgentStatusWidget({ navbar }: WidgetProps) {
  const { state, doing, short, detail } = useAgentState();
  const animations = useFactory((s) => s.uiConfig.animations);
  const reduced = animations.reducedMotion;
  const inner =
    state === "idle" ? (
      <Badge tone="neutral" icon={CircleCheck}>
        {short}
      </Badge>
    ) : (
      <AgentStatus status={STATUS[state]}>{short}</AgentStatus>
    );
  return (
    <span
      className="tsf-agent-state"
      // The agent navbar's status keeps the id the agent pane has always had; a second one elsewhere gets its own.
      data-testid={navbar === "agent" ? "chat-status" : "nav-status"}
      data-state={state}
      data-doing={doing ?? "none"}
      title={detail}
      data-working-anim={animations.agentWorking}
      data-idle-anim={animations.agentIdle}
      data-motion={reduced === "on" ? "reduce" : reduced === "off" ? "full" : "system"}
    >
      {inner}
    </span>
  );
}

function FactoryNameWidget() {
  const name = useFactory((s) => s.settings?.factoryName ?? s.status?.name ?? null);
  return (
    <span className="tsf-factory-name" data-testid="factory-name">
      <Factory aria-hidden="true" />
      <span>{name ?? "Factory"}</span>
    </span>
  );
}

function CronStatusWidget() {
  const cron = useFactory((s) => s.cron);
  const enabled = cron.filter((c) => c.enabled);
  const active = enabled.length;
  const next = enabled.reduce<number | null>((m, c) => (c.nextRunAt !== null && (m === null || c.nextRunAt < m) ? c.nextRunAt : m), null);
  const nextText = next === null ? "" : ` next ${new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={Clock}
      data-cap="ui.open"
      data-testid="open-cron"
      data-active={active}
      title={next === null ? "No scheduled prompts" : `Next run ${new Date(next).toLocaleString()}`}
      onClick={() => {
        api.ui.open("cron").catch(() => {
          // The panel simply does not open; there is nothing else to undo.
        });
      }}
    >
      Cron{active > 0 ? ` (${active})${nextText}` : ""}
    </Button>
  );
}

const BUILTIN: Record<BuiltinWidget, ComponentType<WidgetProps>> = {
  context_bar: ContextBar,
  agent_status: AgentStatusWidget,
  factory_name: FactoryNameWidget,
  cron_status: CronStatusWidget,
};

function isBuiltin(widget: string): widget is BuiltinWidget {
  return Object.prototype.hasOwnProperty.call(BUILTIN, widget);
}

/**
 * True when the placement belongs to a layer that is installed but switched off: the navbar leaves it out, and it comes
 * back when the layer is switched on. A placement whose layer is missing is still shown, as a warning.
 */
export function isSwitchedOff(widget: string, layers: readonly { name: string; enabled: boolean }[]): boolean {
  if (isBuiltin(widget)) return false;
  const layerName = widget.split(".")[0] ?? "";
  return layers.some((l) => l.name === layerName && !l.enabled);
}

/** A layer widget is one declarative control from its layer's manifest. */
function LayerWidget({ placement }: WidgetProps) {
  const layers = useFactory((s) => s.layers);
  const layerName = placement.widget.split(".")[0] ?? "";
  const layer = layers.find((l) => l.name === layerName && l.enabled);
  const contribution = layer?.ui.widgets.find((w) => w.id === placement.widget);
  if (!layer || !contribution) {
    return (
      <Badge tone="warning" title={`The widget ${placement.widget} is not available: its layer is not installed.`}>
        {placement.widget} unavailable
      </Badge>
    );
  }
  return <LayerControl layer={layer.name} control={contribution.control} inline />;
}

export function Widget(props: WidgetProps) {
  const Component = isBuiltin(props.placement.widget) ? BUILTIN[props.placement.widget] : LayerWidget;
  return <Component {...props} />;
}
