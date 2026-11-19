import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyEdits, generateIdentifier, parseWorkspace } from '../../src/core/dsl/index.ts';
import type { EditOp, Workspace } from '../../src/shared/types.ts';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
const EXAMPLE = fixture('example.dsl');
const ORACLE = JSON.parse(fixture('example.structurizr.json'));

function parseOk(text: string): Workspace {
  const r = parseWorkspace(text);
  if (!r.ok) throw new Error(`parse failed at line ${r.error.line}: ${r.error.message}`);
  return r.workspace;
}

function parseErr(text: string): { line: number; message: string } {
  const r = parseWorkspace(text);
  if (r.ok) throw new Error('expected a parse error');
  return r.error;
}

/** workspace wrapper: line 1 `workspace`, line 2 `model {`, model lines from line 3 */
const wrap = (model: string, views = ''): string =>
  `workspace "T" "d" {\n    model {\n${model}\n    }\n${views ? `    views {\n${views}\n    }\n` : ''}}\n`;

// ---------------------------------------------------------------------------
// Oracle (Structurizr CLI JSON export)
// ---------------------------------------------------------------------------

interface OracleRel {
  id: string;
  sourceId: string;
  destinationId: string;
  description: string;
  linkedRelationshipId?: string;
}

const oracleNames = new Map<string, string>();
const oracleRels: OracleRel[] = [];
const oracleElementKinds = new Map<string, string>();
(function loadOracle() {
  const rawById = new Map<string, any>();
  const walk = (e: any, kind: string): void => {
    rawById.set(e.id, e);
    oracleElementKinds.set(e.id, kind);
    for (const r of e.relationships ?? []) oracleRels.push(r);
    for (const c of e.containers ?? []) walk(c, 'container');
    for (const c of e.components ?? []) walk(c, 'component');
    for (const c of e.children ?? []) walk(c, 'deploymentNode');
    for (const c of e.infrastructureNodes ?? []) walk(c, 'infrastructureNode');
    for (const c of e.containerInstances ?? []) walk(c, 'containerInstance');
    for (const c of e.softwareSystemInstances ?? []) walk(c, 'softwareSystemInstance');
  };
  for (const p of ORACLE.model.people ?? []) walk(p, 'person');
  for (const s of ORACLE.model.softwareSystems ?? []) walk(s, 'softwareSystem');
  for (const d of ORACLE.model.deploymentNodes ?? []) walk(d, 'deploymentNode');
  for (const [id, e] of rawById) {
    if (e.name) oracleNames.set(id, e.name);
    else if (e.containerId) oracleNames.set(id, rawById.get(e.containerId).name);
    else if (e.softwareSystemId) oracleNames.set(id, rawById.get(e.softwareSystemId).name);
  }
})();

const oname = (id: string): string => oracleNames.get(id) ?? `?${id}`;
const orelKey = (r: OracleRel): string => `${oname(r.sourceId)}->${oname(r.destinationId)}|${r.description}`;

function oracleViews(): { key: string; elements: string[]; relKeys: string[]; steps?: string[] }[] {
  const out: { key: string; elements: string[]; relKeys: string[]; steps?: string[] }[] = [];
  const byRel = new Map(oracleRels.map((r) => [r.id, r]));
  for (const group of Object.values(ORACLE.views) as any[]) {
    if (!Array.isArray(group)) continue;
    for (const v of group) {
      const relKeys = (v.relationships ?? []).map((r: any) => orelKey(byRel.get(r.id)!));
      const steps = v.relationships?.[0]?.order
        ? v.relationships
            .slice()
            .sort((a: any, b: any) => Number(a.order) - Number(b.order))
            .map((r: any) => {
              const rel = byRel.get(r.id)!;
              return `${oname(rel.sourceId)}->${oname(rel.destinationId)}|${r.description}`;
            })
        : undefined;
      out.push({ key: v.key, elements: v.elements.map((e: any) => oname(e.id)), relKeys, steps });
    }
  }
  return out;
}

describe('example.dsl against the Structurizr oracle', () => {
  const ws = parseOk(EXAMPLE);
  const nameOf = (id: string): string => ws.elements.find((e) => e.id === id)!.name;
  const relKey = (id: string): string => {
    const r = ws.relationships.find((x) => x.id === id)!;
    return `${nameOf(r.source)}->${nameOf(r.destination)}|${r.description}`;
  };

  it('parses with no warnings', () => {
    expect(ws.name).toBe('Internet Banking');
    expect(ws.identifiers).toBe('hierarchical');
    expect(ws.configuration.scope).toBe('softwaresystem');
    expect(ws.warnings).toEqual([]);
    expect(Object.keys(ws.properties).length).toBe(8);
  });

  it('has the same static elements as the oracle', () => {
    const ours = ws.elements
      .filter((e) => ['person', 'softwareSystem', 'container', 'component'].includes(e.kind))
      .map((e) => `${e.kind}:${e.name}`)
      .sort();
    const theirs = [...oracleElementKinds]
      .filter(([, k]) => ['person', 'softwareSystem', 'container', 'component'].includes(k))
      .map(([id, k]) => `${k}:${oname(id)}`)
      .sort();
    expect(ours).toEqual(theirs);
  });

  for (const ov of oracleViews()) {
    it(`view ${ov.key} matches the oracle`, () => {
      const v = ws.views.find((x) => x.key === ov.key);
      expect(v, `view ${ov.key} exists`).toBeDefined();
      expect(v!.elements.map(nameOf).sort()).toEqual([...ov.elements].sort());
      expect(v!.relationships.map(relKey).sort()).toEqual([...ov.relKeys].sort());
      if (ov.steps) {
        expect(v!.steps!.map((s) => `${nameOf(s.source)}->${nameOf(s.destination)}|${s.description}`)).toEqual(ov.steps);
      }
    });
  }

  it('has exactly the oracle views', () => {
    expect(ws.views.map((v) => v.key).sort()).toEqual(oracleViews().map((v) => v.key).sort());
  });

  it('explicit and implied relationships match the oracle', () => {
    const oExplicit = oracleRels.filter((r) => !r.linkedRelationshipId).map(orelKey).sort();
    const oImplied = oracleRels.filter((r) => r.linkedRelationshipId).map(orelKey).sort();
    expect(ws.relationships.filter((r) => !r.implied).map((r) => relKey(r.id)).sort()).toEqual(oExplicit);
    expect(ws.relationships.filter((r) => r.implied).map((r) => relKey(r.id)).sort()).toEqual(oImplied);
  });

  it('records where each implied relationship came from', () => {
    const byOracleId = new Map(oracleRels.map((r) => [r.id, r]));
    const oLinks = oracleRels
      .filter((r) => r.linkedRelationshipId)
      .map((r) => `${orelKey(r)} <= ${orelKey(byOracleId.get(r.linkedRelationshipId!)!)}`)
      .sort();
    const links = ws.relationships
      .filter((r) => r.implied)
      .map((r) => `${relKey(r.id)} <= ${relKey(r.impliedFrom!)}`)
      .sort();
    expect(links).toEqual(oLinks);
  });

  it('builds canonical ids and synthetic ids', () => {
    const ids = new Set(ws.elements.map((e) => e.id));
    for (const id of [
      'customer',
      'banking',
      'banking.api',
      'banking.api.signIn',
      'live',
      'live.~customersComputer',
      'live.~customersComputer.~webBrowser',
      'live.~customersComputer.~webBrowser.~spa',
      'live.aws.region.lb',
      'live.aws.region.ecs.apiInstance',
      'live.aws.region.rds.~db',
      'live.~bankDataCentre.~mainframe',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    const inst = ws.elements.find((e) => e.id === 'live.aws.region.ecs.apiInstance')!;
    expect(inst.instanceOf).toBe('banking.api');
    expect(inst.environment).toBe('live');
    expect(ws.elements.find((e) => e.id === 'live.aws.region.ecs')!.instances).toBe('2..4');
    expect(ws.elements.find((e) => e.id === 'banking.spa')!.tags).toEqual(['Web Browser']);
  });

  it('spa -> api.signIn does not create spa -> api and nothing links an element to its ancestor', () => {
    const spaApi = ws.relationships.filter((r) => r.source === 'banking.spa' && r.destination === 'banking.api');
    expect(spaApi.length).toBe(1);
    expect(spaApi[0]!.implied).toBe(false);
    for (const r of ws.relationships) {
      if (r.source.startsWith('live') || r.destination.startsWith('live')) continue;
      expect(r.destination.startsWith(r.source + '.')).toBe(false);
      expect(r.source.startsWith(r.destination + '.')).toBe(false);
    }
  });

  it('carries accurate spans', () => {
    const lines = EXAMPLE.split('\n');
    const api = ws.elements.find((e) => e.id === 'banking.api')!;
    expect(lines[api.span.startLine - 1]).toContain('api = container');
    expect(lines[api.span.endLine - 1].trim()).toBe('}');
    const spa = ws.elements.find((e) => e.id === 'banking.spa')!;
    expect(spa.span.startLine).toBe(spa.span.endLine);
    const rel = ws.relationships.find((r) => r.id.startsWith('banking.spa->banking.api.signIn'))!;
    expect(lines[rel.span!.startLine - 1]).toContain('spa -> api.signIn');
    const dyn = ws.views.find((v) => v.key === 'dynamic-sign-in')!;
    expect(lines[dyn.span.startLine - 1]).toContain('dynamic banking.api');
    expect(lines[dyn.span.endLine - 1].trim()).toBe('}');
    expect(ws.relationships.filter((r) => r.implied).every((r) => r.span === undefined)).toBe(true);
  });

  it('parses in under 20 ms after warm-up', () => {
    for (let i = 0; i < 50; i++) parseWorkspace(EXAMPLE);
    let best = Infinity;
    for (let i = 0; i < 20; i++) {
      const r = parseWorkspace(EXAMPLE);
      best = Math.min(best, r.parseMs);
    }
    expect(best).toBeLessThan(20);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) parseWorkspace(EXAMPLE);
    expect((performance.now() - t0) / 100).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Errors and warnings
// ---------------------------------------------------------------------------

describe('parse errors', () => {
  it('reports an unclosed brace at the line that opened it', () => {
    const e = parseErr('workspace "x" {\n    model {\n        a = person "A"\n');
    expect(e.line).toBe(2);
    expect(e.message).toMatch(/Unclosed/);
  });

  it('reports a stray closing brace', () => {
    const e = parseErr(wrap('        a = person "A"\n    }\n    }'));
    expect(e.line).toBe(6);
    expect(e.message).toMatch(/Unexpected/);
  });

  it('reports an undefined identifier in a relationship', () => {
    const e = parseErr(wrap('        a = person "A"\n        a -> nope "uses"'));
    expect(e.line).toBe(4);
    expect(e.message).toContain("Unknown element 'nope'");
  });

  it('reports a duplicate relationship', () => {
    const e = parseErr(wrap('        a = person "A"\n        b = softwareSystem "B"\n        a -> b "uses"\n        a -> b "uses"'));
    expect(e.line).toBe(6);
    expect(e.message).toMatch(/Duplicate relationship/);
  });

  it('accepts two relationships between a pair with different descriptions', () => {
    const ws = parseOk(wrap('        a = person "A"\n        b = softwareSystem "B"\n        a -> b "uses"\n        a -> b "also uses"'));
    expect(ws.relationships.length).toBe(2);
  });

  it('reports a duplicate identifier', () => {
    const e = parseErr(wrap('        a = person "A"\n        a = person "B"'));
    expect(e.line).toBe(4);
    expect(e.message).toMatch(/Duplicate identifier/);
  });

  it('reports an unknown element keyword in the model', () => {
    const e = parseErr(wrap('        a = persn "A"'));
    expect(e.line).toBe(3);
    expect(e.message).toMatch(/Unknown element keyword/);
  });

  it('reports a dynamic step with no relationship', () => {
    const views = '        dynamic * "d" "d" {\n            a -> b "x"\n        }';
    const e = parseErr(wrap('        a = person "A"\n        b = softwareSystem "B"', views));
    expect(e.line).toBe(8);
    expect(e.message).toMatch(/No relationship/);
  });

  it('reports an unterminated string', () => {
    const e = parseErr(wrap('        a = person "A'));
    expect(e.line).toBe(3);
  });

  it('never throws', () => {
    for (const t of ['', '}', '{', 'workspace', 'workspace {', 'workspace { model { a -> b } }', '"', '/* open']) {
      expect(() => parseWorkspace(t)).not.toThrow();
      expect(parseWorkspace(t).ok).toBe(false);
    }
  });
});

describe('unknown constructs are warnings', () => {
  const dsl = `workspace "W" "d" {
    !identifiers hierarchical
    !docs docs
    model {
        a = person "A"
        s = softwareSystem "S" {
            c = container "C" "d" "t"
        }
        a -> s.c "uses"
    }
    views {
        systemContext s "ctx" "d" {
            include *
            autoLayout lr
        }
        theme default
        styles {
            element "Person" {
                shape person
            }
        }
        branding {
            logo x.png
        }
    }
}
`;
  const ws = parseOk(dsl);
  it('keeps the model and views', () => {
    expect(ws.elements.map((e) => e.id)).toEqual(['a', 's', 's.c']);
    expect(ws.views.map((v) => v.key)).toEqual(['ctx']);
    expect(ws.views[0]!.elements).toEqual(['a', 's']);
  });
  it('warns with line numbers', () => {
    const msgs = ws.warnings.map((w) => `${w.line}:${w.message}`).join('\n');
    expect(msgs).toMatch(/3:.*!docs/);
    expect(msgs).toMatch(/14:.*autoLayout/);
    expect(msgs).toMatch(/16:.*theme/);
    expect(msgs).toMatch(/17:.*styles/);
    expect(msgs).toMatch(/22:.*branding/);
  });
  it('treats workspace extends as an empty model', () => {
    const w = parseOk('workspace extends base.dsl {\n    views {\n        systemLandscape "x" "d" {\n            include *\n        }\n    }\n}\n');
    expect(w.elements).toEqual([]);
    expect(w.warnings.length).toBeGreaterThan(0);
  });
  it('generates a view key when missing', () => {
    const w = parseOk(wrap('        a = person "A"', '        systemLandscape {\n            include *\n        }'));
    expect(w.views[0]!.key).toBe('systemLandscape-1');
    expect(w.warnings.some((x) => x.message.includes('no key'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Language features
// ---------------------------------------------------------------------------

describe('flat identifiers', () => {
  const dsl = wrap(
    `        u = person "User"
        s = softwareSystem "Shop" {
            web = container "Web" "d" "React"
            api = container "API" "d" "Node" {
                orders = component "Orders"
            }
            web -> api "calls"
            api.orders -> web "pushes"
        }
        ext = softwareSystem "Ext"
        u -> web "uses"
        orders -> ext "notifies"`,
    `        container s "c" "d" {
            include *
        }
        component api "k" "d" {
            include *
        }`,
  );
  const ws = parseOk(dsl);
  it('defaults to flat and resolves bare identifiers', () => {
    expect(ws.identifiers).toBe('flat');
    expect(ws.elements.map((e) => e.id)).toContain('s.api.orders');
    expect(ws.relationships.find((r) => r.id === 'u->s.web|uses')).toBeDefined();
    expect(ws.relationships.find((r) => r.id === 's.api.orders->ext|notifies')).toBeDefined();
  });
  it('creates implied relationships', () => {
    expect(ws.relationships.find((r) => r.id === 'u->s|uses' && r.implied)).toBeDefined();
    expect(ws.relationships.find((r) => r.id === 's.api->ext|notifies' && r.implied)).toBeDefined();
  });
  it('resolves views', () => {
    expect(ws.views.find((v) => v.key === 'c')!.elements.sort()).toEqual(['ext', 's.api', 's.web', 'u']);
    expect(ws.views.find((v) => v.key === 'k')!.elements.sort()).toEqual(['ext', 's.api.orders', 's.web']);
  });
  it('rejects duplicate flat identifiers across parents', () => {
    const e = parseErr(wrap('        a = softwareSystem "A" {\n            x = container "X"\n        }\n        b = softwareSystem "B" {\n            x = container "X"\n        }'));
    expect(e.message).toMatch(/Duplicate identifier/);
    expect(e.line).toBe(7);
  });
  it('allows the same identifier under different parents when hierarchical', () => {
    const w = parseOk(
      'workspace "w" {\n    !identifiers hierarchical\n    model {\n        a = softwareSystem "A" {\n            x = container "X"\n        }\n        b = softwareSystem "B" {\n            x = container "X"\n        }\n    }\n}\n',
    );
    expect(w.elements.map((e) => e.id)).toEqual(['a', 'a.x', 'b', 'b.x']);
  });
});

describe('this, groups, strings', () => {
  it('supports this -> x and x -> this inside an element block', () => {
    const ws = parseOk(
      wrap(
        `        s = softwareSystem "S" {
            a = container "A" {
                this -> b "calls"
                c -> this "feeds"
                -> d "implicit source"
            }
            b = container "B"
            c = container "C"
            d = container "D"
        }`,
      ),
    );
    const ids = ws.relationships.map((r) => r.id);
    expect(ids).toContain('s.a->s.b|calls');
    expect(ids).toContain('s.c->s.a|feeds');
    expect(ids).toContain('s.a->s.d|implicit source');
  });

  it('records groups on elements', () => {
    const ws = parseOk(
      wrap(
        `        group "Customers" {
            a = person "A"
            b = person "B"
        }
        s = softwareSystem "S" {
            group "Backend" {
                x = container "X"
                group "Inner" {
                    y = container "Y"
                }
            }
            z = container "Z"
        }`,
      ),
    );
    const g = (id: string): string | undefined => ws.elements.find((e) => e.id === id)!.group;
    expect(g('a')).toBe('Customers');
    expect(g('s.x')).toBe('Backend');
    expect(g('s.y')).toBe('Backend/Inner');
    expect(g('s.z')).toBeUndefined();
    expect(ws.elements.find((e) => e.id === 's.x')!.parent).toBe('s');
  });

  it('supports include by group and tag expressions', () => {
    const ws = parseOk(
      wrap(
        `        group "G" {
            a = person "A"
        }
        b = person "B" "d" "Special, Other"
        s = softwareSystem "S"`,
        `        systemLandscape "g" "d" {
            include "element.group==G"
        }
        systemLandscape "t" "d" {
            include element.tag==Special
        }
        systemLandscape "x" "d" {
            include *
            exclude b
        }`,
      ),
    );
    expect(ws.views.find((v) => v.key === 'g')!.elements).toEqual(['a']);
    expect(ws.views.find((v) => v.key === 't')!.elements).toEqual(['b']);
    expect(ws.views.find((v) => v.key === 'x')!.elements).toEqual(['a', 's']);
    expect(ws.elements.find((e) => e.id === 'b')!.tags).toEqual(['Special', 'Other']);
  });

  it('handles \\" escapes in strings', () => {
    const ws = parseOk(wrap('        a = person "The \\"Boss\\"" "Says \\"hi\\" // not a comment"'));
    expect(ws.elements[0]!.name).toBe('The "Boss"');
    expect(ws.elements[0]!.description).toBe('Says "hi" // not a comment');
  });

  it('handles comments, nested property statements and relationship blocks', () => {
    const ws = parseOk(
      wrap(
        `        // a comment
        a = person "A" # trailing
        /* block
           comment */
        s = softwareSystem "S" {
            description "From nested"
            tags "X" "Y,Z"
            url "https://example.com"
            properties {
                "k" "v"
            }
            perspectives {
                "Security" "Fine"
            }
        }
        a -> s "uses" {
            url "https://example.com/rel"
        }`,
      ),
    );
    const s = ws.elements.find((e) => e.id === 's')!;
    expect(s.description).toBe('From nested');
    expect(s.tags).toEqual(['X', 'Y', 'Z']);
    expect(s.url).toBe('https://example.com');
    expect(s.properties).toMatchObject({ k: 'v', 'perspective.Security': 'Fine' });
    expect(ws.relationships.length).toBe(1);
    expect(ws.relationships[0]!.span!.endLine).toBeGreaterThan(ws.relationships[0]!.span!.startLine);
  });

  it('supports workspace { name ... } form', () => {
    const ws = parseOk('workspace {\n    name "N"\n    description "D"\n    model {\n    }\n}\n');
    expect(ws.name).toBe('N');
    expect(ws.description).toBe('D');
  });

  it('supports line continuations', () => {
    const ws = parseOk(wrap('        a = person "A" \\\n            "Described"'));
    expect(ws.elements[0]!.description).toBe('Described');
    expect(ws.elements[0]!.span).toEqual({ startLine: 3, endLine: 4 });
  });
});

describe('view expressions', () => {
  const model = `        a = person "A"
        s = softwareSystem "S" {
            c1 = container "C1"
            c2 = container "C2"
        }
        t = softwareSystem "T"
        u = softwareSystem "U"
        a -> s.c1 "uses"
        s.c1 -> t "calls"
        t -> u "calls"`;
  const run = (views: string): Workspace => parseOk(wrap(model, '        ' + views));

  it('include ->x->, x-> and ->x', () => {
    const ws = run(`systemLandscape "both" "d" {
            include ->t->
        }
        systemLandscape "out" "d" {
            include t->
        }
        systemLandscape "in" "d" {
            include ->t
        }`);
    expect(ws.views[0]!.elements.sort()).toEqual(['s', 't', 'u']);
    expect(ws.views[1]!.elements.sort()).toEqual(['t', 'u']);
    expect(ws.views[2]!.elements.sort()).toEqual(['s', 't']);
  });

  it('exclude removes elements and relationships', () => {
    const ws = run(`systemLandscape "x" "d" {
            include *
            exclude u
        }
        systemLandscape "y" "d" {
            include *
            exclude t -> u
        }`);
    expect(ws.views[0]!.elements).toEqual(['a', 's', 't']);
    expect(ws.views[1]!.relationships).not.toContain('t->u|calls');
    expect(ws.views[1]!.relationships).toContain('s->t|calls');
  });

  it('include * in a container view drops boundary parents and the scope', () => {
    const ws = run(`container s "c" "d" {
            include *
        }`);
    expect(ws.views[0]!.elements).toEqual(['a', 's.c1', 's.c2', 't']);
  });

  it('title and description statements', () => {
    const ws = run(`systemLandscape "x" "d" {
            title "A title"
            description "Replaced"
            include *
        }`);
    expect(ws.views[0]!.title).toBe('A title');
    expect(ws.views[0]!.description).toBe('Replaced');
  });

  it('errors on unknown elements in a view', () => {
    const e = parseErr(wrap(model, '        systemLandscape "x" "d" {\n            include nope\n        }'));
    expect(e.message).toContain("Unknown element 'nope'");
    expect(e.line).toBe(16);
  });

  it('keeps the step description when it differs from the relationship', () => {
    const ws = run(`dynamic * "dyn" "d" {
            a -> s.c1 "Clicks"
            s.c1 -> t "Fetches" "HTTP"
        }`);
    const v = ws.views[0]!;
    expect(v.steps![0]!.description).toBe('Clicks');
    expect(v.steps![0]!.relationship).toBe('a->s.c1|uses');
    expect(v.steps![1]!.technology).toBe('HTTP');
    expect(v.relationships).toEqual(['a->s.c1|uses', 's.c1->t|calls']);
    expect(v.elements).toEqual(['a', 's.c1', 't']);
  });

  it('a dynamic step can use an implied relationship', () => {
    const ws = run(`dynamic * "dyn" "d" {
            a -> s "Uses the system"
        }`);
    expect(ws.views[0]!.steps![0]!.relationship).toBe('a->s|uses');
  });
});

describe('identifier generation', () => {
  it('makes lowerCamelCase identifiers', () => {
    const none = new Set<string>();
    expect(generateIdentifier('API Application', none)).toBe('apiApplication');
    expect(generateIdentifier('E-mail System', none)).toBe('eMailSystem');
    expect(generateIdentifier("Customer's computer", none)).toBe('customersComputer');
    expect(generateIdentifier('payments.requested', none)).toBe('paymentsRequested');
    expect(generateIdentifier('3D Viewer', none)).toBe('e3dViewer');
    expect(generateIdentifier('!!!', none)).toBe('e');
  });
  it('dedupes with numeric suffixes', () => {
    expect(generateIdentifier('Db', new Set(['db']))).toBe('db2');
    expect(generateIdentifier('Db', new Set(['db', 'db2']))).toBe('db3');
  });
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function edit(dsl: string, ...ops: EditOp[]) {
  const r = applyEdits(dsl, ops);
  if (!r.ok) throw new Error('edit failed: ' + r.error);
  expect(parseWorkspace(r.dsl).ok).toBe(true);
  return r;
}

/** Lines of `a` that are missing from `b` and lines of `b` missing from `a` (multiset aware) */
function diffLines(a: string, b: string): { removed: string[]; added: string[] } {
  const count = new Map<string, number>();
  for (const l of a.split('\n')) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b.split('\n')) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, c] of count) for (let i = 0; i < c; i++) removed.push(l);
  return { removed, added };
}

describe('edits: elements', () => {
  it('setElement re-emits the line and keeps the brace', () => {
    const r = edit(EXAMPLE, { op: 'setElement', id: 'banking.api', description: 'New "quoted" description', technology: 'Java 21' });
    const d = diffLines(EXAMPLE, r.dsl);
    expect(d.removed).toEqual(['            api = container "API Application" "Provides banking functionality via a JSON/HTTPS API." "Java, Spring Boot" {']);
    expect(d.added).toEqual(['            api = container "API Application" "New \\"quoted\\" description" "Java 21" {']);
    const api = r.workspace.elements.find((e) => e.id === 'banking.api')!;
    expect(api.description).toBe('New "quoted" description');
    expect(api.technology).toBe('Java 21');
    expect(api.span.endLine).toBeGreaterThan(api.span.startLine);
  });

  it('setElement keeps a trailing comment and drops trailing empty arguments', () => {
    const dsl = wrap('        a = person "A" "desc" "Tag" // keep me\n        s = softwareSystem "S" { // and me\n        }');
    const r = edit(dsl, { op: 'setElement', id: 'a', description: '', tags: [] }, { op: 'setElement', id: 's', name: 'S2', description: 'x' });
    const lines = r.dsl.split('\n');
    expect(lines[2]).toBe('        a = person "A" // keep me');
    expect(lines[3]).toBe('        s = softwareSystem "S2" "x" { // and me');
  });

  it('setElement sets tags and updates nested description statements in place', () => {
    const dsl = wrap('        s = softwareSystem "S" {\n            description "Old"\n            tags "A" "B"\n        }');
    const r = edit(dsl, { op: 'setElement', id: 's', description: 'New', tags: ['C'] });
    expect(r.dsl).toContain('            description "New"');
    expect(r.dsl).toContain('            tags "C"');
    const s = r.workspace.elements[0]!;
    expect(s.description).toBe('New');
    expect(s.tags).toEqual(['C']);
    expect(r.dsl).toContain('s = softwareSystem "S" {');
  });

  it('setElement on a person tags uses the third argument', () => {
    const r = edit(wrap('        a = person "A"'), { op: 'setElement', id: 'a', tags: ['External', 'X'] });
    expect(r.dsl).toContain('a = person "A" "" "External,X"');
    expect(r.workspace.elements[0]!.tags).toEqual(['External', 'X']);
  });

  it('setElement rejects unknown ids and instances', () => {
    expect(applyEdits(EXAMPLE, [{ op: 'setElement', id: 'nope', name: 'x' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'setElement', id: 'live.aws.region.ecs.apiInstance', name: 'x' }]).ok).toBe(false);
  });

  it('addElement into a container that has a block goes after the last child', () => {
    const r = edit(EXAMPLE, { op: 'addElement', parent: 'banking.api', kind: 'component', name: 'Audit Logger', description: 'Logs.', technology: 'Spring Bean' });
    expect(r.created).toEqual(['banking.api.auditLogger']);
    const lines = r.dsl.split('\n');
    const i = lines.findIndex((l) => l.includes('auditLogger'));
    expect(lines[i]).toBe('                auditLogger = component "Audit Logger" "Logs." "Spring Bean"');
    expect(lines[i - 1]).toContain('mainframeFacade = component');
    expect(lines[i + 1]).toBe('');
    expect(lines[i + 2]).toContain('signIn -> security');
    expect(r.workspace.elements.find((e) => e.id === 'banking.api.auditLogger')!.parent).toBe('banking.api');
    expect(diffLines(EXAMPLE, r.dsl).removed).toEqual([]);
  });

  it('addElement into a container with no block converts it to a block', () => {
    const r = edit(EXAMPLE, { op: 'addElement', parent: 'banking.spa', kind: 'component', name: 'Router' });
    const lines = r.dsl.split('\n');
    const i = lines.findIndex((l) => l.includes('spa = container'));
    expect(lines[i]).toBe('            spa = container "Single-Page Application" "Provides banking functionality to customers in their browser." "TypeScript, React" "Web Browser" {');
    expect(lines[i + 1]).toBe('                router = component "Router"');
    expect(lines[i + 2]).toBe('            }');
    expect(r.created).toEqual(['banking.spa.router']);
    const spa = r.workspace.elements.find((e) => e.id === 'banking.spa')!;
    expect(spa.span.endLine).toBe(spa.span.startLine + 2);
  });

  it('converting to a block keeps a trailing comment after the brace', () => {
    const dsl = wrap('        s = softwareSystem "S" // note');
    const r = edit(dsl, { op: 'addElement', parent: 's', kind: 'container', name: 'Web', technology: 'React' });
    expect(r.dsl.split('\n').slice(2, 5)).toEqual([
      '        s = softwareSystem "S" { // note',
      '            web = container "Web" "" "React"',
      '        }',
    ]);
  });

  it('addElement at the top level goes before the first top-level relationship', () => {
    const r = edit(EXAMPLE, { op: 'addElement', parent: null, kind: 'softwareSystem', name: 'Payment Gateway', description: 'Takes payments.', tags: ['External'] });
    const lines = r.dsl.split('\n');
    const i = lines.findIndex((l) => l.includes('paymentGateway'));
    expect(lines[i]).toBe('        paymentGateway = softwareSystem "Payment Gateway" "Takes payments." "External"');
    expect(lines[i - 1]).toContain('email = softwareSystem');
    expect(lines[i + 1]).toBe('');
    expect(r.created).toEqual(['paymentGateway']);
  });

  it('addElement dedupes identifiers and honours an explicit identifier', () => {
    const dsl = wrap('        db = person "Db"');
    const r = edit(
      dsl,
      { op: 'addElement', parent: null, kind: 'person', name: 'Db' },
      { op: 'addElement', parent: null, kind: 'person', name: 'Other', identifier: 'zed' },
    );
    expect(r.created).toEqual(['db2', 'zed']);
    expect(applyEdits(dsl, [{ op: 'addElement', parent: null, kind: 'person', name: 'X', identifier: 'db' }]).ok).toBe(false);
  });

  it('addElement validates the parent kind', () => {
    expect(applyEdits(EXAMPLE, [{ op: 'addElement', parent: 'customer', kind: 'container', name: 'X' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'addElement', parent: null, kind: 'component', name: 'X' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'addElement', parent: 'nope', kind: 'container', name: 'X' }]).ok).toBe(false);
  });

  it('later ops in a batch can use elements created earlier', () => {
    const r = edit(
      EXAMPLE,
      { op: 'addElement', parent: 'banking', kind: 'container', name: 'Cache', technology: 'Redis' },
      { op: 'addRelationship', source: 'banking.api', destination: 'banking.cache', description: 'Caches in', technology: 'RESP' },
    );
    expect(r.created).toEqual(['banking.cache', 'banking.api->banking.cache|Caches in']);
  });

  it('uses tabs when the file is indented with tabs', () => {
    const dsl = 'workspace "T" {\n\tmodel {\n\t\ts = softwareSystem "S"\n\t}\n}\n';
    const r = edit(dsl, { op: 'addElement', parent: 's', kind: 'container', name: 'Web' });
    expect(r.dsl).toContain('\n\t\ts = softwareSystem "S" {\n\t\t\tweb = container "Web"\n\t\t}\n');
  });

  it('preserves CRLF line endings', () => {
    const dsl = wrap('        s = softwareSystem "S"').replace(/\n/g, '\r\n');
    const r = edit(dsl, { op: 'addElement', parent: null, kind: 'person', name: 'P' });
    expect(r.dsl.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });
});

describe('edits: removing elements', () => {
  it('removes banking.api with everything that depends on it', () => {
    const r = edit(EXAMPLE, { op: 'removeElement', id: 'banking.api' });
    const ws = r.workspace;
    const ids = ws.elements.map((e) => e.id);
    expect(ids.filter((i) => i.startsWith('banking.api'))).toEqual([]);
    expect(ids).not.toContain('live.aws.region.ecs.apiInstance');
    expect(ids).toContain('live.aws.region.ecs');
    expect(ids).toContain('banking.db');
    for (const rel of ws.relationships) {
      expect(rel.source.startsWith('banking.api')).toBe(false);
      expect(rel.destination.startsWith('banking.api')).toBe(false);
      expect(rel.source.includes('apiInstance')).toBe(false);
      expect(rel.destination.includes('apiInstance')).toBe(false);
    }
    expect(ws.views.map((v) => v.key)).toEqual(['system-landscape', 'system-context', 'containers', 'deployment-live']);
    // untouched content survived
    const d = diffLines(EXAMPLE, r.dsl);
    expect(d.added).toEqual([]);
    expect(r.dsl).toContain('mainframe -> banking.paymentsQueue');
    expect(r.dsl).not.toContain('components-api');
    expect(r.dsl).not.toContain('dynamic-sign-in');
    expect(r.dsl).not.toContain('apiInstance');
    expect(r.dsl).not.toContain('lb -> ecs');
    // the containers view keeps the elements that are still related
    const containers = ws.views.find((v) => v.key === 'containers')!;
    expect(containers.elements).toContain('banking.spa');
    expect(containers.elements).not.toContain('email');
  });

  const extra = EXAMPLE.replace(
    '        deployment banking live',
    `        container banking "focus" "Focus." {
            include banking.spa banking.db
            exclude banking.db -> banking.spa
            include customer
        }
        dynamic * "dyn-all" "All." {
            customer -> banking.spa "Views"
            banking.spa -> banking.api.signIn "Submits"
            banking.api.signIn -> banking.api.security "Validates"
        }
        deployment banking live`,
  );

  it('removes include/exclude lines and dynamic steps that name the element', () => {
    expect(parseWorkspace(extra).ok).toBe(true);
    const r = edit(extra, { op: 'removeElement', id: 'banking.db' });
    expect(r.dsl).toContain('            include banking.spa\n');
    expect(r.dsl).not.toContain('exclude banking.db');
    expect(r.workspace.views.find((v) => v.key === 'focus')!.elements.sort()).toEqual(['banking.spa', 'customer']);
    // db went, so the dynamic-sign-in step security -> db went too
    expect(r.workspace.views.find((v) => v.key === 'dynamic-sign-in')!.steps!.length).toBe(2);
  });

  it('removes the steps naming a removed component but keeps the view', () => {
    const r = edit(extra, { op: 'removeElement', id: 'banking.api.signIn' });
    const v = r.workspace.views.find((x) => x.key === 'dyn-all')!;
    expect(v.steps!.map((s) => s.description)).toEqual(['Views']);
    expect(r.workspace.views.find((x) => x.key === 'dynamic-sign-in')!.steps!.map((x) => x.description)).toEqual(['Reads credentials from']);
  });

  it('removes unnamed deployment nodes by synthetic id', () => {
    const r = edit(EXAMPLE, { op: 'removeElement', id: 'live.~customersComputer' });
    expect(r.dsl).not.toContain("Customer's computer");
    expect(r.workspace.elements.some((e) => e.id.startsWith('live.~customersComputer'))).toBe(false);
    expect(r.workspace.views.find((v) => v.key === 'deployment-live')).toBeDefined();
  });

  it('removes a software system together with the views scoped to it and its instances', () => {
    const r = edit(EXAMPLE, { op: 'removeElement', id: 'banking' });
    expect(r.workspace.views.map((v) => v.key)).toEqual(['system-landscape']);
    expect(r.workspace.elements.map((e) => e.id).filter((i) => i.startsWith('banking'))).toEqual([]);
    expect(r.workspace.elements.some((e) => e.kind === 'containerInstance')).toBe(false);
  });

  it('removes a group that becomes empty', () => {
    const dsl = wrap(
      `        group "G" {
            a = person "A"
        }
        group "H" {
            b = person "B"
            c = person "C"
        }
        s = softwareSystem "S"`,
    );
    const r = edit(dsl, { op: 'removeElement', id: 'a' });
    expect(r.dsl).not.toContain('"G"');
    expect(r.dsl).toContain('group "H"');
    const r2 = edit(r.dsl, { op: 'removeElement', id: 'b' }, { op: 'removeElement', id: 'c' });
    expect(r2.dsl).not.toContain('group');
  });

  it('removes an outer group once its inner group goes', () => {
    const dsl = wrap(
      `        s = softwareSystem "S" {
            group "Outer" {
                group "Inner" {
                    x = container "X"
                }
            }
            y = container "Y"
        }`,
    );
    const r = edit(dsl, { op: 'removeElement', id: 's.x' });
    expect(r.dsl).not.toContain('group');
    expect(r.workspace.elements.map((e) => e.id)).toEqual(['s', 's.y']);
  });
});

describe('edits: relationships', () => {
  it('addRelationship appends at the end of the model block with hierarchical references', () => {
    const r = edit(EXAMPLE, { op: 'addRelationship', source: 'banking.api.security', destination: 'banking.paymentsQueue', description: 'Publishes to', technology: 'AWS SDK', tags: ['Async'] });
    expect(r.created).toEqual(['banking.api.security->banking.paymentsQueue|Publishes to']);
    const lines = r.dsl.split('\n');
    const i = lines.findIndex((l) => l.includes('Publishes to'));
    expect(lines[i]).toBe('        banking.api.security -> banking.paymentsQueue "Publishes to" "AWS SDK" "Async"');
    expect(lines[i + 1]).toBe('    }');
    expect(lines[i + 2]).toBe('');
    expect(lines[i + 3]).toBe('    views {');
    const rel = r.workspace.relationships.find((x) => x.id === r.created[0])!;
    expect(rel.implied).toBe(false);
    expect(rel.tags).toEqual(['Async']);
    expect(diffLines(EXAMPLE, r.dsl).removed).toEqual([]);
  });

  it('addRelationship uses flat identifiers in flat mode', () => {
    const dsl = wrap('        a = person "A"\n        s = softwareSystem "S" {\n            c = container "C"\n        }');
    const r = edit(dsl, { op: 'addRelationship', source: 'a', destination: 's.c', description: 'uses' });
    expect(r.dsl).toContain('        a -> c "uses"\n    }');
    expect(r.created).toEqual(['a->s.c|uses']);
  });

  it('addRelationship rejects duplicates and unreferencable elements', () => {
    const dup = applyEdits(EXAMPLE, [{ op: 'addRelationship', source: 'email', destination: 'customer', description: 'Sends e-mails to' }]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.parseError).toBeDefined();
    expect(applyEdits(EXAMPLE, [{ op: 'addRelationship', source: 'live.~customersComputer', destination: 'customer', description: 'x' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'addRelationship', source: 'nope', destination: 'customer', description: 'x' }]).ok).toBe(false);
  });

  it('setRelationship rewrites the statement and keeps the rest', () => {
    const id = 'banking.spa->banking.api.signIn|Submits sign-in details to';
    const r = edit(EXAMPLE, { op: 'setRelationship', id, description: 'Posts credentials to', technology: 'HTTPS' });
    const d = diffLines(EXAMPLE, r.dsl);
    expect(d.removed).toEqual(['            spa -> api.signIn "Submits sign-in details to" "JSON/HTTPS"']);
    expect(d.added).toEqual(['            spa -> api.signIn "Posts credentials to" "HTTPS"']);
    expect(r.workspace.relationships.some((x) => x.id === 'banking.spa->banking.api.signIn|Posts credentials to')).toBe(true);
  });

  it('setRelationship refuses implied relationships and unknown ids', () => {
    const implied = applyEdits(EXAMPLE, [{ op: 'setRelationship', id: 'customer->banking|Views account balances and makes payments using', description: 'x' }]);
    expect(implied).toEqual({ ok: false, error: expect.stringContaining('implied relationship') });
    expect(applyEdits(EXAMPLE, [{ op: 'removeRelationship', id: 'customer->banking|Views account balances and makes payments using' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'removeRelationship', id: 'x->y|z' }]).ok).toBe(false);
  });

  it('removeRelationship deletes the line and its implied relationships, and fixes dynamic views', () => {
    const r = edit(EXAMPLE, { op: 'removeRelationship', id: 'banking.api.security->banking.db|Reads credentials from and writes access logs to' });
    expect(r.dsl).not.toContain('api.security -> db');
    expect(r.workspace.relationships.some((x) => x.source === 'banking.api' && x.destination === 'banking.db')).toBe(false);
    // the dynamic view step security -> db had no relationship left and was dropped
    expect(r.workspace.views.find((v) => v.key === 'dynamic-sign-in')!.steps!.length).toBe(2);
  });
});

describe('edits: views', () => {
  it('addView appends to the views block with include *', () => {
    const r = edit(EXAMPLE, { op: 'addView', kind: 'container', scope: 'banking', key: 'containers-2', description: 'Another.' });
    const lines = r.dsl.split('\n');
    const i = lines.findIndex((l) => l.includes('"containers-2"'));
    expect(lines.slice(i, i + 3)).toEqual(['        container banking "containers-2" "Another." {', '            include *', '        }']);
    expect(lines[i + 3]).toBe('    }');
    expect(r.workspace.views.find((v) => v.key === 'containers-2')!.elements.length).toBe(7);
  });

  it('addView supports landscape and component views and rejects bad input', () => {
    const r = edit(
      EXAMPLE,
      { op: 'addView', kind: 'systemLandscape', key: 'landscape-2', description: 'x' },
      { op: 'addView', kind: 'component', scope: 'banking.api', key: 'comp-2', description: 'x' },
    );
    expect(r.workspace.views.find((v) => v.key === 'landscape-2')).toBeDefined();
    expect(r.workspace.views.find((v) => v.key === 'comp-2')!.elements.length).toBe(7);
    expect(applyEdits(EXAMPLE, [{ op: 'addView', kind: 'container', scope: 'banking', key: 'containers', description: 'dup' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'addView', kind: 'container', scope: 'banking.api', key: 'k', description: 'x' }]).ok).toBe(false);
    expect(applyEdits(EXAMPLE, [{ op: 'addView', kind: 'systemContext', key: 'k', description: 'x' }]).ok).toBe(false);
  });

  it('addView creates the views block when missing', () => {
    const dsl = wrap('        s = softwareSystem "S"');
    const r = edit(dsl, { op: 'addView', kind: 'systemContext', scope: 's', key: 'ctx', description: 'Context.' });
    expect(r.dsl).toBe(
      'workspace "T" "d" {\n    model {\n        s = softwareSystem "S"\n    }\n\n    views {\n        systemContext s "ctx" "Context." {\n            include *\n        }\n    }\n}\n',
    );
    expect(r.workspace.views[0]!.elements).toEqual(['s']);
  });

  it('removeView deletes the whole block', () => {
    const r = edit(EXAMPLE, { op: 'removeView', key: 'containers' });
    expect(r.workspace.views.map((v) => v.key)).toEqual(['system-landscape', 'system-context', 'components-api', 'dynamic-sign-in', 'deployment-live']);
    expect(diffLines(EXAMPLE, r.dsl).added).toEqual([]);
    expect(diffLines(EXAMPLE, r.dsl).removed.length).toBe(3);
    expect(applyEdits(EXAMPLE, [{ op: 'removeView', key: 'nope' }]).ok).toBe(false);
  });
});

describe('edits: failure handling', () => {
  it('returns the parse error and no text when the input does not parse', () => {
    const r = applyEdits('workspace {', [{ op: 'removeView', key: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.parseError).toBeDefined();
  });
  it('an empty op list returns the same text', () => {
    const r = applyEdits(EXAMPLE, []);
    expect(r.ok && r.dsl === EXAMPLE).toBe(true);
  });
  it('rejects the whole batch when a later op fails', () => {
    const r = applyEdits(EXAMPLE, [
      { op: 'addElement', parent: null, kind: 'person', name: 'Ok' },
      { op: 'removeView', key: 'nope' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Edit 2');
  });
  it('round-trips a batch of mixed ops', () => {
    const r = edit(
      EXAMPLE,
      { op: 'addElement', parent: 'banking', kind: 'container', name: 'Audit Log', technology: 'S3', tags: ['File Store'] },
      { op: 'addRelationship', source: 'banking.api', destination: 'banking.auditLog', description: 'Writes audit events to' },
      { op: 'setElement', id: 'banking.auditLog', description: 'Audit trail.' },
      { op: 'removeRelationship', id: 'banking.api->banking.auditLog|Writes audit events to' },
      { op: 'removeElement', id: 'banking.auditLog' },
    );
    expect(r.dsl).toBe(EXAMPLE);
  });
});
