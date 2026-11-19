// Convenience lookups over a parsed Workspace.
import type { Element, Workspace } from '../../shared/types.ts';

const cache = new WeakMap<Workspace, Map<string, Element>>();

export function elementById(ws: Workspace, id: string): Element | undefined {
  let m = cache.get(ws);
  if (!m) {
    m = new Map();
    for (const e of ws.elements) m.set(e.id, e);
    cache.set(ws, m);
  }
  return m.get(id);
}

export function elementName(ws: Workspace, id: string): string {
  return elementById(ws, id)?.name ?? id;
}

/** The text to use for an element in a relationship or view statement, or null when it has no identifier. */
export function referenceFor(ws: Workspace, id: string): string | null {
  if (id.indexOf('~') !== -1) return null;
  if (ws.identifiers === 'flat') return id.slice(id.lastIndexOf('.') + 1);
  return id;
}
