import { describe, expect, it, vi } from 'vitest';
import type { Element, Relationship, Workspace } from '../../src/shared/types.ts';

vi.mock('../../src/core/dsl/index.ts', async () => await import('./helpers/fake-dsl.ts'));

const { compareWorkspaces, parseRef } = await import('../../src/core/compare.ts');

const el = (id: string, extra: Partial<Element> = {}): Element => ({
  id,
  kind: 'container',
  name: id,
  description: '',
  technology: '',
  tags: [],
  parent: null,
  span: { startLine: 1, endLine: 1 },
  ...extra,
});
const rel = (s: string, d: string, description = 'uses', extra: Partial<Relationship> = {}): Relationship => ({
  id: `${s}->${d}|${description}`,
  source: s,
  destination: d,
  description,
  technology: '',
  tags: [],
  implied: false,
  ...extra,
});
const ws = (elements: Element[], relationships: Relationship[] = [], views: string[] = []): Workspace => ({
  name: 'w',
  description: '',
  identifiers: 'hierarchical',
  properties: {},
  configuration: {},
  elements,
  relationships,
  views: views.map((key) => ({ key, kind: 'container' as const, description: '', elements: [], relationships: [], span: { startLine: 1, endLine: 1 } })),
  warnings: [],
});

describe('compare', () => {
  it('reports added, removed and changed elements by id with the changed fields', () => {
    const left = ws([el('a'), el('b', { description: 'old', tags: ['x'] }), el('c')]);
    const right = ws([el('a'), el('b', { description: 'new', technology: 'Go', tags: ['x', 'y'] }), el('d')]);
    const { elements } = compareWorkspaces(left, right);
    const byId = Object.fromEntries(elements.map((e) => [e.id, e]));
    expect(byId.c).toMatchObject({ kind: 'removed' });
    expect(byId.d).toMatchObject({ kind: 'added' });
    expect(byId.b).toMatchObject({ kind: 'changed', fields: ['description', 'technology', 'tags'] });
    expect(byId.a).toBeUndefined();
  });

  it('ignores tag order and detects parent changes', () => {
    const { elements } = compareWorkspaces(ws([el('a', { tags: ['x', 'y'] }), el('b', { parent: 'p' })]), ws([el('a', { tags: ['y', 'x'] }), el('b', { parent: 'q' })]));
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ id: 'b', fields: ['parent'] });
  });

  it('compares relationships and views', () => {
    const left = ws([], [rel('a', 'b'), rel('a', 'c')], ['v1', 'v2']);
    const right = ws([], [rel('a', 'b', 'uses', { technology: 'HTTPS' }), rel('a', 'd')], ['v2', 'v3']);
    const r = compareWorkspaces(left, right);
    expect(r.relationships.map((x) => [x.id, x.kind])).toEqual([
      ['a->b|uses', 'changed'],
      ['a->c|uses', 'removed'],
      ['a->d|uses', 'added'],
    ]);
    expect(r.relationships[0]!.fields).toEqual(['technology']);
    expect(r.views).toEqual({ added: ['v3'], removed: ['v1'] });
  });

  it('treats a missing workspace as empty', () => {
    expect(compareWorkspaces(null, ws([el('a')])).elements).toEqual([expect.objectContaining({ id: 'a', kind: 'added' })]);
  });

  it('parses refs', () => {
    expect(parseRef('main')).toEqual({ branch: 'main' });
    expect(parseRef('main@abc')).toEqual({ branch: 'main', version: 'abc' });
  });
});
