import type { Element, Relationship, View } from '../../shared/types.ts';
import { isAncestor, type ModelIndex } from '../state/modelIndex.ts';

export interface PlanNode {
  id: string;
  el: Element;
  isGroup: boolean;
  /** Nearest enclosing group in this view, or null. */
  parent: string | null;
  depth: number;
  /** True for the boundary of a container or component view's scope. */
  boundary: boolean;
}

export interface PlanEdge {
  id: string;
  rel: Relationship;
  source: string;
  target: string;
  description: string;
  technology: string;
  order?: number;
}

export interface Plan {
  nodes: Map<string, PlanNode>;
  /** Groups by depth ascending, then leaves, so parents precede children. */
  order: PlanNode[];
  edges: PlanEdge[];
}

export function planView(idx: ModelIndex, view: View): Plan {
  const ids = view.elements.filter((id) => idx.byId.has(id));
  const idSet = new Set(ids);
  const scope = view.scope && (view.kind === 'container' || view.kind === 'component' || view.kind === 'dynamic') && idx.byId.has(view.scope) ? view.scope : null;
  const eligible = (id: string) => idSet.has(id) || id === scope;

  const groupIds = new Set<string>();
  const parentOf = new Map<string, string | null>();
  const ancestorsInView = (id: string): string[] => {
    const out: string[] = [];
    let cur = idx.byId.get(id)?.parent ?? null;
    while (cur) {
      if (eligible(cur)) out.push(cur);
      cur = idx.byId.get(cur)?.parent ?? null;
    }
    return out;
  };
  for (const id of ids) {
    const anc = ancestorsInView(id);
    parentOf.set(id, anc[0] ?? null);
    for (const a of anc) groupIds.add(a);
  }
  const allIds = [...ids];
  for (const g of groupIds) {
    if (!idSet.has(g)) {
      allIds.push(g);
      parentOf.set(g, ancestorsInView(g)[0] ?? null);
    }
  }

  const depthOf = (id: string): number => {
    let d = 0;
    let cur = parentOf.get(id) ?? null;
    while (cur) {
      d++;
      cur = parentOf.get(cur) ?? null;
    }
    return d;
  };

  const nodes = new Map<string, PlanNode>();
  for (const id of allIds) {
    const el = idx.byId.get(id)!;
    nodes.set(id, { id, el, isGroup: groupIds.has(id), parent: parentOf.get(id) ?? null, depth: depthOf(id), boundary: id === scope });
  }
  const groups = [...nodes.values()].filter((n) => n.isGroup).sort((a, b) => a.depth - b.depth);
  const personFirst = (a: PlanNode, b: PlanNode) => Number(b.el.kind === 'person') - Number(a.el.kind === 'person');
  const leaves = [...nodes.values()].filter((n) => !n.isGroup).sort(personFirst);
  const order = [...groups, ...leaves];

  const edges: PlanEdge[] = [];
  const usable = (r: { source: string; destination: string }) =>
    nodes.has(r.source) && nodes.has(r.destination) && r.source !== r.destination && !isAncestor(idx, r.source, r.destination) && !isAncestor(idx, r.destination, r.source);

  if (view.kind === 'dynamic' && view.steps?.length) {
    for (const s of view.steps) {
      if (!usable(s)) continue;
      const rel = idx.relById.get(s.relationship) ?? {
        id: s.relationship,
        source: s.source,
        destination: s.destination,
        description: s.description,
        technology: s.technology,
        tags: [],
        implied: false,
      };
      edges.push({ id: `step-${s.order}`, rel, source: s.source, target: s.destination, description: `${s.order}. ${s.description}`, technology: s.technology, order: s.order });
    }
  } else {
    for (const rid of view.relationships) {
      const rel = idx.relById.get(rid);
      if (!rel || !usable(rel)) continue;
      edges.push({ id: rel.id, rel, source: rel.source, target: rel.destination, description: rel.description, technology: rel.technology });
    }
  }
  return { nodes, order, edges };
}
