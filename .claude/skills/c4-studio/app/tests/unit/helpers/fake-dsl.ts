// A trivial stand-in for src/core/dsl/index.ts so backend tests do not depend on the real parser.
import type { EditOp, EditResult, Element, ParseResult, Workspace } from '../../../src/shared/types.ts';

const ELEMENT_RE = /^\s*(\w+)\s*=\s*(person|softwareSystem|container|component)\s+"([^"]*)"(?:\s+"([^"]*)")?/gm;
const VIEW_RE = /^\s*(systemContext|container|systemLandscape)\s+(?:\w+\s+)?"([^"]+)"/gm;

export function fakeParse(text: string): ParseResult {
  if (text.includes('SYNTAX_ERROR')) {
    const line = text.split('\n').findIndex((l) => l.includes('SYNTAX_ERROR')) + 1;
    return { ok: false, error: { line, message: 'fake syntax error' }, parseMs: 0 };
  }
  const elements: Element[] = [];
  for (const m of text.matchAll(ELEMENT_RE)) {
    elements.push({
      id: m[1]!,
      kind: m[2] as Element['kind'],
      name: m[3]!,
      description: m[4] ?? '',
      technology: '',
      tags: [],
      parent: null,
      span: { startLine: 1, endLine: 1 },
    });
  }
  const views = [...text.matchAll(VIEW_RE)].map((m) => ({
    key: m[2]!,
    kind: m[1] as 'systemContext',
    description: '',
    elements: elements.map((e) => e.id),
    relationships: [],
    span: { startLine: 1, endLine: 1 },
  }));
  const name = /^workspace\s+"([^"]*)"/m.exec(text)?.[1] ?? '';
  const workspace: Workspace = {
    name,
    description: '',
    identifiers: 'hierarchical',
    properties: {},
    configuration: {},
    elements,
    relationships: [],
    views,
    warnings: [],
  };
  return { ok: true, workspace, parseMs: 0 };
}

export function parseWorkspace(text: string): ParseResult {
  return fakeParse(text);
}

export function applyEdits(dsl: string, ops: EditOp[]): EditResult {
  let out = dsl;
  const created: string[] = [];
  for (const op of ops) {
    if (op.op === 'addElement') {
      const id = op.identifier ?? op.name.replace(/[^A-Za-z0-9]/g, '').replace(/^./, (c) => c.toLowerCase());
      out = out.replace(/(\n\s*model\s*\{\n)/, `$1        ${id} = ${op.kind} "${op.name}"\n`);
      created.push(id);
    } else if (op.op === 'removeElement') {
      out = out
        .split('\n')
        .filter((l) => !new RegExp(`^\\s*${op.id}\\s*=`).test(l))
        .join('\n');
    } else {
      return { ok: false, error: `fake parser does not support ${op.op}` };
    }
  }
  const res = fakeParse(out);
  if (!res.ok) return { ok: false, error: 'edited text does not parse', parseError: res.error };
  return { ok: true, dsl: out, workspace: res.workspace, created };
}
