import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ArrowDownToLine } from 'lucide-react';
import { cx } from '@pw/ui/react';
import { useCanvasCtx } from './context.ts';
import type { Shape } from './shapes.ts';
import type { C4FlowNode, C4GroupData, C4NodeData, Change } from './types.ts';

type NodeOf<T extends C4FlowNode['type']> = Extract<C4FlowNode, { type: T }>;

const CHANGE_LABEL: Record<Change, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };

/** Vector outline for each C4 shape. Fill and stroke come from CSS (tokens); strokes are non-scaling. */
function ShapeSvg({ shape, w, h }: { shape: Shape; w: number; h: number }) {
  const r = w / 2 - 1;
  let body: React.ReactNode;
  switch (shape) {
    case 'person':
      body = (
        <>
          <rect className="c4-fill" x={1} y={32} width={w - 2} height={h - 33} rx={20} />
          <circle className="c4-fill" cx={w / 2} cy={18} r={16} />
        </>
      );
      break;
    case 'database':
      body = (
        <>
          <path className="c4-fill" d={`M1 14 A${r} 14 0 0 1 ${w - 1} 14 V${h - 14} A${r} 14 0 0 1 1 ${h - 14} Z`} />
          <path className="c4-detail" d={`M1 14 A${r} 14 0 0 0 ${w - 1} 14`} />
        </>
      );
      break;
    case 'queue': {
      const ry = h / 2 - 1;
      body = (
        <>
          <path className="c4-fill" d={`M14 1 H${w - 14} A14 ${ry} 0 0 1 ${w - 14} ${h - 1} H14 A14 ${ry} 0 0 1 14 1 Z`} />
          <path className="c4-detail" d={`M14 1 A14 ${ry} 0 0 0 14 ${h - 1}`} />
        </>
      );
      break;
    }
    case 'browser':
      body = (
        <>
          <rect className="c4-fill" x={1} y={1} width={w - 2} height={h - 2} rx={6} />
          <path className="c4-detail" d={`M1 28 H${w - 1}`} />
          <circle className="c4-detail" cx={14} cy={14} r={4} />
          <circle className="c4-detail" cx={28} cy={14} r={4} />
          <circle className="c4-detail" cx={42} cy={14} r={4} />
        </>
      );
      break;
    case 'mobile':
      body = (
        <>
          <rect className="c4-fill" x={1} y={1} width={w - 2} height={h - 2} rx={20} />
          <path className="c4-detail" d={`M${w / 2 - 16} 14 H${w / 2 + 16}`} />
        </>
      );
      break;
    case 'desktop':
      body = (
        <>
          <rect className="c4-fill" x={1} y={1} width={w - 2} height={h - 2} rx={6} />
          <path className="c4-detail" d={`M1 24 H${w - 1}`} />
          <circle className="c4-detail" cx={14} cy={12} r={3} />
        </>
      );
      break;
    case 'folder': {
      const t = Math.round(w * 0.4);
      body = (
        <path
          className="c4-fill"
          d={`M1 16 Q1 6 11 6 H${t} L${t + 12} 18 H${w - 11} Q${w - 1} 18 ${w - 1} 28 V${h - 11} Q${w - 1} ${h - 1} ${w - 11} ${h - 1} H11 Q1 ${h - 1} 1 ${h - 11} Z`}
        />
      );
      break;
    }
    case 'bucket':
      body = (
        <>
          <path className="c4-fill" d={`M1 12 A${r} 12 0 0 1 ${w - 1} 12 L${w - 17} ${h - 12} A${w / 2 - 17} 12 0 0 1 17 ${h - 12} Z`} />
          <path className="c4-detail" d={`M1 12 A${r} 12 0 0 0 ${w - 1} 12`} />
        </>
      );
      break;
    case 'infra':
      body = <rect className="c4-fill c4-fill-infra" x={1} y={1} width={w - 2} height={h - 2} rx={6} />;
      break;
    default:
      body = <rect className="c4-fill" x={1} y={1} width={w - 2} height={h - 2} rx={8} />;
  }
  return (
    <svg className="c4-shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {body}
    </svg>
  );
}

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} className="c4-handle" isConnectable={false} />
      <Handle type="source" position={Position.Top} className="c4-handle" isConnectable={false} />
    </>
  );
}

function ChangeTag({ change }: { change?: Change }) {
  if (!change) return null;
  return <span className={cx('c4-change', `c4-change--${change}`)}>{CHANGE_LABEL[change]}</span>;
}

export const C4NodeView = memo(function C4NodeView({ data }: NodeProps<NodeOf<'c4node'>>) {
  const d: C4NodeData = data;
  const { selectedElement, drill } = useCanvasCtx();
  const marks = [d.external ? 'External' : '', d.assumed ? 'Assumed' : ''].filter(Boolean).join(' · ');
  const canDrill = !!(d.drill && drill);
  return (
    <div
      className={cx(
        'c4-node',
        `c4-node--${d.level}`,
        `c4-shape-${d.shape}`,
        d.external && 'is-external',
        d.assumed && 'is-assumed',
        selectedElement === d.id && 'is-selected',
        d.change && `is-${d.change}`,
        canDrill && 'has-drill',
      )}
      style={{ width: d.w, height: d.h }}
      data-testid="c4-node"
      data-element-id={d.id}
      title={d.description || d.name}
    >
      <ShapeSvg shape={d.shape} w={d.w} h={d.h} />
      <div className="c4-text">
        <div className="c4-name">{d.name}</div>
        <div className="c4-type">
          {d.typeLine}
          {marks && <span className="c4-marks"> · {marks}</span>}
        </div>
        {d.description && <div className="c4-desc">{d.description}</div>}
      </div>
      <ChangeTag change={d.change} />
      {canDrill && (
        <button
          type="button"
          className="c4-drill nodrag nopan"
          aria-label={`Drill down to ${d.drill!.label}`}
          title={`Drill down to ${d.drill!.label} (or double-click)`}
          data-testid="c4-drill"
          onClick={(e) => {
            e.stopPropagation();
            drill!(d.drill!.key, d.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ArrowDownToLine aria-hidden="true" />
        </button>
      )}
      <Handles />
    </div>
  );
});

export const C4GroupView = memo(function C4GroupView({ data }: NodeProps<NodeOf<'c4group'>>) {
  const d: C4GroupData = data;
  const { selectedElement } = useCanvasCtx();
  return (
    <div
      className={cx(
        'c4-group',
        d.boundary ? 'c4-group--boundary' : 'c4-group--deployment',
        d.assumed && 'is-assumed',
        selectedElement === d.id && 'is-selected',
        d.change && `is-${d.change}`,
      )}
      style={{ width: d.w, height: d.h }}
      data-testid="c4-group"
      data-element-id={d.id}
    >
      <div className="c4-group-label">
        <span className="c4-group-name">{d.name}</span>
        <span className="c4-group-type">{d.typeLine}</span>
      </div>
      {d.instances && <span className="c4-group-count">x{d.instances}</span>}
      <ChangeTag change={d.change} />
      <Handles />
    </div>
  );
});
