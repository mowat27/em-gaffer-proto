import dagre from '@dagrejs/dagre';
import type { Position, ViewLayout } from '../../shared/types.ts';
import type { ModelIndex } from '../state/modelIndex.ts';
import { GROUP_PAD, GROUP_PAD_BOTTOM, GROUP_PAD_TOP, SIZES, shapeOf } from './shapes.ts';
import type { Plan } from './plan.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function leafSize(idx: ModelIndex, plan: Plan, id: string): { w: number; h: number } {
  const n = plan.nodes.get(id)!;
  const shape = n.el.kind === 'deploymentNode' || n.el.kind === 'deploymentEnvironment' ? 'box' : shapeOf(idx, n.el);
  return SIZES[shape];
}

/** Absolute rectangles for every node in the plan. Stored positions win; the rest come from dagre (people on top, TB). */
export function layoutRects(idx: ModelIndex, plan: Plan, stored: Record<string, Position> | undefined, forceAuto = false): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const leaves = plan.order.filter((n) => !n.isGroup);
  const needAuto = leaves.filter((n) => forceAuto || !stored?.[n.id]);

  if (needAuto.length > 0) {
    const g = new dagre.graphlib.Graph({ compound: true });
    g.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 96, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of plan.order) {
      if (n.isGroup) g.setNode(n.id, {});
      else {
        const s = leafSize(idx, plan, n.id);
        g.setNode(n.id, { width: s.w, height: s.h });
      }
    }
    for (const n of plan.order) if (n.parent) g.setParent(n.id, n.parent);
    const seen = new Set<string>();
    for (const e of plan.edges) {
      const s = plan.nodes.get(e.source)!;
      const t = plan.nodes.get(e.target)!;
      if (s.isGroup || t.isGroup) continue;
      const key = `${e.source}\u0000${e.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      g.setEdge(e.source, e.target);
    }
    try {
      dagre.layout(g);
    } catch {
      /* fall through to the grid fallback below */
    }
    let i = 0;
    for (const n of needAuto) {
      const p = g.node(n.id) as { x?: number; y?: number } | undefined;
      const s = leafSize(idx, plan, n.id);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) rects.set(n.id, { x: p.x! - s.w / 2, y: p.y! - s.h / 2, w: s.w, h: s.h });
      else {
        rects.set(n.id, { x: (i % 4) * (s.w + 56), y: Math.floor(i / 4) * (s.h + 96), w: s.w, h: s.h });
      }
      i++;
    }
  }
  for (const n of leaves) {
    if (rects.has(n.id)) continue;
    const s = leafSize(idx, plan, n.id);
    const p = stored![n.id]!;
    rects.set(n.id, { x: p.x, y: p.y, w: s.w, h: s.h });
  }

  // Groups hug their children, deepest first.
  const groups = plan.order.filter((n) => n.isGroup).sort((a, b) => b.depth - a.depth);
  for (const gn of groups) {
    const kids = plan.order.filter((n) => n.parent === gn.id).map((n) => rects.get(n.id)).filter((r): r is Rect => !!r);
    if (kids.length === 0) {
      rects.set(gn.id, { x: stored?.[gn.id]?.x ?? 0, y: stored?.[gn.id]?.y ?? 0, w: SIZES.box.w, h: SIZES.box.h });
      continue;
    }
    const minX = Math.min(...kids.map((r) => r.x));
    const minY = Math.min(...kids.map((r) => r.y));
    const maxX = Math.max(...kids.map((r) => r.x + r.w));
    const maxY = Math.max(...kids.map((r) => r.y + r.h));
    rects.set(gn.id, { x: minX - GROUP_PAD, y: minY - GROUP_PAD_TOP, w: maxX - minX + GROUP_PAD * 2, h: maxY - minY + GROUP_PAD_TOP + GROUP_PAD_BOTTOM });
  }
  return rects;
}

export function rectsToViewLayout(rects: Map<string, Rect>, base?: ViewLayout): ViewLayout {
  const elements: Record<string, Position> = {};
  for (const [id, r] of rects) elements[id] = { x: Math.round(r.x), y: Math.round(r.y) };
  return { ...(base?.relationships ? { relationships: base.relationships } : {}), elements };
}
