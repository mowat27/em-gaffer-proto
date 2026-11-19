import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Alert, Button, Card, Checkbox, Choice, ConfirmDialog, DataTable, Dialog, DialogClose, EmptyState, Field, FormGrid, Icon, Input, LoadingState, Menu, MenuCheckboxItem, SearchInput, Select, Textarea, useToast,
  type Column,
} from '@pw/ui/react';
import type { Adr, AdrInput, AdrStatus } from '../../shared/types.ts';
import { api, errorMessage } from '../api/client.ts';
import { AdrStatusBadge, LinkButton, Markdown } from '../lib/ui.tsx';
import { useStudio } from '../state/studio.tsx';

const STATUSES: AdrStatus[] = ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'];
const today = () => new Date().toISOString().slice(0, 10);

export function AdrsPage() {
  const s = useStudio();
  const { toast } = useToast();
  const model = s.model;
  const branch = s.branchName;
  const [adrs, setAdrs] = useState<Adr[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ adr: Adr | null } | null>(null);
  const [del, setDel] = useState<Adr | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const sig = JSON.stringify(s.bs?.adrs ?? []);

  const reload = () => {
    if (!model || !branch) return Promise.resolve();
    return api
      .adrs(model.slug, branch)
      .then((a) => {
        setAdrs(a);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.slug, branch, sig]);

  const selected = useMemo(() => adrs?.find((a) => a.id === s.url.adr) ?? null, [adrs, s.url.adr]);

  if (!model || !branch) return <EmptyState title="No model selected">Create or choose a model in the top bar.</EmptyState>;

  const columns: Column<Adr>[] = [
    { key: 'id', header: 'ID', id: true, render: (a) => <code>{a.id}</code> },
    { key: 'title', header: 'Title', wrap: true },
    { key: 'status', header: 'Status', render: (a) => <StatusMenu adr={a} busy={saving === a.id} onChange={(st) => void setStatus(a, st)} /> },
    { key: 'date', header: 'Date' },
    {
      key: 'elements',
      header: 'Elements',
      wrap: true,
      sortable: false,
      render: (a) => (a.elements.length ? a.elements.map((id) => s.idx?.byId.get(id)?.name ?? id).join(', ') : <span className="c4-muted">None</span>),
    },
  ];

  const setStatus = async (a: Adr, status: AdrStatus) => {
    if (status === a.status) return;
    setSaving(a.id);
    try {
      const { id: _id, file: _file, supersededBy: _by, ...input } = a;
      await api.updateAdr(model.slug, branch, a.id, { ...input, status });
      toast({ tone: 'success', title: `${a.id} is now ${status}`, duration: 3000 });
      await reload();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not change the status', description: errorMessage(e) });
    } finally {
      setSaving(null);
    }
  };

  const remove = async () => {
    if (!del) return;
    setDeleting(true);
    try {
      await api.deleteAdr(model.slug, branch, del.id);
      toast({ tone: 'success', title: `Deleted ${del.id}`, duration: 3000 });
      if (s.url.adr === del.id) s.navigate({ adr: undefined });
      setDel(null);
      await reload();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not delete the decision', description: errorMessage(e) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="c4-page c4-adrs">
      <div className="c4-page-head">
        <h2 className="c4-page-title">Decisions</h2>
        <Button variant="secondary" icon={Plus} onClick={() => setForm({ adr: null })}>
          New ADR
        </Button>
      </div>
      {error && <Alert tone="error" title="Could not load the decisions">{error}</Alert>}
      {!adrs && !error && <LoadingState text="Loading decisions" />}
      {adrs && (
        <DataTable
          caption={`Architecture decision records on ${branch}`}
          columns={columns}
          rows={adrs}
          rowId={(a) => a.id}
          rowLabel={(a) => `decision ${a.id}`}
          onRowClick={(a) => s.navigate({ adr: a.id })}
          empty={<EmptyState compact title="No decisions yet">Record the first architecture decision with New ADR.</EmptyState>}
          hover
          compact
        />
      )}
      {selected && (
        <Card
          title={`${selected.id} ${selected.title}`}
          description={
            <span className="c4-inline">
              <AdrStatusBadge status={selected.status} />
              <span>{selected.date}</span>
              {selected.supersedes && <span>Supersedes {selected.supersedes}</span>}
              {selected.supersededBy && <span>Superseded by {selected.supersededBy}</span>}
            </span>
          }
          actions={
            <span className="c4-inline">
              <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setForm({ adr: selected })}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setDel(selected)}>
                Delete
              </Button>
            </span>
          }
        >
          {selected.elements.length > 0 && (
            <p className="c4-adr-elements">
              <strong>Elements:</strong>
              {selected.elements.map((id) => (
                <LinkButton key={id} onClick={() => s.goToElement(id)} disabled={!s.idx?.byId.has(id)}>
                  {s.idx?.byId.get(id)?.name ?? id}
                </LinkButton>
              ))}
            </p>
          )}
          <Markdown>{`## Context\n\n${selected.context}\n\n## Decision\n\n${selected.decision}\n\n## Consequences\n\n${selected.consequences}`}</Markdown>
        </Card>
      )}
      {form && (
        <AdrForm
          key={form.adr?.id ?? 'new'}
          adr={form.adr}
          others={adrs ?? []}
          onClose={() => setForm(null)}
          onSaved={async (a) => {
            setForm(null);
            await reload();
            s.navigate({ adr: a.id });
          }}
        />
      )}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.id ?? ''} ${del?.title ?? ''}?`} confirmLabel="Delete decision" onConfirm={() => void remove()} loading={deleting}>
        The decision file is removed from this branch. You can roll back from History.
      </ConfirmDialog>
    </div>
  );
}

/** The status badge doubles as a menu, so a decision can be accepted or rejected from the list. */
function StatusMenu({ adr, busy, onChange }: { adr: Adr; busy: boolean; onChange: (s: AdrStatus) => void }) {
  return (
    // Keep clicks and keys inside the menu from opening the row.
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Menu
        label={`Status of ${adr.id}`}
        trigger={
          <button type="button" className="c4-status-trigger" aria-label={`Change status of ${adr.id}, now ${adr.status}`} disabled={busy}>
            <AdrStatusBadge status={adr.status} />
            <Icon of={ChevronDown} size="sm" />
          </button>
        }
      >
        {STATUSES.map((st) => (
          <MenuCheckboxItem key={st} checked={st === adr.status} onCheckedChange={() => onChange(st)}>
            {st.charAt(0).toUpperCase() + st.slice(1)}
          </MenuCheckboxItem>
        ))}
      </Menu>
    </span>
  );
}

function ElementMultiSelect({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const s = useStudio();
  const [q, setQ] = useState('');
  const all = s.idx?.ws.elements.filter((e) => !['deploymentEnvironment', 'deploymentNode', 'infrastructureNode', 'containerInstance', 'softwareSystemInstance'].includes(e.kind)) ?? [];
  const shown = all.filter((e) => `${e.name} ${e.id}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <fieldset className="c4-multiselect">
      <legend>Elements ({value.length} selected)</legend>
      <SearchInput label="Filter elements" value={q} onChange={setQ} placeholder="Filter by name or id" />
      <div className="c4-multiselect-list" role="group" aria-label="Elements">
        {shown.map((e) => (
          <Choice key={e.id} label={e.name} hint={e.id} control={<Checkbox checked={value.includes(e.id)} onChange={() => toggle(e.id)} />} />
        ))}
        {shown.length === 0 && <p className="c4-muted">No elements match {q ? `"${q}"` : ''}.</p>}
      </div>
    </fieldset>
  );
}

function AdrForm({ adr, others, onClose, onSaved }: { adr: Adr | null; others: Adr[]; onClose: () => void; onSaved: (a: Adr) => void | Promise<void> }) {
  const s = useStudio();
  const [title, setTitle] = useState(adr?.title ?? '');
  const [status, setStatus] = useState<AdrStatus>(adr?.status ?? 'proposed');
  const [date, setDate] = useState(adr?.date ?? today());
  const [elements, setElements] = useState<string[]>(adr?.elements ?? (s.url.element ? [s.url.element] : []));
  const [supersedes, setSupersedes] = useState(adr?.supersedes ?? '');
  const [context, setContext] = useState(adr?.context ?? '');
  const [decision, setDecision] = useState(adr?.decision ?? '');
  const [consequences, setConsequences] = useState(adr?.consequences ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errs = {
    title: !title.trim() ? 'Enter a title.' : undefined,
    decision: !decision.trim() ? 'State the decision.' : undefined,
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errs.title || errs.decision || !s.model || !s.branchName) return;
    setBusy(true);
    setError(null);
    const input: AdrInput = { title: title.trim(), status, date, elements, supersedes: supersedes || undefined, context, decision, consequences };
    try {
      const saved = adr ? await api.updateAdr(s.model.slug, s.branchName, adr.id, input) : await api.createAdr(s.model.slug, s.branchName, input);
      await onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={adr ? `Edit ${adr.id}` : 'New ADR'}
      description="An architecture decision record: the context, the decision and what follows from it."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="adr-form" loading={busy} loadingLabel="Saving">
            {adr ? 'Save decision' : 'Create decision'}
          </Button>
        </>
      }
    >
      <form id="adr-form" onSubmit={submit} className="c4-form">
        {error && <Alert tone="error" title="Could not save the decision">{error}</Alert>}
        <Field label="Title" required error={touched ? errs.title : undefined}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setTouched(true)} autoFocus autoComplete="off" />
        </Field>
        <FormGrid>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as AdrStatus)}>
              {STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st.charAt(0).toUpperCase() + st.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label="Supersedes" optional>
          <Select value={supersedes} onChange={(e) => setSupersedes(e.target.value)}>
            <option value="">Nothing</option>
            {others
              .filter((o) => o.id !== adr?.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} {o.title}
                </option>
              ))}
          </Select>
        </Field>
        <ElementMultiSelect value={elements} onChange={setElements} />
        <Field label="Context" optional help="What forces are at play? Markdown is supported.">
          <Textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} />
        </Field>
        <Field label="Decision" required error={touched ? errs.decision : undefined}>
          <Textarea rows={4} value={decision} onChange={(e) => setDecision(e.target.value)} onBlur={() => setTouched(true)} />
        </Field>
        <Field label="Consequences" optional>
          <Textarea rows={4} value={consequences} onChange={(e) => setConsequences(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
