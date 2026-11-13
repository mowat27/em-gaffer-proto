/**
 * The three-pane workbench (DESIGN 11, "Layout"). pw-ui has no splitter or three-pane shell, so this is an own
 * full-viewport grid: `var(--tsf-left-w) auto minmax(0, 1fr) auto var(--tsf-right-w)` (left pane, left handle, centre,
 * right handle, right pane). Pane sizes, collapse state and the agent maximise live in the UI config document and
 * change only through `updateUiConfig` (no `baseVersion`: the last writer wins). Every pane control carries
 * `data-cap="layout.panes"`.
 *
 * - Collapse: a sidebar hides and leaves a 32 px rail with one button that shows it again.
 * - Maximise: the agent pane spans the centre and right columns; the centre stays mounted, `hidden` and `inert`.
 */
import type { CSSProperties, ReactNode } from "react";
import { Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton, useToast } from "@pw/ui/react";
import type { UiConfigPatch } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useAgentState } from "../navbar/widgets.tsx";
import { acceptUiConfig, useFactory } from "../state/store.ts";
import { PANE_VARS, ResizeHandle } from "./resize.tsx";

/** The narrowest the centre pane gets when a sidebar is dragged wider. */
const CENTER_MIN = 320;
const SIDEBAR_MIN = 160;
/** Room the handles and rails take besides the panes. */
const CHROME = 16;

export function Workbench({
  left,
  center,
  right,
  rightHeader,
}: {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  rightHeader?: ReactNode;
}) {
  const panes = useFactory((s) => s.uiConfig.panes);
  const { toast } = useToast();
  const agent = useAgentState();

  const save = (patch: UiConfigPatch): void => {
    api.uiConfig
      .update(patch)
      .then(acceptUiConfig)
      .catch((err: unknown) => toast({ tone: "error", title: "The layout was not saved", description: errorMessage(err) }));
  };

  const leftVisible = panes.left.visible;
  const rightVisible = panes.right.visible || panes.agentMaximised;
  const maximised = panes.agentMaximised;

  const style = {
    [PANE_VARS.left]: leftVisible ? `${panes.left.width}px` : "var(--tsf-rail-w)",
    [PANE_VARS.right]: rightVisible ? `${panes.right.width}px` : "var(--tsf-rail-w)",
  } as CSSProperties;

  const widthOf = (side: "left" | "right"): number => {
    const el = document.querySelector<HTMLElement>(`.tsf-workbench [data-testid="pane-${side}"]`);
    if (el && !el.hidden) return el.getBoundingClientRect().width;
    return side === "left" ? (leftVisible ? panes.left.width : 32) : rightVisible ? panes.right.width : 32;
  };
  const maxFor = (side: "left" | "right") => (): number =>
    window.innerWidth - widthOf(side === "left" ? "right" : "left") - CENTER_MIN - CHROME;

  return (
    <div
      className={`tsf-workbench${maximised ? " tsf-workbench-max" : ""}`}
      data-testid="workbench"
      data-left={leftVisible ? "open" : "closed"}
      data-right={rightVisible ? "open" : "closed"}
      data-maximised={maximised ? "true" : "false"}
      style={style}
    >
      {/* Left: pages */}
      <section className="tsf-pane tsf-pane-left" data-testid="pane-left" aria-label="Pages" hidden={!leftVisible}>
        <div className="tsf-pane-head">
          <h2 className="tsf-pane-title">Pages</h2>
          {/* PageTree portals its new-page and new-folder buttons here. */}
          <span className="tsf-pane-tools" id="tsf-left-tools" />
          <IconButton
            label="Hide pages"
            icon={PanelLeftClose}
            size="sm"
            data-testid="collapse-left"
            data-cap="layout.panes"
            onClick={() => save({ panes: { left: { visible: false } } })}
          />
        </div>
        <div className="tsf-pane-body">{left}</div>
      </section>
      {!leftVisible && (
        <div className="tsf-rail tsf-rail-left" data-testid="rail-left">
          <IconButton
            label="Show pages"
            icon={PanelLeftOpen}
            size="sm"
            data-cap="layout.panes"
            onClick={() => save({ panes: { left: { visible: true } } })}
          />
        </div>
      )}
      {leftVisible ? <ResizeHandle side="left" label="Resize pages" min={SIDEBAR_MIN} max={maxFor("left")} /> : <span className="tsf-gap-left" />}

      {/* Centre: the focused page. Kept mounted while the agent is maximised. */}
      <main className="tsf-pane tsf-pane-center" data-testid="pane-center" id="main" hidden={maximised} inert={maximised}>
        {center}
      </main>

      {/* Right: the agent */}
      {rightVisible && !maximised ? (
        <ResizeHandle side="right" label="Resize agent" min={SIDEBAR_MIN} max={maxFor("right")} />
      ) : (
        <span className="tsf-gap-right" />
      )}
      <section className="tsf-pane tsf-pane-right" data-testid="pane-right" aria-label="Agent" hidden={!rightVisible}>
        <div className="tsf-pane-head">
          <div className="tsf-pane-head-main">{rightHeader}</div>
          <IconButton
            label={maximised ? "Back to the page" : "Expand agent over the page"}
            icon={maximised ? Minimize2 : Maximize2}
            size="sm"
            aria-pressed={maximised}
            data-testid="toggle-agent-max"
            data-cap="layout.panes"
            onClick={() =>
              save(maximised ? { panes: { agentMaximised: false } } : { panes: { agentMaximised: true, right: { visible: true } } })
            }
          />
          <IconButton
            label="Hide agent"
            icon={PanelRightClose}
            size="sm"
            data-testid="collapse-right"
            data-cap="layout.panes"
            onClick={() => save({ panes: { agentMaximised: false, right: { visible: false } } })}
          />
        </div>
        <div className="tsf-pane-body">{right}</div>
      </section>
      {!rightVisible && (
        <div className="tsf-rail tsf-rail-right" data-testid="rail-right">
          <IconButton
            label="Show agent"
            icon={PanelRightOpen}
            size="sm"
            data-cap="layout.panes"
            onClick={() => save({ panes: { right: { visible: true } } })}
          />
          <span
            className="tsf-rail-state"
            data-testid="rail-agent-state"
            data-state={agent.state}
            role="status"
            aria-label={agent.busy ? "Agent working" : "Agent idle"}
            title={agent.busy ? "Agent working" : "Agent idle"}
          />
        </div>
      )}
    </div>
  );
}
