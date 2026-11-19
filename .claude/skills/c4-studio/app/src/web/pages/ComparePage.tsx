import { useEffect, useMemo, useState } from 'react';
import { Minus, Pencil, Plus } from 'lucide-react';
import { Alert, Badge, Card, EmptyState, Field, FormGrid, LoadingState, Select } from '@pw/ui/react';
import type { Comparison, ElementChange, Ref, RelationshipChange, Version, Workspace } from '../../shared/types.ts';
import { api, errorMessage } from '../api/client.ts';
import { Canvas } from '../diagram/Canvas.tsx';
import type { Change } from '../diagram/types.ts';
import { VIEW_KIND_LABEL, buildIndex, formatTime, viewName, viewsByKind } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';

function parseRef(s: string | undefined): Ref | null {
  if (!s) return null;
  const at = s.indexOf('@');
  return at < 0 ? { branch: s } : { branch: s.slice(0, at), version: s.slice(at + 1) || undefined };
}
const refKey = (r: Ref) => (r.version ? `${r.branch}@${r.version}` : r.branch);

function RefPicker({ label, value, branches, modelSlug, onChange }: { label: string; value: Ref; branches: string[]; modelSlug: string; onChange: (r: Ref) => void }) {
  const [versions, setVersions] = useState<Version[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .versions(modelSlug, value.branch)
      .then((v) => !cancelled && setVersions(v))
      .catch(() => !cancelled && setVersions([]));
    return () => {
      cancelled = true;
    };
  }, [modelSlug, value.branch]);
  return (
    <fieldset className="c4-ref-picker">
      <legend>{label}</legend>
      <FormGrid>
        <Field label="Branch">
          <Select value={value.branch} onChange={(e) => onChange({ branch: e.target.value })}>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Version">
          <Select value={value.version ?? ''} onChange={(e) => onChange({ branch: value.branch, version: e.target.value || undefined })}>
            <option value="">Head</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id} - {v.message.slice(0, 40)}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>
    </fieldset>
  );
}

export function ComparePage() {
  const s = useStudio();
  const model = s.model;
  const branch = s.branchName;
  const headId = s.bs?.head?.id;
  const lineage = s.detail?.lineage;

  const left = parseRef(s.url.left) ?? (branch ? { branch } : null);
  const defaultRight = useMemo(() => {
    if (!model || !branch) return null;
    const parent = lineage?.branches[branch]?.parent;
    return { branch: parent && model.branches.includes(parent) ? parent : (model.branches.find((b) => b !== branch) ?? branch) };
  }, [model, branch, lineage]);
  const right = parseRef(s.url.right) ?? defaultRight;

  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lk = left ? refKey(left) : '';
  const rk = right ? refKey(right) : '';

  useEffect(() => {
    if (!model || !left || !right) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .compare(model.slug, left, right)
      .then((c) => {
        if (cancelled) return;
        setCmp(c);
        setCount((n) => n + 1);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.slug, lk, rk, headId]);

  const leftWs = cmp?.left.workspace ?? null;
  const rightWs = cmp?.right.workspace ?? null;
  const allViews = useMemo(() => {
    const map = new Map<string, Workspace['views'][number]>();
    for (const ws of [leftWs, rightWs]) for (const v of ws?.views ?? []) if (!map.has(v.key)) map.set(v.key, v);
    return [...map.values()];
  }, [leftWs, rightWs]);
  const viewKey = allViews.find((v) => v.key === s.url.view)?.key ?? allViews.find((v) => v.key === s.view?.key)?.key ?? allViews[0]?.key;

  const changeMaps = useMemo(() => {
    const l = new Map<string, Change>();
    const r = new Map<string, Change>();
    for (const c of cmp?.elements ?? []) {
      if (c.kind === 'removed') l.set(c.id, 'removed');
      else if (c.kind === 'added') r.set(c.id, 'added');
      else {
        l.set(c.id, 'changed');
        r.set(c.id, 'changed');
      }
    }
    return { l, r };
  }, [cmp]);

  if (!model || !branch || !left || !right) return <EmptyState title="Nothing to compare">Create a model with at least one branch.</EmptyState>;

  const set = (patch: { left?: Ref; right?: Ref }) =>
    s.navigate({ left: patch.left ? refKey(patch.left) : (s.url.left ?? refKey(left)), right: patch.right ? refKey(patch.right) : (s.url.right ?? refKey(right)) }, { replace: true });

  return (
    <div className="c4-page c4-compare">
      <h2 className="c4-page-title">Compare</h2>
      <div className="c4-compare-pickers">
        <RefPicker label="Left" value={left} branches={model.branches} modelSlug={model.slug} onChange={(r) => set({ left: r })} />
        <RefPicker label="Right" value={right} branches={model.branches} modelSlug={model.slug} onChange={(r) => set({ right: r })} />
        <Field label="View" className="c4-compare-view">
          <Select value={viewKey ?? ''} disabled={allViews.length === 0} onChange={(e) => s.navigate({ view: e.target.value }, { replace: true })}>
            {viewsByKind(allViews).map(([kind, vs]) => (
              <optgroup key={kind} label={VIEW_KIND_LABEL[kind]}>
                {vs.map((v) => (
                  <option key={v.key} value={v.key}>
                    {viewName(v)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      </div>

      {error && <Alert tone="error" title="Could not compare">{error}</Alert>}
      {loading && !cmp && <LoadingState text="Comparing" />}

      {cmp && (
        <>
          <div className="c4-compare-canvases">
            {(['left', 'right'] as const).map((side) => {
              const side_ = cmp[side];
              const ws = side_.workspace;
              const view = ws?.views.find((v) => v.key === viewKey);
              return (
                <Card key={side} title={`${side === 'left' ? 'Left' : 'Right'}: ${refKey(side_.ref)}`} description={side_.version ? `${side_.version.id}, ${formatTime(side_.version.createdAt)}` : undefined} flush>
                  <div className="c4-compare-canvas">
                    {ws && view ? (
                      <Canvas
                        key={`${side}|${refKey(side_.ref)}|${viewKey}`}
                        idx={buildIndex(ws)}
                        view={view}
                        viewLayout={cmp.left.layout.views[view.key]}
                        revision={count}
                        labelsCollapsed={false}
                        readOnly
                        minimap={false}
                        changes={side === 'left' ? changeMaps.l : changeMaps.r}
                      />
                    ) : (
                      <EmptyState compact title={ws ? 'View not on this side' : 'Does not parse'}>
                        {ws ? 'This view exists only on the other side.' : 'This version of the DSL could not be parsed.'}
                      </EmptyState>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
          <Diff cmp={cmp} />
        </>
      )}
    </div>
  );
}

const CHANGE_BADGE = {
  added: { tone: 'success', icon: Plus, label: 'Added' },
  removed: { tone: 'error', icon: Minus, label: 'Removed' },
  changed: { tone: 'warning', icon: Pencil, label: 'Changed' },
} as const;

function ChangeBadge({ kind }: { kind: keyof typeof CHANGE_BADGE }) {
  const m = CHANGE_BADGE[kind];
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
}

function Diff({ cmp }: { cmp: Comparison }) {
  const nothing = cmp.elements.length + cmp.relationships.length + cmp.views.added.length + cmp.views.removed.length === 0;
  const elName = (c: ElementChange) => (c.right ?? c.left)?.name ?? c.id;
  const relName = (c: RelationshipChange) => {
    const r = c.right ?? c.left;
    const nameOf = (id: string) => (cmp.right.workspace ?? cmp.left.workspace)?.elements.find((e) => e.id === id)?.name ?? cmp.left.workspace?.elements.find((e) => e.id === id)?.name ?? id;
    return r ? `${nameOf(r.source)} → ${nameOf(r.destination)}: ${r.description}` : c.id;
  };
  if (nothing) return <Alert tone="info" title="No differences" soft>These two refs have the same elements, relationships and views.</Alert>;
  return (
    <div className="c4-diff">
      <Card title="Elements" description={`${cmp.elements.length} differences`}>
        {cmp.elements.length === 0 ? (
          <p className="c4-muted">No element differences.</p>
        ) : (
          <ul className="c4-plain-list" data-testid="diff-elements">
            {cmp.elements.map((c) => (
              <li key={c.id} className="c4-diff-row">
                <ChangeBadge kind={c.kind} />
                <span>{elName(c)}</span>
                <code>{c.id}</code>
                {c.fields && c.fields.length > 0 && <span className="c4-muted">changed: {c.fields.join(', ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Relationships" description={`${cmp.relationships.length} differences`}>
        {cmp.relationships.length === 0 ? (
          <p className="c4-muted">No relationship differences.</p>
        ) : (
          <ul className="c4-plain-list" data-testid="diff-relationships">
            {cmp.relationships.map((c) => (
              <li key={c.id} className="c4-diff-row">
                <ChangeBadge kind={c.kind} />
                <span>{relName(c)}</span>
                {c.fields && c.fields.length > 0 && <span className="c4-muted">changed: {c.fields.join(', ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {(cmp.views.added.length > 0 || cmp.views.removed.length > 0) && (
        <Card title="Views">
          <ul className="c4-plain-list">
            {cmp.views.added.map((k) => (
              <li key={`a${k}`} className="c4-diff-row">
                <ChangeBadge kind="added" />
                <code>{k}</code>
              </li>
            ))}
            {cmp.views.removed.map((k) => (
              <li key={`r${k}`} className="c4-diff-row">
                <ChangeBadge kind="removed" />
                <code>{k}</code>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
