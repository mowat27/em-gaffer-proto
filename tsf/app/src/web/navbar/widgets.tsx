/**
 * The built-in navbar widgets (DESIGN 11, spec 8.2): context_bar, agent_status, factory_name, cron_status. Each reads the
 * store and draws with pw-ui. A widget whose type is not built in is a layer contribution ("<layer>.<widget>") and is
 * drawn by the generic LayerControl. `WIDGET_TITLES` also feeds the Settings > Layout panel's widget picker.
 */
import type { ComponentType } from "react";
import { CircleCheck, Clock, Factory, Gauge } from "lucide-react";
import { AgentStatus, Badge, Button, type ActivityStatus } from "@pw/ui/react";
import type { BuiltinWidget, NavbarId, WidgetPlacement } from "../../shared/types.ts";
import { api } from "../api/client.ts";
import { LayerControl } from "../layers/LayerControl.tsx";
import { useFactory } from "../state/store.ts";

export interface WidgetProps {
  readonly placement: WidgetPlacement;
  readonly navbar: NavbarId;
}

export const WIDGET_TITLES: Record<BuiltinWidget, { title: string; description: string }> = {
  context_bar: { title: "Context bar", description: "How much of the model's context window the conversation uses." },
  agent_status: { title: "Agent status", description: "Whether the agent is idle or working." },
  factory_name: { title: "Factory name", description: "The name of this factory." },
  cron_status: { title: "Cron status", description: "Scheduled prompts; opens the cron panel." },
};

/** Compact token counts: 1 234 -> "1.2k", 200 000 -> "200k". */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

type AgentState = "idle" | "working" | "retrying" | "compacting";
const STATE_LABEL: Record<AgentState, string> = { idle: "Idle", working: "Working", retrying: "Retrying", compacting: "Compacting" };

/** The agent's state from the live view; also used by the collapsed rail and the header's Stop. */
export function useAgentState(): { state: AgentState; busy: boolean; canStop: boolean } {
  const live = useFactory((s) => s.chat?.live);
  if (!live) return { state: "idle", busy: false, canStop: false };
  const state: AgentState = !live.busy ? "idle" : live.phase === "retrying" ? "retrying" : live.phase === "compacting" ? "compacting" : "working";
  return { state, busy: live.busy, canStop: live.busy || live.inbox.length > 0 };
}

function ContextBar({ placement }: WidgetProps) {
  const meta = useFactory((s) => s.chat?.meta);
  const used = meta?.contextTokens ?? 0;
  const window = meta?.contextWindow ?? 0;
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  const tone = pct >= 90 ? "error" : pct >= 70 ? "warning" : "ok";
  return (
    <div className="tsf-context" data-tone={tone} data-full={placement.options.fullWidth === true ? "true" : "false"}>
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
        {window > 0 && meta?.compaction.background != null && <div className="tsf-context-mark" data-kind="background" style={{ left: `${Math.min(100, (meta.compaction.background / window) * 100)}%` }} />}
        {window > 0 && meta && <div className="tsf-context-mark" data-kind="forced" style={{ left: `${Math.min(100, (meta.compaction.forced / window) * 100)}%` }} />}
      </div>
      <span className="tsf-context-num">{window > 0 ? `${tokens(used)} / ${tokens(window)}` : tokens(used)}</span>
    </div>
  );
}

const STATUS: Record<AgentState, ActivityStatus> = { idle: "skipped", working: "running", retrying: "running", compacting: "running" };

function AgentStatusWidget({ navbar }: WidgetProps) {
  const { state } = useAgentState();
  const animations = useFactory((s) => s.uiConfig.animations);
  const reduced = animations.reducedMotion;
  const inner =
    state === "idle" ? (
      <Badge tone="neutral" icon={CircleCheck}>
        {STATE_LABEL.idle}
      </Badge>
    ) : (
      <AgentStatus status={STATUS[state]}>{STATE_LABEL[state]}</AgentStatus>
    );
  return (
    <span
      className="tsf-agent-state"
      // The agent navbar's status keeps the id the agent pane has always had; a second one elsewhere gets its own.
      data-testid={navbar === "agent" ? "chat-status" : "nav-status"}
      data-state={state}
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

/** A layer widget is one declarative control from its layer's manifest. */
function LayerWidget({ placement }: WidgetProps) {
  const layers = useFactory((s) => s.layers);
  const layerName = placement.widget.split(".")[0] ?? "";
  const layer = layers.find((l) => l.name === layerName && l.enabled);
  const contribution = layer?.ui.widgets.find((w) => w.id === placement.widget);
  if (!layer || !contribution) {
    return (
      <Badge tone="warning" title={`The widget ${placement.widget} is not available: its layer is off or missing.`}>
        {placement.widget} unavailable
      </Badge>
    );
  }
  return <LayerControl layer={layer.name} control={contribution.control} />;
}

export function Widget(props: WidgetProps) {
  const Component = isBuiltin(props.placement.widget) ? BUILTIN[props.placement.widget] : LayerWidget;
  return <Component {...props} />;
}
