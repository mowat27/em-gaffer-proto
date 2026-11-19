import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react';
import type { View, ViewLayout } from '../../shared/types.ts';
import type { ModelIndex } from '../state/modelIndex.ts';
import { markRendered } from '../state/perf.ts';
import { useStoredState } from '../lib/storage.ts';
import { build, type Built } from './build.ts';
import { CanvasContext } from './context.ts';
import { ArrowDefs, C4EdgeView } from './edges.tsx';
import { C4GroupView, C4NodeView } from './nodes.tsx';
import { rectsToViewLayout } from './layout.ts';
import type { C4FlowEdge, C4FlowNode, Change } from './types.ts';

const nodeTypes = { c4node: C4NodeView, c4group: C4GroupView };
const edgeTypes = { c4edge: C4EdgeView };
const FIT = { padding: 0.15, maxZoom: 1.25 };
const DEBOUNCE_MS = 300;

export interface CanvasProps {
  idx: ModelIndex;
  view: View;
  viewLayout?: ViewLayout;
  /** Revision of the branch state these props come from; drives the render-time measurement. */
  revision: number;
  labelsCollapsed: boolean;
  /** Per-relationship label state overriding labelsCollapsed (true = collapsed) */
  labelOverrides?: Readonly<Record<string, boolean>>;
  onToggleLabel?: (relId: string, collapsed: boolean) => void;
  /** Open the view one level below an element (node button or double-click) */
  onDrill?: (viewKey: string, elementId: string) => void;
  readOnly?: boolean;
  /** Record the "render N ms" measurement from this canvas. */
  measure?: boolean;
  changes?: ReadonlyMap<string, Change>;
  selectedElement?: string;
  selectedRel?: string;
  onSelectElement?: (id: string | null) => void;
  onSelectRel?: (id: string) => void;
  /** Called (debounced) with the whole view layout after a drag. */
  onLayoutChange?: (layout: ViewLayout) => void;
  /** Increment to re-fit the viewport. */
  fitSignal?: number;
  /** Increment to re-run the auto layout; the result is delivered through onAutoLayout. */
  autoLayoutSignal?: number;
  onAutoLayout?: (layout: ViewLayout) => void;
  minimap?: boolean;
}

function CanvasInner(props: CanvasProps) {
  const {
    idx, view, viewLayout, revision, labelsCollapsed, labelOverrides, onToggleLabel, onDrill, readOnly = false, measure = false, changes, selectedElement, selectedRel,
    onSelectElement, onSelectRel, onLayoutChange, fitSignal, autoLayoutSignal, onAutoLayout, minimap = true,
  } = props;
  const [mapShown, setMapShown] = useStoredState('c4studio.minimap', true);
  const drill = !readOnly && !!onDrill;
  const rf = useReactFlow();
  const prev = useRef<Built | undefined>(undefined);

  const built = useMemo(() => {
    const b = build({ idx, view, viewLayout, collapsed: labelsCollapsed, labelOverrides, drill, changes }, prev.current);
    prev.current = b;
    return b;
    // revision is part of the documented memo key; idx changes with it.
  }, [revision, idx, view, viewLayout, labelsCollapsed, labelOverrides, drill, changes]);

  // Live positions while dragging; cleared once the persisted layout flows back in.
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({});
  useLayoutEffect(() => {
    setDrag((p) => (Object.keys(p).length ? {} : p));
  }, [built]);

  const nodes = useMemo<C4FlowNode[]>(
    () => (Object.keys(drag).length ? built.nodes.map((n) => (drag[n.id] ? ({ ...n, position: drag[n.id] } as C4FlowNode) : n)) : built.nodes),
    [built.nodes, drag],
  );
  const edges: C4FlowEdge[] = built.edges;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useLayoutEffect(() => {
    if (measure) markRendered(revision);
  }, [measure, revision, nodes, edges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moves = changes.filter((c): c is Extract<NodeChange, { type: 'position' }> => c.type === 'position' && !!c.position);
    if (moves.length === 0) return;
    setDrag((p) => {
      const next = { ...p };
      for (const m of moves) next[m.id] = m.position!;
      return next;
    });
  }, []);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layoutRef = useRef(viewLayout);
  layoutRef.current = viewLayout;
  const onDragStop = useCallback(() => {
    if (readOnly || !onLayoutChange) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const list = nodesRef.current;
      const abs = new Map<string, { x: number; y: number }>();
      const byId = new Map(list.map((n) => [n.id, n]));
      const resolve = (id: string): { x: number; y: number } => {
        const hit = abs.get(id);
        if (hit) return hit;
        const n = byId.get(id)!;
        const base = n.parentId && byId.has(n.parentId) ? resolve(n.parentId) : { x: 0, y: 0 };
        const p = { x: base.x + n.position.x, y: base.y + n.position.y };
        abs.set(id, p);
        return p;
      };
      const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
      for (const n of list) {
        const p = resolve(n.id);
        rects.set(n.id, { x: p.x, y: p.y, w: n.width ?? 0, h: n.height ?? 0 });
      }
      onLayoutChange(rectsToViewLayout(rects, layoutRef.current));
    }, DEBOUNCE_MS);
  }, [readOnly, onLayoutChange]);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (fitSignal) void rf.fitView({ ...FIT, duration: 200 });
  }, [fitSignal, rf]);

  const lastAuto = useRef(autoLayoutSignal ?? 0);
  useEffect(() => {
    if (!autoLayoutSignal || autoLayoutSignal === lastAuto.current) return;
    lastAuto.current = autoLayoutSignal;
    const fresh = build({ idx, view, viewLayout, collapsed: labelsCollapsed, changes, forceAuto: true });
    onAutoLayout?.(fresh.layout);
  }, [autoLayoutSignal, idx, view, viewLayout, labelsCollapsed, changes, onAutoLayout]);

  const ctx = useMemo(
    () => ({
      selectedElement,
      selectedRel,
      readOnly,
      selectRel: (id: string) => onSelectRel?.(id),
      drill: drill ? onDrill : undefined,
      toggleLabel: readOnly ? undefined : onToggleLabel,
    }),
    [selectedElement, selectedRel, readOnly, onSelectRel, drill, onDrill, onToggleLabel],
  );

  return (
    <CanvasContext.Provider value={ctx}>
      <div className="c4-canvas" data-testid="c4-canvas" data-readonly={readOnly || undefined}>
        <ArrowDefs />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onDragStop}
          onNodeClick={(_, n) => onSelectElement?.(n.id)}
          onEdgeClick={(_, e) => onSelectRel?.((e.data as { relId: string }).relId)}
          onNodeDoubleClick={(_, n) => {
            const target = (n.data as { drill?: { key: string } }).drill;
            if (drill && target) onDrill!(target.key, n.id);
          }}
          zoomOnDoubleClick={false}
          onPaneClick={() => onSelectElement?.(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={false}
          deleteKeyCode={null}
          selectNodesOnDrag={false}
          fitView
          fitViewOptions={FIT}
          minZoom={0.1}
          maxZoom={2}
          onlyRenderVisibleElements={nodes.length > 150}
        >
          <Background gap={24} />
          <Controls showInteractive={false}>
            {minimap && (
              <ControlButton onClick={() => setMapShown(!mapShown)} title={mapShown ? 'Hide the overview map' : 'Show the overview map'} aria-label={mapShown ? 'Hide the overview map' : 'Show the overview map'} aria-pressed={mapShown}>
                <MapIcon aria-hidden="true" />
              </ControlButton>
            )}
          </Controls>
          {minimap && mapShown && <MiniMap pannable zoomable ariaLabel="Diagram overview" />}
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
