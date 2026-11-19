import type { Comparison, Element, ElementChange, Layout, Ref, Relationship, RelationshipChange, Version, Workspace } from '../shared/types.ts';
import { parseWorkspace } from './dsl/index.ts';
import { emptyLayout } from './layout.ts';
import type { Store } from './store.ts';

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((t, i) => t === [...b].sort()[i]);
}

export function diffElements(left: Workspace | null, right: Workspace | null): ElementChange[] {
  const l = new Map((left?.elements ?? []).map((e) => [e.id, e]));
  const r = new Map((right?.elements ?? []).map((e) => [e.id, e]));
  const out: ElementChange[] = [];
  for (const [id, le] of l) {
    const re = r.get(id);
    if (!re) {
      out.push({ id, kind: 'removed', left: le });
      continue;
    }
    const fields: NonNullable<ElementChange['fields']> = [];
    if (le.name !== re.name) fields.push('name');
    if (le.description !== re.description) fields.push('description');
    if (le.technology !== re.technology) fields.push('technology');
    if (!sameTags(le.tags, re.tags)) fields.push('tags');
    if (le.parent !== re.parent) fields.push('parent');
    if (fields.length) out.push({ id, kind: 'changed', left: le, right: re, fields });
  }
  for (const [id, re] of r) if (!l.has(id)) out.push({ id, kind: 'added', right: re });
  return out;
}

export function diffRelationships(left: Workspace | null, right: Workspace | null): RelationshipChange[] {
  const l = new Map((left?.relationships ?? []).map((e) => [e.id, e]));
  const r = new Map((right?.relationships ?? []).map((e) => [e.id, e]));
  const out: RelationshipChange[] = [];
  for (const [id, le] of l) {
    const re = r.get(id);
    if (!re) {
      out.push({ id, kind: 'removed', left: le });
      continue;
    }
    const fields: NonNullable<RelationshipChange['fields']> = [];
    if (le.description !== re.description) fields.push('description');
    if (le.technology !== re.technology) fields.push('technology');
    if (!sameTags(le.tags, re.tags)) fields.push('tags');
    if (fields.length) out.push({ id, kind: 'changed', left: le, right: re, fields });
  }
  for (const [id, re] of r) if (!l.has(id)) out.push({ id, kind: 'added', right: re });
  return out;
}

export function diffViews(left: Workspace | null, right: Workspace | null): { added: string[]; removed: string[] } {
  const l = new Set((left?.views ?? []).map((v) => v.key));
  const r = new Set((right?.views ?? []).map((v) => v.key));
  return { added: [...r].filter((k) => !l.has(k)), removed: [...l].filter((k) => !r.has(k)) };
}

export function compareWorkspaces(left: Workspace | null, right: Workspace | null) {
  return { elements: diffElements(left, right), relationships: diffRelationships(left, right), views: diffViews(left, right) };
}

function safeParse(dsl: string): Workspace | null {
  try {
    const res = parseWorkspace(dsl);
    return res.ok ? res.workspace : null;
  } catch {
    return null;
  }
}

/** Parse the format `<branch>[@<version>]`. */
export function parseRef(text: string): Ref {
  const at = text.indexOf('@');
  if (at < 0) return { branch: text };
  const branch = text.slice(0, at);
  const version = text.slice(at + 1);
  return version ? { branch, version } : { branch };
}

export async function compareRefs(store: Store, model: string, leftRef: Ref, rightRef: Ref): Promise<Comparison> {
  const [l, r] = await Promise.all([store.readRef(model, leftRef), store.readRef(model, rightRef)]);
  const lw = safeParse(l.dsl);
  const rw = safeParse(r.dsl);
  const side = (ref: Ref, workspace: Workspace | null, layout: Layout, version: Version | null) => ({
    ref,
    workspace,
    layout: layout ?? emptyLayout(),
    version,
  });
  return {
    left: side(leftRef, lw, l.layout, l.version),
    right: side(rightRef, rw, r.layout, r.version),
    ...compareWorkspaces(lw, rw),
  };
}

export type { Element, Relationship };
