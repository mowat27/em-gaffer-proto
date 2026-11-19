import type { Position, View, ViewLayout } from '../../shared/types.ts';
import { drillDownView, drillLabel, isAsync, type ModelIndex } from '../state/modelIndex.ts';
import { layoutRects, rectsToViewLayout, type Rect } from './layout.ts';
import { planView } from './plan.ts';
import { isAssumed, isExternal, levelOf, shapeOf, typeLine } from './shapes.ts';
import type { C4EdgeData, C4FlowEdge, C4FlowNode, C4GroupData, C4NodeData, Change } from './types.ts';

export interface BuildInput {
  idx: ModelIndex;
  view: View;
  viewLayout?: ViewLayout;
  collapsed: boolean;
  /** Per-relationship label state that overrides `collapsed` (true = collapsed). */
  labelOverrides?: Readonly<Record<string, boolean>>;
  /** Compute drill-down targets for nodes. */
  drill?: boolean;
  changes?: ReadonlyMap<string, Change>;
  forceAuto?: boolean;
}

export interface Built {
  nodes: C4FlowNode[];
  edges: C4FlowEdge[];
  /** Absolute positions of every node, ready to persist. */
  layout: ViewLayout;
}

export function build(input: BuildInput, prev?: Built): Built {
  const { idx, view, viewLayout, collapsed, labelOverrides, drill, changes, forceAuto } = input;
  const plan = planView(idx, view);
  const rects = layoutRects(idx, plan, viewLayout?.elements, forceAuto);

  const prevNodes = new Map(prev?.nodes.map((n) => [n.id, n]));
  const prevEdges = new Map(prev?.edges.map((e) => [e.id, e]));

  const nodes: C4FlowNode[] = [];
  for (const pn of plan.order) {
    const r = rects.get(pn.id)!;
    const parentRect: Rect | undefined = pn.parent ? rects.get(pn.parent) : undefined;
    const position: Position = { x: Math.round(r.x - (parentRect?.x ?? 0)), y: Math.round(r.y - (parentRect?.y ?? 0)) };
    const change = changes?.get(pn.id);
    const el = pn.el;
    let node: C4FlowNode;
    if (pn.isGroup) {
      const data: Omit<C4GroupData, 'sig'> = {
        id: el.id,
        name: el.name,
        typeLine: typeLine(idx, el),
        boundary: pn.boundary || el.kind === 'softwareSystem' || el.kind === 'container',
        instances: el.instances,
        assumed: isAssumed(idx, el),
        change,
        w: Math.round(r.w),
        h: Math.round(r.h),
      };
      const sig = JSON.stringify([data, position, pn.parent]);
      const old = prevNodes.get(el.id);
      if (old && (old.data as { sig: string }).sig === sig) {
        nodes.push(old);
        continue;
      }
      node = { id: el.id, type: 'c4group', position, parentId: pn.parent ?? undefined, width: data.w, height: data.h, data: { ...data, sig } };
    } else {
      const shape = el.kind === 'deploymentNode' ? 'box' : shapeOf(idx, el);
      const target = drill ? drillDownView(idx, el, view) : undefined;
      const data: Omit<C4NodeData, 'sig'> = {
        id: el.id,
        name: el.name,
        description: el.description,
        typeLine: typeLine(idx, el),
        shape,
        level: levelOf(idx, el),
        external: isExternal(idx, el),
        assumed: isAssumed(idx, el),
        change,
        ...(target ? { drill: { key: target.key, label: drillLabel(idx, target) } } : {}),
        w: Math.round(r.w),
        h: Math.round(r.h),
      };
      const sig = JSON.stringify([data, position, pn.parent]);
      const old = prevNodes.get(el.id);
      if (old && (old.data as { sig: string }).sig === sig) {
        nodes.push(old);
        continue;
      }
      node = { id: el.id, type: 'c4node', position, parentId: pn.parent ?? undefined, width: data.w, height: data.h, data: { ...data, sig } };
    }
    nodes.push(node);
  }

  // Parallel edges between the same pair fan out.
  const byPair = new Map<string, string[]>();
  for (const e of plan.edges) {
    const key = [e.source, e.target].sort().join('\u0000');
    const list = byPair.get(key);
    if (list) list.push(e.id);
    else byPair.set(key, [e.id]);
  }
  const edges: C4FlowEdge[] = plan.edges.map((e) => {
    const key = [e.source, e.target].sort().join('\u0000');
    const group = byPair.get(key)!.slice().sort();
    let offset = group.length > 1 ? (group.indexOf(e.id) - (group.length - 1) / 2) * 40 : 0;
    if (e.source > e.target) offset = -offset;
    const label = [e.description, e.technology ? `[${e.technology}]` : ''].filter(Boolean).join('\n');
    const data: Omit<C4EdgeData, 'sig'> = {
      relId: e.rel.id,
      label,
      technology: e.technology,
      async: isAsync(e.rel),
      implied: e.rel.implied,
      collapsed: labelOverrides?.[e.rel.id] ?? collapsed,
      offset,
    };
    const sig = JSON.stringify([data, e.source, e.target, e.description]);
    const old = prevEdges.get(e.id);
    if (old && old.data!.sig === sig) return old;
    return { id: e.id, type: 'c4edge', source: e.source, target: e.target, data: { ...data, sig } };
  });

  const sameArray = <T,>(a: T[], b: T[] | undefined) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    nodes: sameArray(nodes, prev?.nodes) ? prev!.nodes : nodes,
    edges: sameArray(edges, prev?.edges) ? prev!.edges : edges,
    layout: rectsToViewLayout(rects, viewLayout),
  };
}
