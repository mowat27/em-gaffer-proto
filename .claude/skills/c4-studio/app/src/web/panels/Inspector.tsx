import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowDownToLine, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, ConfirmDialog, Field, FormSection, Input, Textarea, useDirtyForm, useToast } from '@pw/ui/react';
import type { Element, Relationship } from '../../shared/types.ts';
import { errorMessage } from '../api/client.ts';
import { LinkButton } from '../lib/ui.tsx';
import {
  KIND_LABEL,
  drillDownView,
  isAsync,
  parseTags,
  userTags,
  viewName,
  viewsContaining,
  type ModelIndex,
} from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';

const EDITABLE_KINDS = new Set(['person', 'softwareSystem', 'container', 'component']);

export function Inspector() {
  const s = useStudio();
  const { idx, url } = s;
  if (!idx) return null;
  const rel = url.rel ? idx.relById.get(url.rel) : undefined;
  if (rel) return <RelationshipPanel key={rel.id} rel={rel} idx={idx} />;
  const el = url.element ? idx.byId.get(url.element) : undefined;
  if (el) return <ElementPanel key={el.id} el={el} idx={idx} />;
  return <ViewPanel />;
}

function InspectorHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <header className="c4-inspector-head">
      <h2>{title}</h2>
      <div className="c4-inline">{sub}</div>
    </header>
  );
}

function ViewPanel() {
  const { view, idx } = useStudio();
  if (!view || !idx) return null;
  return (
    <Card title={viewName(view)} description={view.description || undefined}>
      <p className="c4-muted">
        {view.elements.length} elements and {view.relationships.length} relationships in this view. Select an element or a line to edit it.
      </p>
      {idx.ws.warnings.length > 0 && (
        <details className="c4-details">
          <summary>{idx.ws.warnings.length} parser warnings</summary>
          <ul className="c4-plain-list">
            {idx.ws.warnings.map((w, i) => (
              <li key={i}>
                {w.line ? `Line ${w.line}: ` : ''}
                {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function ElementPanel({ el, idx }: { el: Element; idx: ModelIndex }) {
  const s = useStudio();
  const { toast } = useToast();
  const editable = EDITABLE_KINDS.has(el.kind);
  const hasTech = el.kind === 'container' || el.kind === 'component';
  const initial = useMemo(
    () => ({ name: el.name, description: el.description, technology: el.technology, tags: userTags(el.tags).join(', ') }),
    [el.name, el.description, el.technology, el.tags],
  );
  const form = useDirtyForm(initial, async (v) => {
    await s.edit(
      [{ op: 'setElement', id: el.id, name: v.name.trim(), description: v.description, technology: hasTech ? v.technology : undefined, tags: parseTags(v.tags) }],
      `Edit ${el.name}`,
    );
  });
  const sig = JSON.stringify(initial);
  useEffect(() => {
    if (!form.dirty) form.adopt(initial);
    // adopt only when the model changes underneath an untouched form
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const drill = drillDownView(idx, el, s.view ?? undefined);
  const outgoing = idx.ws.relationships.filter((r) => r.source === el.id);
  const incoming = idx.ws.relationships.filter((r) => r.destination === el.id);
  const views = viewsContaining(idx, el.id);
  const adrs = (s.bs?.adrs ?? []).filter((a) => a.elements.includes(el.id));

  const remove = async () => {
    setDeleting(true);
    try {
      await s.edit([{ op: 'removeElement', id: el.id }], `Remove ${el.name}`);
      s.navigate({ element: undefined, rel: undefined });
      setConfirmDelete(false);
    } catch (err) {
      toast({ tone: 'error', title: `Could not delete ${el.name}`, description: errorMessage(err) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="c4-inspector" data-testid="c4-inspector">
      <div className="c4-inspector-section">
        <InspectorHead
          title={el.name}
          sub={
            <>
              <Badge tone="neutral">{KIND_LABEL[el.kind]}</Badge>
              <code>{el.id}</code>
            </>
          }
        />
        {!editable && <p className="c4-muted">Deployment elements are edited in the DSL.</p>}
        <FormSection title="Details" form={editable ? form : undefined} saveLabel="Save changes">
          <Field label="Name" required>
            <Input {...form.bind('name')} disabled={!editable} autoComplete="off" />
          </Field>
          {hasTech && (
            <Field label="Technology" optional>
              <Input {...form.bind('technology')} disabled={!editable} autoComplete="off" />
            </Field>
          )}
          <Field label="Description" optional>
            <Textarea rows={3} {...form.bind('description')} disabled={!editable} />
          </Field>
          <Field label="Tags" optional help="Comma separated.">
            <Input {...form.bind('tags')} disabled={!editable} autoComplete="off" />
          </Field>
        </FormSection>
        <div className="c4-actions">
          {drill && (
            <Button variant="secondary" icon={ArrowDownToLine} onClick={() => s.navigate({ view: drill.key, element: undefined, rel: undefined })}>
              Drill down
            </Button>
          )}
          {editable && (
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>

      <Card title="Relationships" description={`${outgoing.length} outgoing, ${incoming.length} incoming`}>
        {outgoing.length + incoming.length === 0 && <p className="c4-muted">No relationships yet.</p>}
        <RelList title="Outgoing" rels={outgoing} idx={idx} otherOf={(r) => r.destination} />
        <RelList title="Incoming" rels={incoming} idx={idx} otherOf={(r) => r.source} />
      </Card>

      <Card title="Appears in">
        {views.length === 0 ? (
          <p className="c4-muted">This element is not in any view.</p>
        ) : (
          <ul className="c4-plain-list">
            {views.map((v) => (
              <li key={v.key}>
                <LinkButton onClick={() => s.navigate({ view: v.key, page: 'diagram' })}>{viewName(v)}</LinkButton>
                {v.key === s.view?.key && <Badge tone="neutral">Current</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {adrs.length > 0 && (
        <Card title="Decisions">
          <ul className="c4-plain-list">
            {adrs.map((a) => (
              <li key={a.id}>
                <LinkButton onClick={() => s.navigate({ page: 'adrs', adr: a.id })}>
                  {a.id} {a.title}
                </LinkButton>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${el.name}?`}
        confirmLabel="Delete element"
        onConfirm={() => void remove()}
        loading={deleting}
      >
        This removes the element and its children from the DSL, with their relationships and any view scoped to them. You can roll back from History.
      </ConfirmDialog>
    </div>
  );
}

function RelList({ title, rels, idx, otherOf }: { title: string; rels: Relationship[]; idx: ModelIndex; otherOf: (r: Relationship) => string }) {
  const s = useStudio();
  if (rels.length === 0) return null;
  return (
    <div className="c4-rel-group">
      <h4>{title}</h4>
      <ul className="c4-plain-list">
        {rels.map((r) => {
          const other = idx.byId.get(otherOf(r));
          return (
            <li key={r.id} className="c4-rel-item">
              <LinkButton onClick={() => s.goToElement(otherOf(r))}>{other?.name ?? otherOf(r)}</LinkButton>
              <button type="button" className="c4-rel-desc" onClick={() => s.navigate({ rel: r.id, element: undefined })} title="Show this relationship">
                {r.description || 'No description'}
                {r.technology && <span className="c4-muted"> [{r.technology}]</span>}
              </button>
              {r.implied && <Badge tone="neutral">Implied</Badge>}
              {isAsync(r) && <Badge tone="neutral">Async</Badge>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RelationshipPanel({ rel, idx }: { rel: Relationship; idx: ModelIndex }) {
  const s = useStudio();
  const { toast } = useToast();
  const editable = !rel.implied;
  const src = idx.byId.get(rel.source);
  const dst = idx.byId.get(rel.destination);
  const initial = useMemo(
    () => ({ description: rel.description, technology: rel.technology, tags: userTags(rel.tags).filter((t) => t !== 'Relationship').join(', ') }),
    [rel.description, rel.technology, rel.tags],
  );
  const form = useDirtyForm(initial, async (v) => {
    await s.edit([{ op: 'setRelationship', id: rel.id, description: v.description.trim(), technology: v.technology, tags: parseTags(v.tags) }], 'Edit relationship');
    // The relationship id embeds its description; follow it.
    s.navigate({ rel: `${rel.source}->${rel.destination}|${v.description.trim()}` }, { replace: true });
  });
  const sig = JSON.stringify(initial);
  useEffect(() => {
    if (!form.dirty) form.adopt(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      await s.edit([{ op: 'removeRelationship', id: rel.id }], 'Remove relationship');
      s.navigate({ rel: undefined });
      setConfirmDelete(false);
    } catch (err) {
      toast({ tone: 'error', title: 'Could not delete the relationship', description: errorMessage(err) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="c4-inspector" data-testid="c4-inspector">
      <div className="c4-inspector-section">
        <InspectorHead
          title="Relationship"
          sub={
            <>
              <LinkButton onClick={() => s.goToElement(rel.source)}>{src?.name ?? rel.source}</LinkButton>
              <ArrowRight size={14} aria-label="uses" />
              <LinkButton onClick={() => s.goToElement(rel.destination)}>{dst?.name ?? rel.destination}</LinkButton>
            </>
          }
        />
        {rel.implied && (
          <Alert tone="info" title="Implied relationship" soft>
            Structurizr derives this line from a relationship between nested elements, so it cannot be edited here.
            {rel.impliedFrom && (
              <>
                {' '}
                <LinkButton onClick={() => s.navigate({ rel: rel.impliedFrom })}>Open the explicit relationship</LinkButton>.
              </>
            )}
          </Alert>
        )}
        <FormSection title="Details" form={editable ? form : undefined} saveLabel="Save changes">
          <Field label="Description" required>
            <Input {...form.bind('description')} disabled={!editable} autoComplete="off" />
          </Field>
          <Field label="Technology" optional>
            <Input {...form.bind('technology')} disabled={!editable} autoComplete="off" />
          </Field>
          <Field label="Tags" optional help="Comma separated.">
            <Input {...form.bind('tags')} disabled={!editable} autoComplete="off" />
          </Field>
        </FormSection>
        {editable && (
          <div className="c4-actions">
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this relationship?"
        confirmLabel="Delete relationship"
        onConfirm={() => void remove()}
        loading={deleting}
      >
        {src?.name} to {dst?.name} is removed from the DSL. You can roll back from History.
      </ConfirmDialog>
    </div>
  );
}
