import type { Element, ElementKind, Relationship, View, ViewKind, Workspace } from '../../shared/types.ts';

export interface ModelIndex {
  ws: Workspace;
  byId: Map<string, Element>;
  relById: Map<string, Relationship>;
  children: Map<string, string[]>;
}

const cache = new WeakMap<Workspace, ModelIndex>();

export function buildIndex(ws: Workspace): ModelIndex {
  const hit = cache.get(ws);
  if (hit) return hit;
  const byId = new Map<string, Element>();
  const children = new Map<string, string[]>();
  for (const e of ws.elements) {
    byId.set(e.id, e);
    if (e.parent) {
      const list = children.get(e.parent);
      if (list) list.push(e.id);
      else children.set(e.parent, [e.id]);
    }
  }
  const relById = new Map<string, Relationship>();
  for (const r of ws.relationships) relById.set(r.id, r);
  const idx = { ws, byId, relById, children };
  cache.set(ws, idx);
  return idx;
}

export function ancestry(idx: ModelIndex, id: string): Element[] {
  const out: Element[] = [];
  let cur = idx.byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.unshift(cur);
    cur = cur.parent ? idx.byId.get(cur.parent) : undefined;
  }
  return out;
}

export function isAncestor(idx: ModelIndex, maybeAncestor: string, id: string): boolean {
  let cur = idx.byId.get(id)?.parent ?? null;
  while (cur) {
    if (cur === maybeAncestor) return true;
    cur = idx.byId.get(cur)?.parent ?? null;
  }
  return false;
}

export const KIND_LABEL: Record<ElementKind, string> = {
  person: 'Person',
  softwareSystem: 'Software system',
  container: 'Container',
  component: 'Component',
  deploymentEnvironment: 'Deployment environment',
  deploymentNode: 'Deployment node',
  infrastructureNode: 'Infrastructure node',
  containerInstance: 'Container instance',
  softwareSystemInstance: 'Software system instance',
};

export const VIEW_KIND_LABEL: Record<ViewKind, string> = {
  systemLandscape: 'System landscape',
  systemContext: 'System context',
  container: 'Containers',
  component: 'Components',
  dynamic: 'Dynamic',
  deployment: 'Deployment',
  filtered: 'Filtered',
};

export const VIEW_KIND_ORDER: ViewKind[] = ['systemLandscape', 'systemContext', 'container', 'component', 'dynamic', 'deployment', 'filtered'];

export const viewName = (v: View) => v.title || v.key;

export function viewsByKind(views: View[]): [ViewKind, View[]][] {
  return VIEW_KIND_ORDER.map((k) => [k, views.filter((v) => v.kind === k)] as [ViewKind, View[]]).filter(([, vs]) => vs.length > 0);
}

export function viewsContaining(idx: ModelIndex, id: string): View[] {
  return idx.ws.views.filter((v) => v.elements.includes(id) || v.scope === id);
}

const findView = (idx: ModelIndex, kind: ViewKind, scope?: string) => idx.ws.views.find((v) => v.kind === kind && (scope === undefined || v.scope === scope));

/**
 * The view one level below an element: a system's container view (or its system context view when it
 * has no container view), or a container's component view. Undefined when there is none, or when it is
 * the view already open.
 */
export function drillDownView(idx: ModelIndex, el: Element, current?: View): View | undefined {
  let target: View | undefined;
  if (el.kind === 'softwareSystem') target = findView(idx, 'container', el.id) ?? findView(idx, 'systemContext', el.id);
  else if (el.kind === 'container') target = findView(idx, 'component', el.id);
  return target && target.key !== current?.key ? target : undefined;
}

/** Short label for where a drill-down goes, e.g. "Containers of Internet Banking System". */
export function drillLabel(idx: ModelIndex, target: View): string {
  const scope = target.scope ? idx.byId.get(target.scope)?.name : undefined;
  const kind = target.kind === 'container' ? 'Containers' : target.kind === 'component' ? 'Components' : VIEW_KIND_LABEL[target.kind];
  return scope ? `${kind} of ${scope}` : kind;
}

export interface TrailStep {
  view: View;
  /** Element to select when going back up to this view: the element the next step zoomed into. */
  focus?: string;
}

/** Breadcrumb trail from the landscape down to `view`, following the C4 levels. */
export function viewTrail(idx: ModelIndex, view: View): TrailStep[] {
  const steps: TrailStep[] = [];
  const add = (v: View | undefined, focus?: string) => {
    if (v && v.key !== view.key && !steps.some((s) => s.view.key === v.key)) steps.push({ view: v, focus });
  };
  const landscape = findView(idx, 'systemLandscape');
  if (view.kind === 'systemContext' && view.scope) add(landscape, view.scope);
  if (view.kind === 'container' && view.scope) {
    add(landscape, view.scope);
    add(findView(idx, 'systemContext', view.scope), view.scope);
  }
  if (view.kind === 'component' && view.scope) {
    const system = idx.byId.get(view.scope)?.parent ?? undefined;
    if (system) {
      add(landscape, system);
      add(findView(idx, 'systemContext', system), system);
      add(findView(idx, 'container', system), view.scope);
    }
  }
  steps.push({ view });
  return steps;
}

export const parseTags = (s: string) =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export const STANDARD_TAGS = ['External', 'Database', 'Queue', 'Topic', 'File Store', 'Web Browser', 'Mobile App', 'Desktop App', 'Function', 'Assumed'];

/** Tags that Structurizr adds implicitly; hidden from the editable tag list. */
const IMPLICIT = new Set(['Element', 'Person', 'Software System', 'Container', 'Component', 'Deployment Node', 'Infrastructure Node', 'Container Instance', 'Software System Instance', 'Relationship']);
export const userTags = (tags: string[]) => tags.filter((t) => !IMPLICIT.has(t));

const ASYNC_RE = /\b(queue|topic|async|event|message)s?\b|kafka|sqs|sns|amqp|rabbit|pubsub/i;
export function isAsync(r: Pick<Relationship, 'technology' | 'tags' | 'description'>): boolean {
  return ASYNC_RE.test(r.technology) || r.tags.some((t) => ASYNC_RE.test(t));
}

export function relLabel(idx: ModelIndex, r: Relationship): string {
  const s = idx.byId.get(r.source)?.name ?? r.source;
  const d = idx.byId.get(r.destination)?.name ?? r.destination;
  return `${s} → ${d}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
