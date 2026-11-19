import { memo, useState, type MouseEvent } from 'react';
import { EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps, type InternalNode } from '@xyflow/react';
import { cx } from '@pw/ui/react';
import { EyeOff } from 'lucide-react';
import { useCanvasCtx } from './context.ts';
import type { C4FlowEdge } from './types.ts';

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

function boxOf(n: InternalNode): Box {
  const w = n.measured.width ?? n.width ?? 0;
  const h = n.measured.height ?? n.height ?? 0;
  const p = n.internals.positionAbsolute;
  return { cx: p.x + w / 2, cy: p.y + h / 2, w, h };
}

/** Point where the line from the box centre towards (tx, ty) leaves the box. */
function exitPoint(b: Box, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - b.cx;
  const dy = ty - b.cy;
  if (dx === 0 && dy === 0) return { x: b.cx, y: b.cy };
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: b.cx + dx * s, y: b.cy + dy * s };
}

/** Defines the arrowheads once per canvas. Fill comes from CSS classes. */
export function ArrowDefs() {
  return (
    <svg className="c4-defs" width={0} height={0} aria-hidden="true" focusable="false">
      <defs>
        {(['', '-light', '-sel'] as const).map((v) => (
          <marker key={v} id={`c4-arrow${v}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={10} markerHeight={10} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path className={`c4-arrowhead${v}`} d="M0 0 L10 5 L0 10 Z" />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export const C4EdgeView = memo(function C4EdgeView({ source, target, data }: EdgeProps<C4FlowEdge>) {
  const sNode = useInternalNode(source);
  const tNode = useInternalNode(target);
  const { selectedRel, selectRel, toggleLabel } = useCanvasCtx();
  const { screenToFlowPosition, getZoom } = useReactFlow();
  // Flow-coordinate anchor of the tooltip while a collapsed edge (or its marker) is hovered.
  const [hover, setHover] = useState<{ x: number; y: number; zoom: number } | null>(null);
  if (!sNode || !tNode || !data) return null;

  const s = boxOf(sNode);
  const t = boxOf(tNode);
  const midX = (s.cx + t.cx) / 2;
  const midY = (s.cy + t.cy) / 2;
  const len = Math.hypot(t.cx - s.cx, t.cy - s.cy) || 1;
  const nx = -(t.cy - s.cy) / len;
  const ny = (t.cx - s.cx) / len;
  const cxp = midX + nx * data.offset * 2;
  const cyp = midY + ny * data.offset * 2;
  const curved = data.offset !== 0;
  const a = exitPoint(s, curved ? cxp : t.cx, curved ? cyp : t.cy);
  const b = exitPoint(t, curved ? cxp : s.cx, curved ? cyp : s.cy);
  const d = curved ? `M${a.x} ${a.y} Q${cxp} ${cyp} ${b.x} ${b.y}` : `M${a.x} ${a.y} L${b.x} ${b.y}`;
  const lx = curved ? 0.25 * a.x + 0.5 * cxp + 0.25 * b.x : (a.x + b.x) / 2;
  const ly = curved ? 0.25 * a.y + 0.5 * cyp + 0.25 * b.y : (a.y + b.y) / 2;

  const selected = selectedRel === data.relId;
  const marker = selected ? 'c4-arrow-sel' : data.implied ? 'c4-arrow-light' : 'c4-arrow';
  const [firstLine, ...rest] = data.label.split('\n');
  const at = `translate(-50%, -50%) translate(${lx}px, ${ly}px)`;

  const track = (e: MouseEvent) => setHover({ ...screenToFlowPosition({ x: e.clientX, y: e.clientY }), zoom: getZoom() });
  const hit = data.collapsed ? (
    <path className="c4-edge-hit" d={d} data-testid="c4-edge-hit" onMouseEnter={track} onMouseMove={track} onMouseLeave={() => setHover(null)} />
  ) : (
    <path className="c4-edge-hit" d={d} data-testid="c4-edge-hit" />
  );

  return (
    <>
      <path className={cx('c4-edge-line', data.async && 'is-async', data.implied && 'is-implied', selected && 'is-selected')} d={d} markerEnd={`url(#${marker})`} data-testid="c4-edge" />
      {hit}
      {data.collapsed && (hover || toggleLabel) && (
        <EdgeLabelRenderer>
          {toggleLabel && (
            // A small marker where the label would be: click shows this one label, hover shows the tooltip.
            <button
              type="button"
              className={cx('c4-edge-dot', 'nodrag', 'nopan', selected && 'is-selected')}
              style={{ transform: at }}
              aria-label={`Show label: ${firstLine || 'relationship'}`}
              data-testid="c4-edge-dot"
              onClick={() => toggleLabel(data.relId, false)}
              onMouseEnter={() => setHover({ x: lx, y: ly, zoom: getZoom() })}
              onMouseLeave={() => setHover(null)}
            />
          )}
          {hover && (
            <div className="pw-tooltip c4-edge-tip" role="tooltip" style={{ transform: `translate(${hover.x}px, ${hover.y}px) scale(${1 / hover.zoom}) translate(12px, 12px)` }}>
              <div>{firstLine || 'No description'}</div>
              {data.technology && <div className="c4-tip-tech">[{data.technology}]</div>}
              {data.implied && <div className="c4-tip-tech">Implied relationship</div>}
            </div>
          )}
        </EdgeLabelRenderer>
      )}
      {!data.collapsed && data.label && (
        <EdgeLabelRenderer>
          <div className={cx('c4-edge-label-wrap', selected && 'is-selected')} style={{ transform: at }}>
            <button
              type="button"
              className={cx('c4-edge-label', 'nodrag', 'nopan', data.implied && 'is-implied', selected && 'is-selected')}
              onClick={() => selectRel(data.relId)}
              data-testid="c4-edge-label"
            >
              <span>{firstLine}</span>
              {rest.map((line) => (
                <span key={line} className="c4-edge-tech">
                  {line}
                </span>
              ))}
            </button>
            {toggleLabel && (
              <button
                type="button"
                className="c4-edge-hide nodrag nopan"
                aria-label={`Collapse label: ${firstLine || 'relationship'}`}
                title="Collapse this label"
                onClick={() => toggleLabel(data.relId, true)}
              >
                <EyeOff aria-hidden="true" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
