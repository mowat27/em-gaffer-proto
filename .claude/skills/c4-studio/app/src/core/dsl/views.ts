// View resolution: turns ViewDrafts into Views with resolved element and relationship ids.
import type { ElementKind, Relationship, View, DynamicStep } from '../../shared/types.ts';
import type { InternalParseError, Node, ViewDraft, ViewRefInfo, ViewStmt } from './ast.ts';
import type { Tok } from './tokenize.ts';

export interface ViewEnv {
  nodes: Node[];
  byId: Map<string, Node>;
  rels: Relationship[];
  out: Map<string, Relationship[]>;
  inc: Map<string, Relationship[]>;
  lookup(ref: string, scope: Node | null): Node | undefined;
  wasAmbiguous(): boolean;
  warn(line: number, message: string): void;
  fail(line: number, message: string, column?: number, code?: InternalParseError['code']): never;
  extended: boolean;
}

const DEPLOYMENT_KINDS = new Set<ElementKind>(['deploymentNode', 'infrastructureNode', 'containerInstance', 'softwareSystemInstance']);

const TYPE_TAGS: Record<ElementKind, string[]> = {
  person: ['Element', 'Person'],
  softwareSystem: ['Element', 'Software System'],
  container: ['Element', 'Container'],
  component: ['Element', 'Component'],
  deploymentEnvironment: [],
  deploymentNode: ['Element', 'Deployment Node'],
  infrastructureNode: ['Element', 'Infrastructure Node'],
  containerInstance: ['Container Instance'],
  softwareSystemInstance: ['Software System Instance'],
};

const TYPE_NAMES: Record<ElementKind, string> = {
  person: 'Person',
  softwareSystem: 'SoftwareSystem',
  container: 'Container',
  component: 'Component',
  deploymentEnvironment: 'DeploymentEnvironment',
  deploymentNode: 'DeploymentNode',
  infrastructureNode: 'InfrastructureNode',
  containerInstance: 'ContainerInstance',
  softwareSystemInstance: 'SoftwareSystemInstance',
};

function hasTag(n: Node, tag: string): boolean {
  return n.el.tags.indexOf(tag) !== -1 || TYPE_TAGS[n.kind].indexOf(tag) !== -1;
}

interface Expr {
  text: string;
  /** Tokens making up the expression (for source positions) */
  toks: Tok[];
}

/** Split statement tokens into expressions. `a -> b` pairs are kept as one expression with an arrow token. */
function exprsOf(toks: Tok[]): Expr[] {
  const out: Expr[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i]!;
    if (toks[i + 1] && toks[i + 1]!.k === 'arrow' && toks[i + 2]) {
      out.push({ text: t.v + ' -> ' + toks[i + 2]!.v, toks: [t, toks[i + 1]!, toks[i + 2]!] });
      i += 3;
      continue;
    }
    if (t.k === 'arrow') {
      // `-> a ->` written with spaces
      const parts: Tok[] = [t];
      let text = '->';
      let j = i + 1;
      if (toks[j] && toks[j]!.k !== 'arrow') {
        parts.push(toks[j]!);
        text += toks[j]!.v;
        j++;
      }
      if (toks[j] && toks[j]!.k === 'arrow') {
        parts.push(toks[j]!);
        text += '->';
        j++;
      }
      out.push({ text, toks: parts });
      i = j;
      continue;
    }
    const v = t.v;
    const isPrefixed = t.k === 'word' && (v.startsWith('element.') || v.startsWith('relationship.'));
    if (isPrefixed && v.indexOf('==') === -1 && v.indexOf('!=') === -1) {
      // `element.tag == X` written with spaces
      const parts: Tok[] = [t];
      let text = v;
      let j = i + 1;
      while (j < toks.length && (text.indexOf('==') === -1 && text.indexOf('!=') === -1)) {
        parts.push(toks[j]!);
        text += toks[j]!.v;
        j++;
      }
      if (j < toks.length && (text.endsWith('==') || text.endsWith('!='))) {
        parts.push(toks[j]!);
        text += toks[j]!.v;
        j++;
      }
      out.push({ text, toks: parts });
      i = j;
      continue;
    }
    if (isPrefixed && (v.endsWith('==') || v.endsWith('!=')) && toks[i + 1]) {
      out.push({ text: v + toks[i + 1]!.v, toks: [t, toks[i + 1]!] });
      i += 2;
      continue;
    }
    out.push({ text: v, toks: [t] });
    i++;
  }
  return out;
}

export function resolveViews(env: ViewEnv, drafts: ViewDraft[], viewRefs: ViewRefInfo[]): View[] {
  const views: View[] = [];
  const keys = new Set<string>();
  for (const d of drafts) {
    if (keys.has(d.key)) env.fail(d.line, `Duplicate view key '${d.key}'`, undefined, 'syntax');
    const v = buildView(env, d, viewRefs);
    if (v) {
      keys.add(d.key);
      views.push(v);
    }
  }
  return views;
}

function unknownRef(env: ViewEnv, line: number, ref: string, col?: number): never {
  return env.fail(line, env.wasAmbiguous() ? `Ambiguous reference '${ref}'` : `Unknown element '${ref}'`, col, 'unknown-reference');
}

function buildView(env: ViewEnv, d: ViewDraft, viewRefs: ViewRefInfo[]): View | null {
  let scope: Node | undefined;
  let envNode: Node | undefined;
  if (d.scopeRef !== undefined && d.scopeRef !== '*') {
    scope = env.lookup(d.scopeRef, null);
    if (!scope) {
      if (env.extended) {
        env.warn(d.line, `View '${d.key}' skipped: unknown scope '${d.scopeRef}' (workspace extends another file)`);
        return null;
      }
      unknownRef(env, d.line, d.scopeRef);
    }
    const want: ElementKind | null =
      d.kind === 'systemContext' || d.kind === 'container' || d.kind === 'deployment'
        ? 'softwareSystem'
        : d.kind === 'component'
          ? 'container'
          : null;
    if (want && scope.kind !== want) env.fail(d.line, `The scope of a ${d.kind} view must be a ${want}`, undefined, 'syntax');
    if (d.kind === 'dynamic' && scope.kind !== 'softwareSystem' && scope.kind !== 'container') {
      env.fail(d.line, 'The scope of a dynamic view must be a software system or a container', undefined, 'syntax');
    }
  } else if (d.scopeRef === '*') {
    if (d.kind === 'systemContext' || d.kind === 'container' || d.kind === 'component') {
      env.fail(d.line, `A ${d.kind} view needs a scope element`, undefined, 'syntax');
    }
  }
  if (d.kind === 'deployment') {
    const ref = d.envRef!;
    envNode = env.lookup(ref, null);
    if (!envNode || envNode.kind !== 'deploymentEnvironment') {
      envNode = undefined;
      for (const n of env.nodes) {
        if (n.kind === 'deploymentEnvironment' && (n.el.name === ref || n.id === '~' + ref)) {
          envNode = n;
          break;
        }
      }
    }
    if (!envNode) {
      if (env.extended) {
        env.warn(d.line, `View '${d.key}' skipped: unknown environment '${ref}'`);
        return null;
      }
      unknownRef(env, d.line, ref);
    }
  }
  if (d.scopeRef === '*' && env.extended && d.kind !== 'dynamic' && d.kind !== 'deployment') return null;

  const base: View = {
    key: d.key,
    kind: d.kind,
    description: d.description,
    elements: [],
    relationships: [],
    span: { startLine: d.line, endLine: d.endLine },
  };
  if (scope) base.scope = scope.id;
  if (envNode) base.environment = envNode.id;
  if (d.title !== undefined) base.title = d.title;

  if (d.kind === 'dynamic') return buildDynamic(env, d, base, viewRefs);
  return buildStatic(env, d, base, scope, envNode, viewRefs);
}

// ---------------------------------------------------------------------------
// Dynamic views
// ---------------------------------------------------------------------------

function buildDynamic(env: ViewEnv, d: ViewDraft, base: View, viewRefs: ViewRefInfo[]): View {
  const steps: DynamicStep[] = [];
  const elements: string[] = [];
  const seenEl = new Set<string>();
  const rels: string[] = [];
  const seenRel = new Set<string>();
  for (const st of d.stmts) {
    if (st.kind !== 'step') {
      env.warn(st.line, `'${st.kind}' has no effect in a dynamic view`);
      continue;
    }
    const t = st.toks;
    const sTok = t[0]!;
    const dTok = t[2]!;
    const s = env.lookup(sTok.v, null);
    if (!s) unknownRef(env, st.line, sTok.v, sTok.col);
    const dn = env.lookup(dTok.v, null);
    if (!dn) unknownRef(env, st.line, dTok.v, dTok.col);
    const desc = t[3] ? t[3].v : undefined;
    const tech = t[4] ? t[4].v : undefined;
    const cands = (env.out.get(s.id) ?? []).filter((r) => r.destination === dn.id);
    if (cands.length === 0) {
      env.fail(
        st.line,
        `No relationship from '${s.id}' to '${dn.id}' for this dynamic view step`,
        sTok.col,
        'step-no-relationship',
      );
    }
    let rel = cands[0]!;
    if (desc !== undefined) for (const c of cands) if (c.description === desc) rel = c;
    steps.push({
      order: steps.length + 1,
      relationship: rel.id,
      source: s.id,
      destination: dn.id,
      description: desc ?? rel.description,
      technology: tech ?? rel.technology,
    });
    for (const id of [s.id, dn.id]) {
      if (!seenEl.has(id)) {
        seenEl.add(id);
        elements.push(id);
      }
    }
    if (!seenRel.has(rel.id)) {
      seenRel.add(rel.id);
      rels.push(rel.id);
    }
    viewRefs.push({
      viewKey: d.key,
      kind: 'step',
      line: st.line,
      endLine: st.endLine,
      hdr: st.hdr,
      exprs: [{ ln: st.line, col: sTok.col, end: t[t.length - 1]!.end, ids: [s.id, dn.id], killLine: true }],
    });
  }
  base.elements = elements;
  base.relationships = rels;
  base.steps = steps;
  return base;
}

// ---------------------------------------------------------------------------
// Static and deployment views
// ---------------------------------------------------------------------------

function buildStatic(
  env: ViewEnv,
  d: ViewDraft,
  base: View,
  scope: Node | undefined,
  envNode: Node | undefined,
  viewRefs: ViewRefInfo[],
): View {
  const set = new Set<Node>();
  const relExclusions: ((r: Relationship) => boolean)[] = [];

  const canShow = (n: Node): boolean => {
    switch (d.kind) {
      case 'systemLandscape':
      case 'systemContext':
        return n.kind === 'person' || n.kind === 'softwareSystem';
      case 'container':
        if (n.kind === 'person' || n.kind === 'container') return true;
        return n.kind === 'softwareSystem' && n !== scope;
      case 'component':
        if (n.kind === 'person' || n.kind === 'container' || n.kind === 'component') return n !== scope;
        return n.kind === 'softwareSystem' && n !== scope?.parent;
      case 'deployment':
        return DEPLOYMENT_KINDS.has(n.kind) && n.el.environment === envNode!.id;
      default:
        return false;
    }
  };

  /** Drop elements that have a descendant in the set (boundary-only parents) */
  const dropAncestors = (items: Set<Node>): void => {
    const drop = new Set<Node>();
    for (const n of items) for (let p = n.parent; p; p = p.parent) if (items.has(p)) drop.add(p);
    for (const n of drop) items.delete(n);
  };

  const defaultSet = (): Set<Node> => {
    const res = new Set<Node>();
    switch (d.kind) {
      case 'systemLandscape':
        for (const n of env.nodes) if (n.kind === 'person' || n.kind === 'softwareSystem') res.add(n);
        break;
      case 'systemContext': {
        res.add(scope!);
        const consider = (id: string): void => {
          const o = env.byId.get(id);
          if (o && o !== scope && canShow(o)) res.add(o);
        };
        for (const r of env.out.get(scope!.id) ?? []) consider(r.destination);
        for (const r of env.inc.get(scope!.id) ?? []) consider(r.source);
        break;
      }
      case 'container':
      case 'component': {
        const baseKind: ElementKind = d.kind === 'container' ? 'container' : 'component';
        const own = scope!.children.filter((c) => c.kind === baseKind);
        const ownSet = new Set(own);
        for (const c of own) res.add(c);
        for (const c of own) {
          for (const r of env.out.get(c.id) ?? []) {
            const o = env.byId.get(r.destination);
            if (o && !ownSet.has(o) && canShow(o)) res.add(o);
          }
          for (const r of env.inc.get(c.id) ?? []) {
            const o = env.byId.get(r.source);
            if (o && !ownSet.has(o) && canShow(o)) res.add(o);
          }
        }
        dropAncestors(res);
        break;
      }
      case 'deployment': {
        for (const n of env.nodes) {
          if (!canShow(n)) continue;
          if (n.kind === 'containerInstance' && scope) {
            const target = env.byId.get(n.el.instanceOf ?? '');
            if (!target || target.parent !== scope) continue;
          }
          res.add(n);
        }
        break;
      }
    }
    return res;
  };

  const addNode = (n: Node): void => {
    set.add(n);
    if (d.kind === 'deployment') for (let p = n.parent; p && p.kind !== 'deploymentEnvironment'; p = p.parent) set.add(p);
  };

  const refInfo: ViewRefInfo[] = [];

  for (const st of d.stmts) {
    if (st.kind === 'step') {
      env.warn(st.line, 'Relationship steps are only meaningful in dynamic views');
      continue;
    }
    const info: ViewRefInfo = { viewKey: d.key, kind: st.kind, line: st.line, endLine: st.endLine, hdr: st.hdr, exprs: [] };
    for (const ex of exprsOf(st.toks)) {
      const t0 = ex.toks[0]!;
      const last = ex.toks[ex.toks.length - 1]!;
      const rec = { ln: t0.ln, col: t0.col, end: last.end, ids: [] as string[], killLine: false };
      info.exprs.push(rec);
      evalExpr(st, ex, rec);
    }
    refInfo.push(info);
  }

  function resolveRef(st: ViewStmt, ref: string, tok: Tok): Node | undefined {
    const n = env.lookup(ref, null);
    if (!n) {
      if (env.extended) return undefined;
      unknownRef(env, st.line, ref, tok.col);
    }
    return n;
  }

  function evalExpr(st: ViewStmt, ex: Expr, rec: { ids: string[]; killLine: boolean }): void {
    const text = ex.text.trim();
    const include = st.kind === 'include';
    // relationship patterns `a -> b`
    if (ex.toks.length === 3 && ex.toks[1]!.k === 'arrow') {
      const a = ex.toks[0]!;
      const b = ex.toks[2]!;
      if (include) {
        env.warn(st.line, `'include ${text}' is not supported and was ignored`);
        return;
      }
      const sa = a.v === '*' ? null : resolveRef(st, a.v, a);
      const sb = b.v === '*' ? null : resolveRef(st, b.v, b);
      if (sa) rec.ids.push(sa.id);
      if (sb) rec.ids.push(sb.id);
      rec.killLine = true;
      relExclusions.push((r) => (!sa || r.source === sa.id) && (!sb || r.destination === sb.id));
      return;
    }
    if (text === '*') {
      if (include) for (const n of defaultSet()) set.add(n);
      else set.clear();
      return;
    }
    if (text.startsWith('relationship')) {
      const m = /^relationship(?:\.tag)?\s*(==|!=)\s*(.*)$/.exec(text);
      if (!m || include) {
        env.warn(st.line, `Unsupported expression '${text}' ignored`);
        return;
      }
      const eq = m[1] === '==';
      const want = m[2]!.split(',').map((s) => s.trim());
      if (text.startsWith('relationship==') && m[2] === '*') {
        relExclusions.push(() => true);
        return;
      }
      relExclusions.push((r) => {
        const has = want.every((t) => r.tags.indexOf(t) !== -1);
        return eq ? has : !has;
      });
      return;
    }
    if (text.startsWith('element.')) {
      const m = /^element\.([A-Za-z]+)\s*(==|!=)\s*(.*)$/.exec(text);
      if (!m) {
        env.warn(st.line, `Unsupported expression '${text}' ignored`);
        return;
      }
      const prop = m[1]!;
      const eq = m[2] === '==';
      const val = m[3]!.trim();
      let pred: ((n: Node) => boolean) | null = null;
      if (prop === 'tag') {
        const want = val.split(',').map((s) => s.trim());
        pred = (n) => want.every((t) => hasTag(n, t));
      } else if (prop === 'group') {
        pred = (n) => n.el.group === val;
      } else if (prop === 'type') {
        pred = (n) => TYPE_NAMES[n.kind].toLowerCase() === val.toLowerCase();
      } else if (prop === 'parent') {
        const p = env.lookup(val, null);
        pred = (n) => !!p && n.parent === p;
      }
      if (!pred) {
        env.warn(st.line, `Unsupported expression '${text}' ignored`);
        return;
      }
      const p2 = pred;
      const test = (n: Node): boolean => (eq ? p2(n) : !p2(n));
      if (include) {
        for (const n of env.nodes) if (canShow(n) && test(n)) addNode(n);
      } else {
        for (const n of [...set]) if (test(n)) set.delete(n);
      }
      return;
    }
    // reachability forms `->a`, `a->`, `->a->`
    const incoming = text.startsWith('->');
    const outgoing = text.endsWith('->') && text.length > 2;
    if (incoming || outgoing) {
      let ref = text;
      if (incoming) ref = ref.slice(2);
      if (outgoing && ref.endsWith('->')) ref = ref.slice(0, -2);
      const n = resolveRef(st, ref, ex.toks[0]!);
      if (!n) return;
      rec.ids.push(n.id);
      if (!include) {
        const rm = new Set<Node>();
        rm.add(n);
        if (incoming) for (const r of env.inc.get(n.id) ?? []) addIf(rm, r.source);
        if (outgoing) for (const r of env.out.get(n.id) ?? []) addIf(rm, r.destination);
        for (const x of rm) set.delete(x);
        return;
      }
      if (canShow(n)) addNode(n);
      if (incoming) for (const r of env.inc.get(n.id) ?? []) addIfShown(r.source);
      if (outgoing) for (const r of env.out.get(n.id) ?? []) addIfShown(r.destination);
      return;
    }
    // plain element reference
    const n = resolveRef(st, text, ex.toks[0]!);
    if (!n) return;
    rec.ids.push(n.id);
    if (include) {
      if (canShow(n)) addNode(n);
      else env.warn(st.line, `'${n.id}' cannot be shown in a ${d.kind} view and was ignored`);
    } else {
      set.delete(n);
    }
  }

  function addIf(into: Set<Node>, id: string): void {
    const o = env.byId.get(id);
    if (o) into.add(o);
  }
  function addIfShown(id: string): void {
    const o = env.byId.get(id);
    if (o && canShow(o)) addNode(o);
  }

  const ordered = [...set].sort((a, b) => a.order - b.order);
  const ids = new Set<string>();
  for (const n of ordered) ids.add(n.id);
  const rels: string[] = [];
  for (const r of env.rels) {
    if (!ids.has(r.source) || !ids.has(r.destination)) continue;
    let ex = false;
    for (const f of relExclusions) {
      if (f(r)) {
        ex = true;
        break;
      }
    }
    if (!ex) rels.push(r.id);
  }
  base.elements = ordered.map((n) => n.id);
  base.relationships = rels;
  for (const r of refInfo) viewRefs.push(r);
  return base;
}
