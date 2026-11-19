import { useMemo, useState, type FormEvent } from 'react';
import { Alert, Button, Dialog, DialogClose, Field, FormGrid, Input, Select, Textarea, useToast } from '@pw/ui/react';
import type { EditOp, StaticElementKind } from '../../shared/types.ts';
import { errorMessage } from '../api/client.ts';
import { useStudio } from '../state/studio.tsx';
import { TagsField } from './fields.tsx';
import { parseTags } from '../state/modelIndex.ts';

const KINDS: { value: StaticElementKind; label: string }[] = [
  { value: 'person', label: 'Person' },
  { value: 'softwareSystem', label: 'Software system' },
  { value: 'container', label: 'Container' },
  { value: 'component', label: 'Component' },
];

export function AddElementDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const s = useStudio();
  const { toast } = useToast();
  const idx = s.idx;
  const [kind, setKind] = useState<StaticElementKind>('container');
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [technology, setTechnology] = useState('');
  const [tags, setTags] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentKind = kind === 'container' ? 'softwareSystem' : kind === 'component' ? 'container' : null;
  const parents = useMemo(() => (idx && parentKind ? idx.ws.elements.filter((e) => e.kind === parentKind) : []), [idx, parentKind]);
  // Default the parent to the selected element, or the view's scope, when it fits.
  const effectiveParent = useMemo(() => {
    if (!parentKind) return '';
    if (parent && parents.some((p) => p.id === parent)) return parent;
    const sel = s.url.element && idx?.byId.get(s.url.element);
    const fromSel = sel && (sel.kind === parentKind ? sel.id : sel.parent && idx?.byId.get(sel.parent)?.kind === parentKind ? sel.parent : '');
    return fromSel || (s.view?.scope && parents.some((p) => p.id === s.view!.scope) ? s.view.scope : '') || parents[0]?.id || '';
  }, [parent, parents, parentKind, s.url.element, s.view, idx]);

  const nameError = touched && !name.trim() ? 'Enter a name.' : undefined;
  const parentError = parentKind && !effectiveParent ? `Add a ${parentKind === 'softwareSystem' ? 'software system' : 'container'} first.` : undefined;
  const showTech = kind === 'container' || kind === 'component';

  const reset = () => {
    setName('');
    setDescription('');
    setTechnology('');
    setTags('');
    setTouched(false);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!name.trim() || parentError) return;
    setBusy(true);
    setError(null);
    const op: EditOp = {
      op: 'addElement',
      parent: parentKind ? effectiveParent : null,
      kind,
      name: name.trim(),
      description: description.trim() || undefined,
      technology: showTech ? technology.trim() || undefined : undefined,
      tags: parseTags(tags).length ? parseTags(tags) : undefined,
    };
    try {
      const res = await s.edit([op], `Add ${name.trim()}`);
      const id = res.created[0];
      const inView = !!(id && s.view && res.workspace?.views.find((v) => v.key === s.view!.key)?.elements.includes(id));
      toast({
        tone: 'success',
        title: `Added ${name.trim()}`,
        description: inView ? undefined : 'It is not in the current view yet. Open a view that includes it, or add it to a view in the DSL.',
        duration: 4000,
      });
      if (id) s.navigate({ element: inView ? id : s.url.element, rel: undefined });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Add element"
      description="Adds the element to the DSL. Layout positions are chosen automatically."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="add-element-form" loading={busy} loadingLabel="Adding" disabled={!!parentError}>
            Add element
          </Button>
        </>
      }
    >
      <form id="add-element-form" onSubmit={submit} className="c4-form">
        {error && <Alert tone="error" title="Could not add the element">{error}</Alert>}
        <FormGrid>
          <Field label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value as StaticElementKind)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Parent" error={parentError} help={parentKind ? undefined : 'People and software systems sit at the top level.'}>
            <Select value={effectiveParent} disabled={!parentKind} onChange={(e) => setParent(e.target.value)}>
              {parentKind ? (
                parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))
              ) : (
                <option value="">Top level</option>
              )}
            </Select>
          </Field>
        </FormGrid>
        <Field label="Name" required error={nameError}>
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} autoFocus autoComplete="off" />
        </Field>
        <Field label="Description" optional>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {showTech && (
          <Field label="Technology" optional>
            <Input value={technology} onChange={(e) => setTechnology(e.target.value)} autoComplete="off" />
          </Field>
        )}
        <TagsField value={tags} onChange={setTags} />
      </form>
    </Dialog>
  );
}
