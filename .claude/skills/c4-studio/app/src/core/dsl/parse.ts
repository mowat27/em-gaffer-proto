// Structurizr DSL parser: statements -> element tree -> relationships (explicit + implied) -> views.
// Never throws; unknown constructs become warnings, genuine syntax errors become a ParseError.
import type {
  Element,
  ElementKind,
  ParseResult,
  Relationship,
  Warning,
  Workspace,
} from '../../shared/types.ts';
import type {
  DetailedResult,
  GroupRec,
  InternalParseError,
  Node,
  RelRec,
  SourceMap,
  ViewDraft,
  ViewRefInfo,
} from './ast.ts';
import { tokenize } from './tokenize.ts';
import type { Line, Tok } from './tokenize.ts';
import { lastSegment, lowerCamel, splitTags } from './util.ts';
import { resolveViews } from './views.ts';

class ParseFail extends Error {
  err: InternalParseError;
  constructor(err: InternalParseError) {
    super(err.message);
    this.err = err;
  }
}

function fail(line: number, message: string, column?: number, code?: InternalParseError['code']): never {
  const err: InternalParseError = { line, message };
  if (column !== undefined) err.column = column;
  if (code) err.code = code;
  throw new ParseFail(err);
}

type Frame =
  | { t: 'ws' }
  | { t: 'model'; hdr: Line }
  | { t: 'node'; node: Node }
  | { t: 'group'; rec: GroupRec }
  | { t: 'props'; node: Node | null }
  | { t: 'persp'; node: Node }
  | { t: 'views'; hdr: Line }
  | { t: 'view'; d: ViewDraft; top: boolean }
  | { t: 'config' }
  | { t: 'skip' }
  | { t: 'relblock'; p: Pending };

interface Pending {
  src: string;
  dst: string;
  srcTok: Tok;
  dstTok: Tok;
  ctx: Node | null;
  hdr: Line;
  hasBlock: boolean;
  endLine: number;
  desc: string;
  tech: string;
  tags: string;
  ident: string | null;
  inGroup: boolean;
}

const KW_KIND: Record<string, ElementKind> = {
  person: 'person',
  softwaresystem: 'softwareSystem',
  container: 'container',
  component: 'component',
  deploymentenvironment: 'deploymentEnvironment',
  deploymentnode: 'deploymentNode',
  infrastructurenode: 'infrastructureNode',
  containerinstance: 'containerInstance',
  softwaresysteminstance: 'softwareSystemInstance',
};

const CHILD_KINDS: Record<string, ElementKind[]> = {
  model: ['person', 'softwareSystem', 'deploymentEnvironment'],
  person: [],
  softwareSystem: ['container'],
  container: ['component'],
  component: [],
  deploymentEnvironment: ['deploymentNode'],
  deploymentNode: ['deploymentNode', 'infrastructureNode', 'containerInstance', 'softwareSystemInstance'],
  infrastructureNode: [],
  containerInstance: [],
  softwareSystemInstance: [],
};

const GROUP_OK: Record<string, boolean> = {
  model: true,
  softwareSystem: true,
  container: true,
  deploymentEnvironment: true,
  deploymentNode: true,
};

const STATIC_KINDS = new Set<ElementKind>(['person', 'softwareSystem', 'container', 'component']);

interface State {
  warnings: Warning[];
  stack: Frame[];
  name: string;
  description: string;
  identifiers: 'hierarchical' | 'flat';
  properties: Record<string, string>;
  scope?: 'softwaresystem' | 'landscape' | 'none';
  nodes: Node[];
  byId: Map<string, Node>;
  byIdent: Map<string, Node>;
  idents: Set<string>;
  topSegs: Set<string>;
  groups: GroupRec[];
  pending: Pending[];
  drafts: ViewDraft[];
  modelBlock: SourceMap['modelBlock'];
  viewsBlock: SourceMap['viewsBlock'];
  extended: boolean;
  sawWorkspace: boolean;
  wsClosed: boolean;
  suffixIdx: Map<string, Node[]> | null;
  ambiguous: boolean;
}

function warn(S: State, line: number, message: string): void {
  S.warnings.push({ line, message });
}

function valuesOf(toks: Tok[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(toks[i]!.v);
  return out;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function parseDetailed(text: string): DetailedResult {
  const t0 = performance.now();
  try {
    const r = parseInner(text);
    return { ok: true, workspace: r.workspace, map: r.map, parseMs: performance.now() - t0 };
  } catch (e) {
    const parseMs = performance.now() - t0;
    if (e instanceof ParseFail) return { ok: false, error: e.err, parseMs };
    return { ok: false, error: { line: 1, message: 'Internal parser error: ' + (e instanceof Error ? e.message : String(e)) }, parseMs };
  }
}

export function parseWorkspace(text: string): ParseResult {
  const r = parseDetailed(text);
  if (r.ok) return { ok: true, workspace: r.workspace, parseMs: r.parseMs };
  const error: { line: number; column?: number; message: string } = { line: r.error.line, message: r.error.message };
  if (r.error.column !== undefined) error.column = r.error.column;
  return { ok: false, error, parseMs: r.parseMs };
}

// ---------------------------------------------------------------------------
// Phase 1: statements
// ---------------------------------------------------------------------------

function parseInner(text: string): { workspace: Workspace; map: SourceMap } {
  const tk = tokenize(text);
  if (tk.error) fail(tk.error.line, tk.error.message, tk.error.column, 'syntax');
  const S: State = {
    warnings: [],
    stack: [],
    name: '',
    description: '',
    identifiers: 'flat',
    properties: {},
    nodes: [],
    byId: new Map(),
    byIdent: new Map(),
    idents: new Set(),
    topSegs: new Set(),
    groups: [],
    pending: [],
    drafts: [],
    modelBlock: null,
    viewsBlock: null,
    extended: false,
    sawWorkspace: false,
    wsClosed: false,
    suffixIdx: null,
    ambiguous: false,
  };

  const opens: number[] = [];
  for (const ln of tk.lines) {
    const before = S.stack.length;
    statement(S, ln);
    const after = S.stack.length;
    if (after > before) opens.push(ln.no);
    else if (after < before) opens.length = after;
  }

  if (S.stack.length > 0) fail(opens[opens.length - 1] ?? 1, "Unclosed '{'", undefined, 'syntax');
  if (!S.sawWorkspace) fail(1, "Expected 'workspace'", undefined, 'syntax');

  return finish(S, tk.content, tk.lineCount);
}

function statement(S: State, ln: Line): void {
  const toks = ln.toks;
  const first = toks[0]!;
  if (first.k === 'rbrace') {
    if (toks.length > 1) fail(ln.no, "Unexpected content after '}'", toks[1]!.col, 'syntax');
    closeFrame(S, ln);
    return;
  }
  const last = toks[toks.length - 1]!;
  const hasBlock = last.k === 'lbrace';
  const m = hasBlock ? toks.length - 1 : toks.length;
  for (let i = 0; i < m; i++) {
    const k = toks[i]!.k;
    if (k === 'lbrace') fail(ln.no, "Unexpected '{' (a block must open at the end of a line)", toks[i]!.col, 'syntax');
    if (k === 'rbrace') fail(ln.no, "Unexpected '}' (a block must close on its own line)", toks[i]!.col, 'syntax');
  }
  const top = S.stack.length > 0 ? S.stack[S.stack.length - 1]! : null;
  if (m === 0) {
    // bare `{`: only meaningful for parallel steps in a dynamic view
    if (top && top.t === 'view') {
      S.stack.push({ t: 'view', d: top.d, top: false });
      return;
    }
    fail(ln.no, "Unexpected '{'", first.col, 'syntax');
  }
  if (!top) {
    rootStatement(S, ln, m, hasBlock);
    return;
  }
  switch (top.t) {
    case 'ws':
      wsStatement(S, ln, m, hasBlock);
      return;
    case 'model':
    case 'node':
    case 'group':
      modelStatement(S, ln, m, hasBlock, top);
      return;
    case 'props':
      if (hasBlock) pushSkip(S, ln, 'Block ignored');
      else if (top.node) {
        const el = top.node.el;
        if (!el.properties) el.properties = {};
        if (m >= 2) el.properties[toks[0]!.v] = toks[1]!.v;
      } else if (m >= 2) S.properties[toks[0]!.v] = toks[1]!.v;
      return;
    case 'persp':
      if (hasBlock) pushSkip(S, ln, 'Block ignored');
      else {
        const el = top.node.el;
        if (!el.properties) el.properties = {};
        if (m >= 2) el.properties['perspective.' + toks[0]!.v] = toks[1]!.v;
      }
      return;
    case 'views':
      viewsStatement(S, ln, m, hasBlock, top);
      return;
    case 'view':
      viewStatement(S, ln, m, hasBlock, top);
      return;
    case 'config':
      if (hasBlock) {
        pushSkip(S, ln, 'Block ignored');
        return;
      }
      if (toks[0]!.v.toLowerCase() === 'scope' && m >= 2) {
        const v = toks[1]!.v.toLowerCase();
        if (v === 'softwaresystem' || v === 'landscape' || v === 'none') S.scope = v;
        else warn(S, ln.no, `Unknown configuration scope '${toks[1]!.v}'`);
      }
      return;
    case 'skip':
      if (hasBlock) S.stack.push({ t: 'skip' });
      return;
    case 'relblock':
      if (hasBlock) S.stack.push({ t: 'skip' });
      return;
  }
}

function pushSkip(S: State, ln: Line, why: string): void {
  warn(S, ln.no, `${why}: '${ln.toks[0]!.v}'`);
  S.stack.push({ t: 'skip' });
}

function closeFrame(S: State, ln: Line): void {
  const f = S.stack.pop();
  if (!f) fail(ln.no, "Unexpected '}'", ln.toks[0]!.col, 'syntax');
  switch (f.t) {
    case 'node':
      f.node.endLine = ln.no;
      f.node.el.span.endLine = ln.no;
      break;
    case 'group':
      f.rec.endLine = ln.no;
      break;
    case 'model':
      S.modelBlock = { startLine: f.hdr.no, endLine: ln.no, hdr: f.hdr };
      break;
    case 'views':
      S.viewsBlock = { startLine: f.hdr.no, endLine: ln.no, hdr: f.hdr };
      break;
    case 'view':
      if (f.top) f.d.endLine = ln.no;
      break;
    case 'relblock':
      f.p.endLine = ln.no;
      break;
    case 'ws':
      S.wsClosed = true;
      break;
    default:
      break;
  }
}

function rootStatement(S: State, ln: Line, m: number, hasBlock: boolean): void {
  const toks = ln.toks;
  const kw = toks[0]!.v.toLowerCase();
  if (kw === 'workspace' && !S.sawWorkspace) {
    S.sawWorkspace = true;
    if (!hasBlock) fail(ln.no, "'workspace' requires a block", undefined, 'syntax');
    if (m >= 2 && toks[1]!.k === 'word' && toks[1]!.v.toLowerCase() === 'extends') {
      S.extended = true;
      warn(S, ln.no, `'workspace extends ${m >= 3 ? toks[2]!.v : ''}' is not resolved; the model is treated as empty`);
    } else {
      if (m >= 2) S.name = toks[1]!.v;
      if (m >= 3) S.description = toks[2]!.v;
    }
    S.stack.push({ t: 'ws' });
    return;
  }
  if (S.sawWorkspace) {
    if (!S.wsClosed) fail(ln.no, 'Unexpected statement', toks[0]!.col, 'syntax');
    warn(S, ln.no, 'Content after the workspace block ignored');
    if (hasBlock) S.stack.push({ t: 'skip' });
    return;
  }
  if (kw.charCodeAt(0) === 33) {
    warn(S, ln.no, `Unsupported directive '${toks[0]!.v}'`);
    if (hasBlock) S.stack.push({ t: 'skip' });
    return;
  }
  fail(ln.no, "Expected 'workspace'", toks[0]!.col, 'syntax');
}

function directive(S: State, ln: Line, m: number, hasBlock: boolean): void {
  const toks = ln.toks;
  const d = toks[0]!.v.toLowerCase();
  if (d === '!identifiers') {
    const v = m >= 2 ? toks[1]!.v.toLowerCase() : '';
    if (v === 'hierarchical' || v === 'flat') S.identifiers = v;
    else warn(S, ln.no, `Unknown !identifiers mode '${m >= 2 ? toks[1]!.v : ''}'`);
    return;
  }
  warn(S, ln.no, `Unsupported directive '${toks[0]!.v}' ignored`);
  if (hasBlock) S.stack.push({ t: 'skip' });
}

function wsStatement(S: State, ln: Line, m: number, hasBlock: boolean): void {
  const toks = ln.toks;
  const t0 = toks[0]!;
  const kw = t0.v.toLowerCase();
  if (t0.k === 'word' && kw.charCodeAt(0) === 33) {
    directive(S, ln, m, hasBlock);
    return;
  }
  switch (kw) {
    case 'name':
      if (m >= 2) S.name = toks[1]!.v;
      return;
    case 'description':
      if (m >= 2) S.description = toks[1]!.v;
      return;
    case 'properties':
      if (hasBlock) S.stack.push({ t: 'props', node: null });
      return;
    case 'model':
      if (!hasBlock) fail(ln.no, "'model' requires a block", undefined, 'syntax');
      S.stack.push({ t: 'model', hdr: ln });
      return;
    case 'views':
      if (!hasBlock) fail(ln.no, "'views' requires a block", undefined, 'syntax');
      S.stack.push({ t: 'views', hdr: ln });
      return;
    case 'configuration':
      if (hasBlock) S.stack.push({ t: 'config' });
      return;
    default:
      warn(S, ln.no, `Unsupported workspace statement '${t0.v}' ignored`);
      if (hasBlock) S.stack.push({ t: 'skip' });
  }
}

// ---------------------------------------------------------------------------
// Model statements
// ---------------------------------------------------------------------------

function modelStatement(
  S: State,
  ln: Line,
  m: number,
  hasBlock: boolean,
  top: Frame & { t: 'model' | 'node' | 'group' },
): void {
  const toks = ln.toks;
  const t0 = toks[0]!;

  // nearest non-group frame: the owner of this statement
  let ctx: Node | null = null;
  let ownerKind = 'model';
  let groupRec: GroupRec | null = null;
  let frame: Frame = top;
  if (frame.t === 'group') {
    groupRec = frame.rec;
    for (let i = S.stack.length - 2; i >= 0; i--) {
      const f = S.stack[i]!;
      if (f.t !== 'group') {
        frame = f;
        break;
      }
    }
  }
  if (frame.t === 'node') {
    ctx = frame.node;
    ownerKind = ctx.kind;
  }

  if (t0.k === 'word' && t0.v.charCodeAt(0) === 33) {
    directive(S, ln, m, hasBlock);
    return;
  }

  // relationship
  let ai = -1;
  if (t0.k === 'arrow') ai = 0;
  else if (m >= 3 && toks[1]!.k === 'arrow') ai = 1;
  else if (m >= 5 && toks[1]!.k === 'eq' && toks[3]!.k === 'arrow') ai = 3;
  if (ai >= 0) {
    relationship(S, ln, m, hasBlock, ai, ctx, groupRec !== null);
    return;
  }

  let ident: string | null = null;
  let kwi = 0;
  if (m >= 3 && toks[1]!.k === 'eq') {
    ident = toks[0]!.v;
    kwi = 2;
  }
  const kwTok = toks[kwi]!;
  const kw = kwTok.v.toLowerCase();

  if (kw === 'group' || kw === 'enterprise') {
    if (!GROUP_OK[ownerKind]) fail(ln.no, `'${kwTok.v}' cannot be used inside a ${ownerKind}`, kwTok.col, 'syntax');
    if (!hasBlock) fail(ln.no, `'${kwTok.v}' requires a block`, kwTok.col, 'syntax');
    if (kw === 'enterprise') warn(S, ln.no, "'enterprise' is treated as a group");
    const base = m > kwi + 1 ? toks[kwi + 1]!.v : '';
    const name = groupRec ? groupRec.name + '/' + base : base;
    const rec: GroupRec = { name, startLine: ln.no, endLine: ln.endNo, owner: ctx ? ctx.id : null, outer: groupRec };
    S.groups.push(rec);
    S.stack.push({ t: 'group', rec });
    return;
  }

  const kind = KW_KIND[kw];
  if (kind !== undefined && kwTok.k === 'word') {
    if (CHILD_KINDS[ownerKind]!.indexOf(kind) === -1) {
      fail(ln.no, `'${kwTok.v}' cannot be defined inside ${ctx ? `a ${ownerKind}` : 'the model'}`, kwTok.col, 'syntax');
    }
    const node = createElement(S, ln, m, hasBlock, kind, ident, kwi, ctx, groupRec);
    if (hasBlock) S.stack.push({ t: 'node', node });
    return;
  }

  if (ctx && top.t === 'node') {
    nestedProperty(S, ln, m, hasBlock, ctx, kw);
    return;
  }
  if (kw === 'deploymentgroup' && ownerKind === 'deploymentEnvironment') {
    warn(S, ln.no, 'deploymentGroup ignored');
    return;
  }
  if (!ctx) {
    fail(ln.no, `Unknown element keyword '${kwTok.v}'`, kwTok.col, 'syntax');
  }
  warn(S, ln.no, `Unsupported statement '${kwTok.v}' ignored`);
  if (hasBlock) S.stack.push({ t: 'skip' });
}

function nestedProperty(S: State, ln: Line, m: number, hasBlock: boolean, node: Node, kw: string): void {
  const toks = ln.toks;
  const el = node.el;
  switch (kw) {
    case 'description':
      if (m >= 2) {
        el.description = toks[1]!.v;
        node.nested.description = ln;
      }
      return;
    case 'technology':
      if (m >= 2) {
        el.technology = toks[1]!.v;
        node.nested.technology = ln;
      }
      return;
    case 'tags': {
      for (let i = 1; i < m; i++) for (const t of splitTags(toks[i]!.v)) if (el.tags.indexOf(t) === -1) el.tags.push(t);
      node.nested.tags.push(ln);
      return;
    }
    case 'url':
      if (m >= 2) el.url = toks[1]!.v;
      return;
    case 'instances':
      if (m >= 2) el.instances = toks[1]!.v;
      return;
    case 'properties':
      if (hasBlock) {
        S.stack.push({ t: 'props', node });
        return;
      }
      break;
    case 'perspectives':
      if (hasBlock) {
        S.stack.push({ t: 'persp', node });
        return;
      }
      break;
    default:
      break;
  }
  warn(S, ln.no, `Unsupported statement '${toks[0]!.v}' ignored`);
  if (hasBlock) S.stack.push({ t: 'skip' });
}

function createElement(
  S: State,
  ln: Line,
  m: number,
  hasBlock: boolean,
  kind: ElementKind,
  ident: string | null,
  kwi: number,
  ctx: Node | null,
  grp: GroupRec | null,
): Node {
  const toks = ln.toks;
  for (let i = kwi + 1; i < m; i++) {
    const k = toks[i]!.k;
    if (k !== 'word' && k !== 'str') fail(ln.no, `Unexpected '${toks[i]!.v}'`, toks[i]!.col, 'syntax');
  }
  const a = valuesOf(toks, kwi + 1, m);
  let name = '';
  let description = '';
  let technology = '';
  let tagsStr = '';
  let instances: string | undefined;
  let refText: string | undefined;
  switch (kind) {
    case 'person':
    case 'softwareSystem':
      name = a[0] ?? '';
      description = a[1] ?? '';
      tagsStr = a[2] ?? '';
      break;
    case 'container':
    case 'component':
    case 'infrastructureNode':
      name = a[0] ?? '';
      description = a[1] ?? '';
      technology = a[2] ?? '';
      tagsStr = a[3] ?? '';
      break;
    case 'deploymentNode':
      name = a[0] ?? '';
      description = a[1] ?? '';
      technology = a[2] ?? '';
      tagsStr = a[3] ?? '';
      instances = a[4] || '1';
      break;
    case 'deploymentEnvironment':
      name = a[0] ?? '';
      break;
    case 'containerInstance':
    case 'softwareSystemInstance':
      refText = a[0] ?? '';
      tagsStr = a[2] ?? '';
      if (!refText) fail(ln.no, `Missing element reference for '${toks[kwi]!.v}'`, toks[kwi]!.col, 'syntax');
      break;
  }
  const isInstance = refText !== undefined;
  if (!isInstance && name === '') fail(ln.no, `Missing name for '${toks[kwi]!.v}'`, toks[kwi]!.col, 'syntax');

  if (ident !== null) {
    for (let i = 0; i < ident.length; i++) {
      const c = ident.charCodeAt(i);
      const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
      if (!ok) fail(ln.no, `Invalid identifier '${ident}'`, toks[0]!.col, 'syntax');
    }
    if (ident.indexOf('-') !== -1) warn(S, ln.no, `Identifier '${ident}' contains '-'`);
  }

  const segs = ctx ? ctx.segs : S.topSegs;
  let seg: string;
  if (ident !== null) {
    seg = ident;
  } else {
    const base = isInstance ? lastSegment(refText!) : lowerCamel(name) || 'unnamed';
    seg = '~' + base;
    for (let n = 2; segs.has(seg); n++) seg = '~' + base + n;
  }
  segs.add(seg);
  const id = ctx ? ctx.id + '.' + seg : seg;
  if (ident !== null) {
    if (S.byId.has(id)) fail(ln.no, `Duplicate identifier '${ident}'`, toks[0]!.col, 'syntax');
    if (S.identifiers === 'flat') {
      if (S.byIdent.has(ident)) fail(ln.no, `Duplicate identifier '${ident}'`, toks[0]!.col, 'syntax');
    }
    S.idents.add(ident);
  }

  const el: Element = {
    id,
    kind,
    name,
    description,
    technology,
    tags: splitTags(tagsStr),
    parent: ctx ? ctx.id : null,
    span: { startLine: ln.no, endLine: ln.endNo },
  };
  if (grp) el.group = grp.name;
  if (instances !== undefined) el.instances = instances;
  if (kind !== 'deploymentEnvironment' && ctx) {
    if (ctx.kind === 'deploymentEnvironment') el.environment = ctx.id;
    else if (ctx.el.environment) el.environment = ctx.el.environment;
  }
  const node: Node = {
    id,
    kind,
    ident,
    parent: ctx,
    el,
    children: [],
    order: S.nodes.length,
    hdr: ln,
    hasBlock,
    endLine: ln.endNo,
    nested: { tags: [] },
    segs: new Set(),
    isStatic: STATIC_KINDS.has(kind),
    grp,
  };
  if (isInstance) node.refText = refText;
  if (ident !== null && S.identifiers === 'flat') S.byIdent.set(ident, node);
  S.nodes.push(node);
  S.byId.set(id, node);
  if (ctx) ctx.children.push(node);
  return node;
}

function relationship(
  S: State,
  ln: Line,
  m: number,
  hasBlock: boolean,
  ai: number,
  ctx: Node | null,
  inGroup: boolean,
): void {
  const toks = ln.toks;
  let srcTok: Tok;
  let dstTok: Tok;
  let from: number;
  if (ai === 0) {
    if (!ctx) fail(ln.no, "A relationship without a source can only be used inside an element block", toks[0]!.col, 'syntax');
    srcTok = { k: 'word', v: 'this', ln: ln.no, col: toks[0]!.col, end: toks[0]!.col };
    if (m < 2) fail(ln.no, 'Missing relationship destination', toks[0]!.end, 'syntax');
    dstTok = toks[1]!;
    from = 2;
  } else {
    srcTok = toks[ai - 1]!;
    if (m <= ai + 1) fail(ln.no, 'Missing relationship destination', toks[ai]!.end, 'syntax');
    dstTok = toks[ai + 1]!;
    from = ai + 2;
  }
  for (let i = from; i < m; i++) {
    const k = toks[i]!.k;
    if (k !== 'str' && k !== 'word') fail(ln.no, `Unexpected '${toks[i]!.v}'`, toks[i]!.col, 'syntax');
  }
  const a = valuesOf(toks, from, m);
  const p: Pending = {
    src: srcTok.v,
    dst: dstTok.v,
    srcTok,
    dstTok,
    ctx,
    hdr: ln,
    hasBlock,
    endLine: ln.endNo,
    desc: a[0] ?? '',
    tech: a[1] ?? '',
    tags: a[2] ?? '',
    ident: ai === 3 ? toks[0]!.v : null,
    inGroup,
  };
  S.pending.push(p);
  if (hasBlock) {
    warn(S, ln.no, 'Relationship block contents ignored');
    S.stack.push({ t: 'relblock', p });
  }
}

// ---------------------------------------------------------------------------
// Views (statements only; resolution happens in views.ts)
// ---------------------------------------------------------------------------

const VIEW_KINDS: Record<string, ViewDraft['kind']> = {
  systemlandscape: 'systemLandscape',
  systemcontext: 'systemContext',
  container: 'container',
  component: 'component',
  dynamic: 'dynamic',
  deployment: 'deployment',
};

function viewsStatement(S: State, ln: Line, m: number, hasBlock: boolean, _top: Frame): void {
  const toks = ln.toks;
  const t0 = toks[0]!;
  const kw = t0.v.toLowerCase();
  if (kw.charCodeAt(0) === 33) {
    directive(S, ln, m, hasBlock);
    return;
  }
  const kind = VIEW_KINDS[kw];
  if (kind === undefined) {
    if (kw === 'filtered' || kw === 'image' || kw === 'custom') {
      warn(S, ln.no, `'${t0.v}' views are not supported and were skipped`);
    } else if (kw === 'styles' || kw === 'themes' || kw === 'theme' || kw === 'branding' || kw === 'terminology') {
      warn(S, ln.no, `'${t0.v}' is presentation-only and was ignored`);
    } else {
      warn(S, ln.no, `Unsupported views statement '${t0.v}' ignored`);
    }
    if (hasBlock) S.stack.push({ t: 'skip' });
    return;
  }
  for (let i = 1; i < m; i++) {
    const k = toks[i]!.k;
    if (k !== 'word' && k !== 'str') fail(ln.no, `Unexpected '${toks[i]!.v}'`, toks[i]!.col, 'syntax');
  }
  const a = valuesOf(toks, 1, m);
  const d: ViewDraft = { kind, key: '', description: '', line: ln.no, endLine: ln.endNo, stmts: [] };
  let ki: number;
  switch (kind) {
    case 'systemLandscape':
      ki = 0;
      break;
    case 'deployment':
      if (a.length < 2) fail(ln.no, "A deployment view needs a scope ('*' or a software system) and an environment", t0.col, 'syntax');
      d.scopeRef = a[0];
      d.envRef = a[1];
      ki = 2;
      break;
    default:
      if (a.length < 1) fail(ln.no, `A ${t0.v} view needs a scope`, t0.col, 'syntax');
      d.scopeRef = a[0];
      ki = 1;
  }
  d.description = a[ki + 1] ?? '';
  if (a[ki]) d.key = a[ki]!;
  else {
    d.key = `${kind}-${S.drafts.length + 1}`;
    warn(S, ln.no, `View has no key; generated '${d.key}'`);
  }
  if (!hasBlock) fail(ln.no, `A ${t0.v} view requires a block`, t0.col, 'syntax');
  S.drafts.push(d);
  S.stack.push({ t: 'view', d, top: true });
}

function viewStatement(S: State, ln: Line, m: number, hasBlock: boolean, top: Frame & { t: 'view' }): void {
  const toks = ln.toks;
  const d = top.d;
  const t0 = toks[0]!;
  const kw = t0.v.toLowerCase();
  if (t0.k === 'word' && kw.charCodeAt(0) === 33) {
    directive(S, ln, m, hasBlock);
    return;
  }
  if (d.kind === 'dynamic') {
    let from = 0;
    if (t0.k === 'word' && t0.v.charCodeAt(t0.v.length - 1) === 58 /* : */) from = 1;
    if (m - from >= 3 && toks[from + 1]!.k === 'arrow') {
      const body = toks.slice(from, m);
      d.stmts.push({ kind: 'step', line: ln.no, endLine: ln.endNo, toks: body, hdr: ln });
      if (hasBlock) S.stack.push({ t: 'skip' });
      return;
    }
  }
  switch (kw) {
    case 'include':
    case 'exclude':
      d.stmts.push({ kind: kw, line: ln.no, endLine: ln.endNo, toks: toks.slice(1, m), hdr: ln });
      if (hasBlock) S.stack.push({ t: 'skip' });
      return;
    case 'title':
      if (m >= 2) d.title = toks[1]!.v;
      return;
    case 'description':
      if (m >= 2) d.description = toks[1]!.v;
      return;
    case 'autolayout':
      warn(S, ln.no, 'autoLayout is presentation-only and was ignored');
      return;
    case 'animation':
      warn(S, ln.no, 'animation is presentation-only and was ignored');
      break;
    default:
      warn(S, ln.no, `Unsupported view statement '${t0.v}' ignored`);
  }
  if (hasBlock) S.stack.push({ t: 'skip' });
}

// ---------------------------------------------------------------------------
// Phase 2: references, relationships, implied relationships, instances, views
// ---------------------------------------------------------------------------

function buildSuffixIndex(S: State): Map<string, Node[]> {
  const idx = new Map<string, Node[]>();
  for (const n of S.nodes) {
    const id = n.id;
    let p = -1;
    for (;;) {
      const key = p === -1 ? id : id.slice(p + 1);
      const arr = idx.get(key);
      if (arr) arr.push(n);
      else idx.set(key, [n]);
      p = id.indexOf('.', p + 1);
      if (p === -1) break;
    }
  }
  return idx;
}

function lookup(S: State, ref: string, scope: Node | null): Node | undefined {
  S.ambiguous = false;
  if (S.identifiers === 'flat') {
    const n = S.byIdent.get(ref);
    if (n) return n;
  } else {
    for (let s = scope; s; s = s.parent) {
      const n = S.byId.get(s.id + '.' + ref);
      if (n) return n;
    }
  }
  const direct = S.byId.get(ref);
  if (direct) return direct;
  if (!S.suffixIdx) S.suffixIdx = buildSuffixIndex(S);
  const list = S.suffixIdx.get(ref);
  if (list) {
    if (list.length === 1) return list[0];
    S.ambiguous = true;
  }
  return undefined;
}

function isAncestorOrSelf(a: Node, b: Node): boolean {
  for (let n: Node | null = b; n; n = n.parent) if (n === a) return true;
  return false;
}

function finish(S: State, content: Uint8Array, lineCount: number): { workspace: Workspace; map: SourceMap } {
  const rels: Relationship[] = [];
  const relRecs: RelRec[] = [];
  const relById = new Map<string, Relationship>();
  const out = new Map<string, Relationship[]>();
  const inc = new Map<string, Relationship[]>();
  const pair = new Set<string>();

  const index = (r: Relationship): void => {
    rels.push(r);
    relById.set(r.id, r);
    pair.add(r.source + '\n' + r.destination);
    let o = out.get(r.source);
    if (!o) out.set(r.source, (o = []));
    o.push(r);
    let i = inc.get(r.destination);
    if (!i) inc.set(r.destination, (i = []));
    i.push(r);
  };

  // instances
  for (const n of S.nodes) {
    if (n.refText === undefined) continue;
    const target = lookup(S, n.refText, n.parent);
    if (!target) {
      fail(
        n.hdr.no,
        S.ambiguous ? `Ambiguous reference '${n.refText}'` : `Unknown element '${n.refText}'`,
        undefined,
        'unknown-reference',
      );
    }
    const want: ElementKind = n.kind === 'containerInstance' ? 'container' : 'softwareSystem';
    if (target.kind !== want) fail(n.hdr.no, `'${n.refText}' is not a ${want}`, undefined, 'syntax');
    n.el.instanceOf = target.id;
    n.el.name = target.el.name;
    n.el.description = target.el.description;
    n.el.technology = target.el.technology;
  }

  // explicit relationships and their implied relationships
  for (const p of S.pending) {
    const resolveEnd = (ref: string, tok: Tok): Node => {
      if (ref === 'this') {
        if (!p.ctx) fail(p.hdr.no, "'this' can only be used inside an element block", tok.col, 'syntax');
        return p.ctx;
      }
      const n = lookup(S, ref, p.ctx);
      if (!n) {
        fail(
          p.hdr.no,
          S.ambiguous ? `Ambiguous reference '${ref}'` : `Unknown element '${ref}'`,
          tok.col,
          'unknown-reference',
        );
      }
      return n;
    };
    const src = resolveEnd(p.src, p.srcTok);
    const dst = resolveEnd(p.dst, p.dstTok);
    const id = `${src.id}->${dst.id}|${p.desc}`;
    if (relById.has(id)) {
      fail(p.hdr.no, `Duplicate relationship from '${src.id}' to '${dst.id}' with description '${p.desc}'`, p.srcTok.col, 'syntax');
    }
    const rel: Relationship = {
      id,
      source: src.id,
      destination: dst.id,
      description: p.desc,
      technology: p.tech,
      tags: splitTags(p.tags),
      implied: false,
      span: { startLine: p.hdr.no, endLine: p.endLine },
    };
    index(rel);
    relRecs.push({
      rel,
      hdr: p.hdr,
      hasBlock: p.hasBlock,
      srcTok: p.srcTok,
      dstTok: p.dstTok,
      ident: p.ident,
      owner: p.ctx ? p.ctx.id : null,
      inGroup: p.inGroup,
    });

    if (!src.isStatic || !dst.isStatic) continue;
    if (src !== dst && (isAncestorOrSelf(src, dst) || isAncestorOrSelf(dst, src))) {
      warn(S, p.hdr.no, `Relationship between '${src.id}' and its ancestor or descendant '${dst.id}' creates no implied relationships`);
      continue;
    }
    for (let s: Node | null = src; s; s = s.parent) {
      for (let d: Node | null = dst; d; d = d.parent) {
        if (s === src && d === dst) continue;
        if (s === d) continue;
        if (isAncestorOrSelf(s, d) || isAncestorOrSelf(d, s)) continue;
        if (pair.has(s.id + '\n' + d.id)) continue;
        index({
          id: `${s.id}->${d.id}|${p.desc}`,
          source: s.id,
          destination: d.id,
          description: p.desc,
          technology: p.tech,
          tags: rel.tags.slice(),
          implied: true,
          impliedFrom: id,
        });
      }
    }
  }

  // relationships between deployment instances
  const instancesOf = new Map<string, Node[]>();
  for (const n of S.nodes) {
    const of = n.el.instanceOf;
    if (of === undefined) continue;
    let arr = instancesOf.get(of);
    if (!arr) instancesOf.set(of, (arr = []));
    arr.push(n);
  }
  if (instancesOf.size > 0) {
    for (const a of S.nodes) {
      const of = a.el.instanceOf;
      if (of === undefined) continue;
      const outs = out.get(of);
      if (!outs) continue;
      for (const r of outs) {
        const targets = instancesOf.get(r.destination);
        if (!targets) continue;
        for (const b of targets) {
          if (a === b || a.el.environment !== b.el.environment) continue;
          const id = `${a.id}->${b.id}|${r.description}`;
          if (relById.has(id)) continue;
          index({
            id,
            source: a.id,
            destination: b.id,
            description: r.description,
            technology: r.technology,
            tags: r.tags.slice(),
            implied: true,
            impliedFrom: r.id,
          });
        }
      }
    }
  }

  // views
  const viewRefs: ViewRefInfo[] = [];
  const views = resolveViews(
    {
      nodes: S.nodes,
      byId: S.byId,
      rels,
      out,
      inc,
      lookup: (ref, scope) => lookup(S, ref, scope),
      wasAmbiguous: () => S.ambiguous,
      warn: (line, msg) => warn(S, line, msg),
      fail,
      extended: S.extended,
    },
    S.drafts,
    viewRefs,
  );

  const workspace: Workspace = {
    name: S.name,
    description: S.description,
    identifiers: S.identifiers,
    properties: S.properties,
    configuration: S.scope ? { scope: S.scope } : {},
    elements: S.nodes.map((n) => n.el),
    relationships: rels,
    views,
    warnings: S.warnings,
  };
  const map: SourceMap = {
    nodes: S.nodes,
    byId: S.byId,
    groups: S.groups,
    rels: relRecs,
    modelBlock: S.modelBlock,
    viewsBlock: S.viewsBlock,
    viewRefs,
    viewDrafts: S.drafts,
    idents: S.idents,
    content,
    lineCount,
  };
  return { workspace, map };
}
