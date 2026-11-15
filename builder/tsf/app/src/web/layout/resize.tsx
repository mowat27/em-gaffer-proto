/**
 * The sidebar resize handle (DESIGN 11, "Layout"): a port of C4 Studio's `resize.tsx` (the window splitter pattern).
 * A drag sets the pane's CSS variable on the workbench element (no re-render under it), snapped to 4 px; the width is
 * saved to the UI config (`panes.<side>.width`) through a 300 ms debounced `updateUiConfig` without `baseVersion`.
 * Arrow keys resize by 16 px, with Shift by 64 px; Home and End go to the narrowest and widest; a double click puts
 * back the default width.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DEFAULT_UI_CONFIG } from "../../shared/types.ts";
import { api } from "../api/client.ts";
import { acceptUiConfig, getFactoryState, useFactory } from "../state/store.ts";

export type PaneSide = "left" | "right";

/** The schema's pane range (shared/ui-config-schema.ts; not imported, so the web bundle carries no pi-schema). */
const PANE_MIN_WIDTH = 160;
const PANE_MAX_WIDTH = 960;
const STEP = 16;
const BIG_STEP = 64;
const SAVE_DELAY_MS = 300;

/** The CSS variable that holds each sidebar's width on `.tsf-workbench`. */
export const PANE_VARS: Record<PaneSide, string> = { left: "--tsf-left-w", right: "--tsf-right-w" };

const snap = (n: number): number => Math.round(n / 4) * 4;

/** Clamp to [min, max] and to the schema's range, then snap to the 4 px scale. */
export function clampWidth(width: number, min: number, max: number): number {
  const lo = Math.max(min, PANE_MIN_WIDTH);
  const hi = Math.max(lo, Math.min(max, PANE_MAX_WIDTH));
  const v = snap(Math.min(Math.max(width, lo), hi));
  return v > hi ? v - 4 : v < lo ? v + 4 : v;
}

const timers: Partial<Record<PaneSide, ReturnType<typeof setTimeout>>> = {};

/** Save a width after the drag or key presses settle; a failed save puts back the stored width. */
function saveLater(side: PaneSide, width: number, el: HTMLElement | null): void {
  const pending = timers[side];
  if (pending !== undefined) clearTimeout(pending);
  timers[side] = setTimeout(() => {
    delete timers[side];
    api.uiConfig
      .update({ panes: { [side]: { width } } })
      .then(acceptUiConfig)
      .catch(() => {
        const stored = getFactoryState().uiConfig.panes[side];
        if (el && stored.visible) el.style.setProperty(PANE_VARS[side], `${stored.width}px`);
      });
  }, SAVE_DELAY_MS);
}

export function ResizeHandle({ side, label, min, max }: { side: PaneSide; label: string; min: number; max: () => number }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  /** The width while a drag or key press is not yet saved; the stored width otherwise. */
  const [now, setNow] = useState<number | undefined>(undefined);
  const stored = useFactory((s) => s.uiConfig.panes[side].width);
  useEffect(() => setNow(undefined), [stored]);

  const workbench = (): HTMLElement | null => ref.current?.closest<HTMLElement>(".tsf-workbench") ?? null;
  const measure = (): number => {
    const pane = workbench()?.querySelector<HTMLElement>(`[data-testid="pane-${side}"]`);
    return pane ? pane.getBoundingClientRect().width : getFactoryState().uiConfig.panes[side].width;
  };

  const resize = (width: number): number => {
    const v = clampWidth(width, min, max());
    workbench()?.style.setProperty(PANE_VARS[side], `${v}px`);
    setNow(v);
    return v;
  };
  const end = (): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("tsf-resizing");
    if (d.last !== snap(d.width)) saveLater(side, d.last, workbench());
  };
  // A drag widens a left sidebar to the right and a right sidebar to the left.
  const wider = (dx: number): number => (side === "left" ? dx : -dx);

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={now ?? stored}
      aria-valuemin={min}
      aria-valuemax={Math.round(Math.min(max(), PANE_MAX_WIDTH))}
      tabIndex={0}
      title="Drag to resize. Double-click for the default width."
      className={`tsf-resize tsf-resize-${side}`}
      data-testid={`resize-${side}`}
      data-cap="layout.panes"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const width = measure();
        drag.current = { x: e.clientX, width, last: snap(width) };
        document.body.classList.add("tsf-resizing");
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        d.last = resize(d.width + wider(e.clientX - d.x));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        saveLater(side, resize(DEFAULT_UI_CONFIG.panes[side].width), workbench());
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        let width: number | undefined;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const step = e.shiftKey ? BIG_STEP : STEP;
          width = measure() + wider(e.key === "ArrowRight" ? step : -step);
        } else if (e.key === "Home") width = min;
        else if (e.key === "End") width = max();
        if (width === undefined) return;
        e.preventDefault();
        saveLater(side, resize(width), workbench());
      }}
    />
  );
}
