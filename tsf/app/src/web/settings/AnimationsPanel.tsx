/**
 * Settings > Essentials > Animations (spec 8.2): how the agent shows that it is working or idle, and whether motion is
 * reduced. Each choice applies at once through the UI config (`ui_config.update`).
 */
import { Field, Select, useToast } from "@pw/ui/react";
import type { UiConfig } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { acceptUiConfig, useFactory } from "../state/store.ts";

type Animations = UiConfig["animations"];

const WORKING: readonly { value: Animations["agentWorking"]; label: string }[] = [
  { value: "glow", label: "Glow" },
  { value: "pulse", label: "Pulse" },
  { value: "spinner", label: "Spinner" },
  { value: "none", label: "None" },
];
const IDLE: readonly { value: Animations["agentIdle"]; label: string }[] = [
  { value: "still", label: "Still" },
  { value: "breathe", label: "Breathe" },
];
const MOTION: readonly { value: Animations["reducedMotion"]; label: string }[] = [
  { value: "system", label: "Follow the system setting" },
  { value: "on", label: "Always reduce motion" },
  { value: "off", label: "Never reduce motion" },
];

export function AnimationsPanel() {
  const animations = useFactory((s) => s.uiConfig.animations);
  const { toast } = useToast();
  const set = (patch: Partial<Animations>): void => {
    api.uiConfig
      .update({ animations: patch })
      .then(acceptUiConfig)
      .catch((err: unknown) => toast({ tone: "error", title: "The animation was not saved", description: errorMessage(err) }));
  };
  return (
    <div className="tsf-set-panel" data-testid="panel-animations">
      <div className="tsf-set-grid">
        <Field label="Agent working" help="Shown on the agent status while a turn runs.">
          {(f) => (
            <Select {...f} value={animations.agentWorking} data-cap="layout.panes" data-testid="anim-working" onChange={(e) => set({ agentWorking: e.target.value as Animations["agentWorking"] })}>
              {WORKING.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Agent idle" help="Shown on the agent status between turns.">
          {(f) => (
            <Select {...f} value={animations.agentIdle} data-cap="layout.panes" data-testid="anim-idle" onChange={(e) => set({ agentIdle: e.target.value as Animations["agentIdle"] })}>
              {IDLE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reduced motion" help="Reduced motion turns the agent animations off.">
          {(f) => (
            <Select {...f} value={animations.reducedMotion} data-cap="layout.panes" data-testid="anim-motion" onChange={(e) => set({ reducedMotion: e.target.value as Animations["reducedMotion"] })}>
              {MOTION.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </div>
  );
}
