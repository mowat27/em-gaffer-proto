import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

// Sidebar widths the person has dragged to, per browser. Each is a CSS variable on the root element,
// so a drag restyles the layout without re-rendering the page under it.
export type Panel = 'aside' | 'chat';
const VARS: Record<Panel, string> = { aside: '--c4-aside-w', chat: '--c4-chat-w' };
const KEY = 'c4studio.panelWidths';

function readWidths(): Partial<Record<Panel, number>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    return v && typeof v === 'object' ? (v as Partial<Record<Panel, number>>) : {};
  } catch {
    return {};
  }
}

function saveWidth(panel: Panel, width: number | undefined): void {
  try {
    const all = readWidths();
    if (width === undefined) delete all[panel];
    else all[panel] = width;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

function setVar(panel: Panel, width: number | undefined): void {
  if (width === undefined) document.documentElement.style.removeProperty(VARS[panel]);
  else document.documentElement.style.setProperty(VARS[panel], `${width}px`);
}

/** Restore the saved widths; call once before the first render. */
export function applySavedWidths(): void {
  for (const [panel, width] of Object.entries(readWidths()) as [Panel, unknown][]) {
    if (panel in VARS && typeof width === 'number' && Number.isFinite(width)) setVar(panel, width);
  }
}

const STEP = 16;
const BIG_STEP = 64;

/**
 * A drag handle on a sidebar's inner edge (the window splitter pattern). Arrow keys resize by 16px,
 * with Shift by 64px; Home and End go to the narrowest and widest; a double click puts back the default.
 */
export function ResizeHandle({
  panel,
  label,
  grows,
  min,
  max,
  measure,
  className,
}: {
  panel: Panel;
  label: string;
  /** The direction a drag widens the panel: right for a sidebar on the left, left for one on the right */
  grows: 'left' | 'right';
  min: number;
  max: () => number;
  /** The panel's current width */
  measure: () => number;
  className?: string;
}) {
  const [now, setNow] = useState<number | undefined>(undefined);
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const sync = () => setNow(Math.round(measure()) || undefined);
  // Once on mount, and again on focus: a panel opened since has a width only once it shows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sync, []);

  const resize = (width: number): number => {
    const v = Math.round(Math.min(Math.max(width, min), Math.max(min, max())));
    setVar(panel, v);
    setNow(v);
    return v;
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove('c4-resizing');
    saveWidth(panel, d.last);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={now}
      aria-valuemin={min}
      aria-valuemax={Math.round(max())}
      tabIndex={0}
      title="Drag to resize. Double-click for the default width."
      className={className ? `c4-resize ${className}` : 'c4-resize'}
      onFocus={sync}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const width = measure();
        drag.current = { x: e.clientX, width, last: Math.round(width) };
        document.body.classList.add('c4-resizing');
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        d.last = resize(d.width + (grows === 'right' ? dx : -dx));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        setVar(panel, undefined);
        saveWidth(panel, undefined);
        requestAnimationFrame(sync);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        let width: number | undefined;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const step = e.shiftKey ? BIG_STEP : STEP;
          const wider = (e.key === 'ArrowRight') === (grows === 'right');
          width = measure() + (wider ? step : -step);
        } else if (e.key === 'Home') width = min;
        else if (e.key === 'End') width = max();
        if (width === undefined) return;
        e.preventDefault();
        saveWidth(panel, resize(width));
      }}
    />
  );
}
