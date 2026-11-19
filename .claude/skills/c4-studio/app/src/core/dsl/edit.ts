// Text-splice edits: every line an operation does not touch is preserved byte for byte.
import type { EditOp, EditResult, Workspace } from '../../shared/types.ts';
import type { GroupRec, Node, RelRec, SourceMap } from './ast.ts';
import { parseDetailed } from './parse.ts';
import { generateIdentifier, q } from './util.ts';
import { referenceFor } from './helpers.ts';

interface Ctx {
  lines: string[];
  cr: boolean;
  unit: string;
  ws: Workspace;
  map: SourceMap;
}

type Outcome = { ok: true; lines: string[]; created?: string } | { ok: false; error: string };

const KEYWORDS: Record<string, string> = {
  person: 'person',
  softwareSystem: 'softwareSystem',
  container: 'container',
  component: 'component',
};

function indentOf(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(0, i);
}

function detectUnit(lines: string[]): string {
  let seenWorkspace = false;
  for (const l of lines) {
    const t = l.trim();
    if (t === '' || t.startsWith('//') || t.startsWith('#')) continue;
    if (!seenWorkspace) {
      seenWorkspace = true;
      continue;
    }
    const ind = indentOf(l);
    if (ind.length > 0) return ind;
  }
  return '    ';
}

function mk(ctx: Ctx, s: string): string {
  return ctx.cr ? s + '\r' : s;
}

function lineText(ctx: Ctx, n: number): string {
  return ctx.lines[n - 1] ?? '';
}

function trimTrailingEmpty(a: string[]): string[] {
  let n = a.length;
  while (n > 0 && a[n - 1] === '') n--;
  return a.slice(0, n);
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export function applyEdits(dsl: string, ops: EditOp[]): EditResult {
  let text = dsl;
  let det = parseDetailed(text);
  if (!det.ok) {
    return {
      ok: false,
      error: `The DSL does not parse: line ${det.error.line}: ${det.error.message}`,
      parseError: { line: det.error.line, message: det.error.message, ...(det.error.column !== undefined ? { column: det.error.column } : {}) },
    };
  }
  const cr = text.indexOf('\r\n') !== -1;
  const created: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (!det.ok) break;
    const lines = text.split('\n');
    const ctx: Ctx = { lines, cr, unit: detectUnit(lines), ws: det.workspace, map: det.map };
    let out: Outcome;
    try {
      out = applyOne(ctx, op);
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!out.ok) return { ok: false, error: `Edit ${i + 1} (${op.op}): ${out.error}` };
    text = out.lines.join('\n');
    if (out.created) created.push(out.created);
    let next = parseDetailed(text);
    // Removals can orphan dynamic view steps (their relationship disappeared): drop those steps.
    if ((op.op === 'removeElement' || op.op === 'removeRelationship') && !next.ok) {
      for (let guard = 0; guard < 200 && !next.ok && next.error.code === 'step-no-relationship'; guard++) {
        const ls = text.split('\n');
        let ln = next.error.line;
        for (;;) {
          const cont = (ls[ln - 1] ?? '').replace(/\s+$/, '').endsWith('\\');
          ls.splice(ln - 1, 1);
          if (!cont) break;
        }
        text = ls.join('\n');
        next = parseDetailed(text);
      }
    }
    if (!next.ok) {
      return {
        ok: false,
        error: `Edit ${i + 1} (${op.op}) produced invalid DSL: line ${next.error.line}: ${next.error.message}`,
        parseError: {
          line: next.error.line,
          message: next.error.message,
          ...(next.error.column !== undefined ? { column: next.error.column } : {}),
        },
      };
    }
    det = next;
  }
  if (!det.ok) return { ok: false, error: 'internal error' };
  return { ok: true, dsl: text, workspace: det.workspace, created };
}

function applyOne(ctx: Ctx, op: EditOp): Outcome {
  switch (op.op) {
    case 'setElement':
      return setElement(ctx, op);
    case 'addElement':
      return addElement(ctx, op);
    case 'removeElement':
      return removeElement(ctx, op.id);
    case 'addRelationship':
      return addRelationship(ctx, op);
    case 'setRelationship':
      return setRelationship(ctx, op);
    case 'removeRelationship':
      return removeRelationship(ctx, op.id);
    case 'addView':
      return addView(ctx, op);
    case 'removeView':
      return removeView(ctx, op.key);
    default:
      return { ok: false, error: 'unknown operation' };
  }
}

// ---------------------------------------------------------------------------
// setElement
// ---------------------------------------------------------------------------

function setElement(ctx: Ctx, op: Extract<EditOp, { op: 'setElement' }>): Outcome {
  const node = ctx.map.byId.get(op.id);
  if (!node) return { ok: false, error: `unknown element '${op.id}'` };
  const kind = node.kind;
  if (kind === 'containerInstance' || kind === 'softwareSystemInstance') {
    return { ok: false, error: 'deployment instances cannot be edited' };
  }
  if (op.name !== undefined && op.name === '') return { ok: false, error: 'name cannot be empty' };

  const hdr = node.hdr;
  const toks = hdr.toks;
  const m = node.hasBlock ? toks.length - 1 : toks.length;
  const kwi = toks[1] && toks[1].k === 'eq' ? 2 : 0;
  const a: string[] = [];
  for (let i = kwi + 1; i < m; i++) a.push(toks[i]!.v);

  const hasTech = kind !== 'person' && kind !== 'softwareSystem' && kind !== 'deploymentEnvironment';
  const hasDesc = kind !== 'deploymentEnvironment';
  const hasTags = kind !== 'deploymentEnvironment';
  const pos = {
    name: 0,
    description: 1,
    technology: hasTech ? 2 : -1,
    tags: kind === 'person' || kind === 'softwareSystem' ? 2 : 3,
  };
  const set = (p: number, v: string): void => {
    while (a.length <= p) a.push('');
    a[p] = v;
  };

  // replacements/deletions of nested statements, keyed by line
  const repl = new Map<number, string | null>();
  const nestedIndent = (l: number): string => indentOf(lineText(ctx, l));
  const nestedReplace = (line: { no: number; endNo: number }, kw: string, values: string[]): void => {
    const ind = nestedIndent(line.no);
    const row = lineText(ctx, line.endNo);
    // keep a trailing comment
    const cm = commentTail(row);
    repl.set(line.no, mk(ctx, ind + kw + ' ' + values.map(q).join(' ') + cm));
    for (let l = line.no + 1; l <= line.endNo; l++) repl.set(l, null);
  };

  if (op.name !== undefined) set(pos.name, op.name);
  if (op.description !== undefined && hasDesc) {
    if (node.nested.description) nestedReplace(node.nested.description, 'description', [op.description]);
    else set(pos.description, op.description);
  }
  if (op.technology !== undefined && hasTech) {
    if (node.nested.technology) nestedReplace(node.nested.technology, 'technology', [op.technology]);
    else set(pos.technology, op.technology);
  }
  if (op.tags !== undefined && hasTags) {
    if (node.nested.tags.length > 0) {
      set(pos.tags, '');
      const [firstLine, ...rest] = node.nested.tags;
      if (op.tags.length > 0) nestedReplace(firstLine!, 'tags', op.tags);
      else {
        for (let l = firstLine!.no; l <= firstLine!.endNo; l++) repl.set(l, null);
      }
      for (const r of rest) for (let l = r.no; l <= r.endNo; l++) repl.set(l, null);
    } else {
      set(pos.tags, op.tags.join(','));
    }
  }

  const args = trimTrailingEmpty(a);
  const first = lineText(ctx, hdr.no);
  const ind = indentOf(first);
  const lastTok = toks[toks.length - 1]!;
  const tailRow = lineText(ctx, hdr.endNo);
  const tail = lastTok.ln === hdr.endNo ? tailRow.slice(lastTok.end) : '';
  const prefix = kwi === 2 ? toks[0]!.v + ' = ' : '';
  const stmt =
    ind + prefix + toks[kwi]!.v + (args.length ? ' ' + args.map(q).join(' ') : '') + (node.hasBlock ? ' {' : '') + tail;
  repl.set(hdr.no, mk(ctx, stmt).replace(/\r\r$/, '\r'));
  for (let l = hdr.no + 1; l <= hdr.endNo; l++) repl.set(l, null);

  const out: string[] = [];
  for (let l = 1; l <= ctx.lines.length; l++) {
    const r = repl.get(l);
    if (r === undefined) out.push(ctx.lines[l - 1]!);
    else if (r !== null) out.push(r);
  }
  return { ok: true, lines: out };
}

/** The part of a physical line from its trailing comment (with the whitespace before it), or '' */
function commentTail(row: string): string {
  let inStr = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"' && row[i - 1] !== '\\') inStr = !inStr;
    else if (!inStr && ((c === '/' && row[i + 1] === '/') || c === '#')) {
      let s = i;
      while (s > 0 && (row[s - 1] === ' ' || row[s - 1] === '\t')) s--;
      return row.slice(s).replace(/\r$/, '');
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// addElement
// ---------------------------------------------------------------------------

function elementStatement(kind: string, ident: string, op: Extract<EditOp, { op: 'addElement' }>): string {
  const desc = op.description ?? '';
  const tech = op.technology ?? '';
  const tags = (op.tags ?? []).join(',');
  const args =
    kind === 'person' || kind === 'softwareSystem'
      ? trimTrailingEmpty([op.name, desc, tags])
      : trimTrailingEmpty([op.name, desc, tech, tags]);
  return `${ident} = ${KEYWORDS[kind]} ${args.map(q).join(' ')}`;
}

function addElement(ctx: Ctx, op: Extract<EditOp, { op: 'addElement' }>): Outcome {
  const { map } = ctx;
  if (!KEYWORDS[op.kind]) return { ok: false, error: `unsupported element kind '${op.kind}'` };
  if (!op.name || op.name.trim() === '') return { ok: false, error: 'name cannot be empty' };
  let parent: Node | null = null;
  if (op.parent !== null && op.parent !== undefined) {
    parent = map.byId.get(op.parent) ?? null;
    if (!parent) return { ok: false, error: `unknown parent '${op.parent}'` };
  }
  const wantParent: Record<string, string | null> = { person: null, softwareSystem: null, container: 'softwareSystem', component: 'container' };
  if (wantParent[op.kind] === null) {
    if (parent) return { ok: false, error: `a ${op.kind} has no parent` };
  } else if (!parent || parent.kind !== wantParent[op.kind]) {
    return { ok: false, error: `a ${op.kind} needs a ${wantParent[op.kind]} as parent` };
  }

  // identifier
  const taken = new Set<string>();
  if (ctx.ws.identifiers === 'flat') for (const i of map.idents) taken.add(i);
  else for (const n of map.nodes) if (n.parent === parent && n.ident) taken.add(n.ident);
  let ident: string;
  if (op.identifier !== undefined && op.identifier !== '') {
    ident = op.identifier;
    if (!/^[A-Za-z0-9_]+$/.test(ident)) return { ok: false, error: `invalid identifier '${ident}'` };
    if (taken.has(ident)) return { ok: false, error: `identifier '${ident}' is already in use` };
  } else {
    ident = generateIdentifier(op.name, taken);
  }
  const id = parent ? parent.id + '.' + ident : ident;
  if (map.byId.has(id)) return { ok: false, error: `identifier '${ident}' is already in use` };

  const stmt = elementStatement(op.kind, ident, op);
  const lines = ctx.lines.slice();

  if (!parent) {
    const mb = map.modelBlock;
    if (!mb) return { ok: false, error: 'the workspace has no model block' };
    const tops: { start: number; end: number; isElement: boolean }[] = [];
    for (const n of map.nodes) {
      if (n.parent === null && !n.grp) tops.push({ start: n.hdr.no, end: n.endLine, isElement: n.kind !== 'deploymentEnvironment' });
    }
    for (const g of map.groups) if (g.owner === null && !g.outer) tops.push({ start: g.startLine, end: g.endLine, isElement: true });
    for (const r of map.rels) if (r.owner === null && !r.inGroup) tops.push({ start: r.hdr.no, end: r.rel.span!.endLine, isElement: false });
    tops.sort((x, y) => x.start - y.start);
    let boundary = -1;
    let lastEl = -1;
    for (const t of tops) {
      if (!t.isElement) {
        boundary = t.start;
        break;
      }
      lastEl = t.end;
    }
    let before: number;
    if (lastEl !== -1) before = lastEl + 1;
    else if (boundary !== -1) before = boundary;
    else before = mb.endLine;
    const ind = tops.length > 0 ? indentOf(lineText(ctx, tops[0]!.start)) : indentOf(lineText(ctx, mb.startLine)) + ctx.unit;
    lines.splice(before - 1, 0, mk(ctx, ind + stmt));
    return { ok: true, lines, created: id };
  }

  if (!parent.hasBlock) {
    const hdr = parent.hdr;
    const row = lines[hdr.endNo - 1]!;
    const lastTok = hdr.toks[hdr.toks.length - 1]!;
    if (lastTok.ln !== hdr.endNo) return { ok: false, error: 'cannot add children to a statement that spans several lines' };
    const pind = indentOf(lineText(ctx, hdr.no));
    lines[hdr.endNo - 1] = row.slice(0, lastTok.end) + ' {' + row.slice(lastTok.end);
    lines.splice(hdr.endNo, 0, mk(ctx, pind + ctx.unit + stmt), mk(ctx, pind + '}'));
    return { ok: true, lines, created: id };
  }

  // parent already has a block
  const kids: { start: number; end: number }[] = [];
  for (const n of parent.children) if (!n.grp) kids.push({ start: n.hdr.no, end: n.endLine });
  for (const g of map.groups) if (g.owner === parent.id && !g.outer) kids.push({ start: g.startLine, end: g.endLine });
  kids.sort((x, y) => x.start - y.start);
  let before: number;
  if (kids.length > 0) {
    before = kids[kids.length - 1]!.end + 1;
  } else {
    let firstRel = -1;
    for (const r of map.rels) if (r.owner === parent.id && !r.inGroup && (firstRel === -1 || r.hdr.no < firstRel)) firstRel = r.hdr.no;
    before = firstRel !== -1 ? firstRel : parent.endLine;
  }
  const ind = kids.length > 0 ? indentOf(lineText(ctx, kids[0]!.start)) : indentOf(lineText(ctx, parent.hdr.no)) + ctx.unit;
  lines.splice(before - 1, 0, mk(ctx, ind + stmt));
  return { ok: true, lines, created: id };
}

// ---------------------------------------------------------------------------
// removeElement
// ---------------------------------------------------------------------------

interface Plan {
  deleted: Uint8Array;
}

function markDeleted(plan: Plan, a: number, b: number): void {
  for (let l = a; l <= b && l < plan.deleted.length; l++) plan.deleted[l] = 1;
}

function removeElement(ctx: Ctx, id: string): Outcome {
  const { map, ws } = ctx;
  const node = map.byId.get(id);
  if (!node) return { ok: false, error: `unknown element '${id}'` };

  const R = new Set<string>();
  const collect = (n: Node): void => {
    R.add(n.id);
    for (const c of n.children) collect(c);
  };
  collect(node);
  for (const n of map.nodes) if (n.el.instanceOf !== undefined && R.has(n.el.instanceOf)) R.add(n.id);

  const plan: Plan = { deleted: new Uint8Array(ctx.lines.length + 3) };
  // element statements (top of each removed subtree)
  for (const n of map.nodes) {
    if (!R.has(n.id)) continue;
    if (n.parent && R.has(n.parent.id)) continue;
    markDeleted(plan, n.hdr.no, n.endLine);
  }
  // relationships
  for (const r of map.rels) {
    if (R.has(r.rel.source) || R.has(r.rel.destination)) markDeleted(plan, r.hdr.no, r.rel.span!.endLine);
  }
  // views scoped to the element, and the lines naming it in the others
  const removedViews = new Set<string>();
  for (const v of ws.views) {
    if ((v.scope !== undefined && R.has(v.scope)) || (v.environment !== undefined && R.has(v.environment))) {
      removedViews.add(v.key);
      markDeleted(plan, v.span.startLine, v.span.endLine);
    }
  }
  const cuts = new Map<number, { col: number; end: number }[]>();
  for (const info of map.viewRefs) {
    if (removedViews.has(info.viewKey)) continue;
    let dead = 0;
    const lineCuts: { col: number; end: number }[] = [];
    let kill = false;
    for (const ex of info.exprs) {
      const hit = ex.ids.some((x) => R.has(x));
      if (!hit) continue;
      if (ex.killLine) kill = true;
      else {
        dead++;
        if (ex.ln === info.hdr.no && info.hdr.endNo === info.hdr.no) lineCuts.push({ col: ex.col, end: ex.end });
        else kill = true;
      }
    }
    if (kill || (dead > 0 && dead === info.exprs.length)) markDeleted(plan, info.hdr.no, info.hdr.endNo);
    else if (lineCuts.length > 0) {
      const prev = cuts.get(info.hdr.no) ?? [];
      cuts.set(info.hdr.no, prev.concat(lineCuts));
    }
  }
  // groups that become empty
  const groups = map.groups.slice().sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
  const hadContent = (g: GroupRec): boolean => {
    for (let l = g.startLine + 1; l < g.endLine; l++) if (map.content[l]) return true;
    return false;
  };
  const hasContentNow = (g: GroupRec): boolean => {
    for (let l = g.startLine + 1; l < g.endLine; l++) if (map.content[l] && !plan.deleted[l]) return true;
    return false;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of groups) {
      if (plan.deleted[g.startLine]) continue;
      if (hadContent(g) && !hasContentNow(g)) {
        markDeleted(plan, g.startLine, g.endLine);
        changed = true;
      }
    }
  }

  const out: string[] = [];
  for (let l = 1; l <= ctx.lines.length; l++) {
    if (plan.deleted[l]) continue;
    const c = cuts.get(l);
    if (!c) {
      out.push(ctx.lines[l - 1]!);
      continue;
    }
    let row = ctx.lines[l - 1]!;
    c.sort((x, y) => y.col - x.col);
    for (const cut of c) {
      let end = cut.end;
      while (end < row.length && (row[end] === ' ' || row[end] === '\t')) end++;
      let start = cut.col;
      if (end >= row.length || row[end] === '\r' || row[end] === '/' || row[end] === '#') {
        while (start > 0 && (row[start - 1] === ' ' || row[start - 1] === '\t')) start--;
        end = cut.end;
      }
      row = row.slice(0, start) + row.slice(end);
    }
    out.push(row);
  }
  return { ok: true, lines: out };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function relFormat(src: string, dst: string, desc: string, tech: string, tags: string[]): string {
  const args = trimTrailingEmpty([desc, tech, tags.join(',')]);
  return `${src} -> ${dst}${args.length ? ' ' + args.map(q).join(' ') : ''}`;
}

function addRelationship(ctx: Ctx, op: Extract<EditOp, { op: 'addRelationship' }>): Outcome {
  const { map, ws } = ctx;
  const src = map.byId.get(op.source);
  const dst = map.byId.get(op.destination);
  if (!src) return { ok: false, error: `unknown element '${op.source}'` };
  if (!dst) return { ok: false, error: `unknown element '${op.destination}'` };
  const sref = referenceFor(ws, src.id);
  const dref = referenceFor(ws, dst.id);
  if (!sref) return { ok: false, error: `'${src.id}' has no identifier and cannot be referenced` };
  if (!dref) return { ok: false, error: `'${dst.id}' has no identifier and cannot be referenced` };
  const mb = map.modelBlock;
  if (!mb) return { ok: false, error: 'the workspace has no model block' };
  const desc = op.description ?? '';
  const stmt = relFormat(sref, dref, desc, op.technology ?? '', op.tags ?? []);
  let ind: string | null = null;
  let firstStart = Infinity;
  for (const n of map.nodes) if (n.parent === null && !n.grp && n.hdr.no < firstStart) firstStart = n.hdr.no;
  for (const g of map.groups) if (g.owner === null && !g.outer && g.startLine < firstStart) firstStart = g.startLine;
  for (const r of map.rels) if (r.owner === null && !r.inGroup && r.hdr.no < firstStart) firstStart = r.hdr.no;
  if (firstStart !== Infinity) ind = indentOf(lineText(ctx, firstStart));
  if (ind === null) ind = indentOf(lineText(ctx, mb.startLine)) + ctx.unit;
  const lines = ctx.lines.slice();
  lines.splice(mb.endLine - 1, 0, mk(ctx, ind + stmt));
  return { ok: true, lines, created: `${src.id}->${dst.id}|${desc}` };
}

function findRel(ctx: Ctx, id: string): { rec?: RelRec; error?: string } {
  const rec = ctx.map.rels.find((r) => r.rel.id === id);
  if (rec) return { rec };
  const r = ctx.ws.relationships.find((x) => x.id === id);
  if (r) return { error: 'implied relationship' };
  return { error: `unknown relationship '${id}'` };
}

function setRelationship(ctx: Ctx, op: Extract<EditOp, { op: 'setRelationship' }>): Outcome {
  const f = findRel(ctx, op.id);
  if (!f.rec) return { ok: false, error: f.error! };
  const rec = f.rec;
  const hdr = rec.hdr;
  const toks = hdr.toks;
  const m = rec.hasBlock ? toks.length - 1 : toks.length;
  const dstIdx = toks.indexOf(rec.dstTok);
  const a: string[] = [];
  for (let i = dstIdx + 1; i < m; i++) a.push(toks[i]!.v);
  const set = (p: number, v: string): void => {
    while (a.length <= p) a.push('');
    a[p] = v;
  };
  if (op.description !== undefined) set(0, op.description);
  if (op.technology !== undefined) set(1, op.technology);
  if (op.tags !== undefined) set(2, op.tags.join(','));
  const args = trimTrailingEmpty(a);
  const first = lineText(ctx, hdr.no);
  if (rec.dstTok.ln !== hdr.no) return { ok: false, error: 'cannot edit a relationship that spans several lines' };
  const head = first.slice(0, rec.dstTok.end);
  const lastTok = toks[toks.length - 1]!;
  const tail = lastTok.ln === hdr.endNo ? lineText(ctx, hdr.endNo).slice(lastTok.end) : '';
  const stmt = head + (args.length ? ' ' + args.map(q).join(' ') : '') + (rec.hasBlock ? ' {' : '') + tail;
  const lines = ctx.lines.slice();
  lines.splice(hdr.no - 1, hdr.endNo - hdr.no + 1, ctx.cr && !stmt.endsWith('\r') ? stmt + '\r' : stmt);
  return { ok: true, lines };
}

function removeRelationship(ctx: Ctx, id: string): Outcome {
  const f = findRel(ctx, id);
  if (!f.rec) return { ok: false, error: f.error! };
  const lines = ctx.lines.slice();
  lines.splice(f.rec.hdr.no - 1, f.rec.rel.span!.endLine - f.rec.hdr.no + 1);
  return { ok: true, lines };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function addView(ctx: Ctx, op: Extract<EditOp, { op: 'addView' }>): Outcome {
  const { map, ws } = ctx;
  if (!op.key) return { ok: false, error: 'view key cannot be empty' };
  if (ws.views.some((v) => v.key === op.key)) return { ok: false, error: `a view with key '${op.key}' already exists` };
  let scopeRef = '';
  if (op.kind !== 'systemLandscape') {
    if (!op.scope) return { ok: false, error: `a ${op.kind} view needs a scope` };
    const sc = map.byId.get(op.scope);
    if (!sc) return { ok: false, error: `unknown scope '${op.scope}'` };
    const want = op.kind === 'component' ? 'container' : 'softwareSystem';
    if (sc.kind !== want) return { ok: false, error: `the scope of a ${op.kind} view must be a ${want}` };
    const ref = referenceFor(ws, sc.id);
    if (!ref) return { ok: false, error: `'${sc.id}' has no identifier and cannot be referenced` };
    scopeRef = ref + ' ';
  }
  const lines = ctx.lines.slice();
  const vb = map.viewsBlock;
  const mk2 = (ind: string): string[] => [
    mk(ctx, `${ind}${op.kind} ${scopeRef}${q(op.key)} ${q(op.description ?? '')} {`),
    mk(ctx, `${ind}${ctx.unit}include *`),
    mk(ctx, `${ind}}`),
  ];
  if (vb) {
    const first = map.viewDrafts[0];
    const ind = first ? indentOf(lineText(ctx, first.line)) : indentOf(lineText(ctx, vb.startLine)) + ctx.unit;
    lines.splice(vb.endLine - 1, 0, ...mk2(ind));
    return { ok: true, lines };
  }
  const mb = map.modelBlock;
  if (!mb) return { ok: false, error: 'the workspace has no model block' };
  const bind = indentOf(lineText(ctx, mb.startLine));
  const block = [mk(ctx, ''), mk(ctx, `${bind}views {`), ...mk2(bind + ctx.unit), mk(ctx, `${bind}}`)];
  lines.splice(mb.endLine, 0, ...block);
  return { ok: true, lines };
}

function removeView(ctx: Ctx, key: string): Outcome {
  const v = ctx.ws.views.find((x) => x.key === key);
  if (!v) return { ok: false, error: `unknown view '${key}'` };
  const lines = ctx.lines.slice();
  lines.splice(v.span.startLine - 1, v.span.endLine - v.span.startLine + 1);
  return { ok: true, lines };
}
