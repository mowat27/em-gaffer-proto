import { useState, type FormEvent } from 'react';
import { Alert, Button, Dialog, DialogClose, Field, Input, useToast } from '@pw/ui/react';
import { errorMessage } from '../api/client.ts';
import { parseTags } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';
import { ElementPicker, TagsField } from './fields.tsx';

export function AddRelationshipDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const s = useStudio();
  const { toast } = useToast();
  const idx = s.idx;
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [description, setDescription] = useState('');
  const [technology, setTechnology] = useState('');
  const [tags, setTags] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!idx) return null;

  const effSource = source || s.url.element || '';
  const errs = {
    source: !idx.byId.has(effSource) ? 'Choose an element from the list.' : undefined,
    destination: !idx.byId.has(destination) ? 'Choose an element from the list.' : effSource === destination ? 'Source and destination must differ.' : undefined,
    description: !description.trim() ? 'Describe what the source does to the destination.' : undefined,
  };
  const invalid = !!(errs.source || errs.destination || errs.description);

  const reset = () => {
    setSource('');
    setDestination('');
    setDescription('');
    setTechnology('');
    setTags('');
    setTouched(false);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      await s.edit(
        [{ op: 'addRelationship', source: effSource, destination, description: description.trim(), technology: technology.trim() || undefined, tags: parseTags(tags).length ? parseTags(tags) : undefined }],
        `Add relationship ${idx.byId.get(effSource)?.name} to ${idx.byId.get(destination)?.name}`,
      );
      toast({ tone: 'success', title: 'Relationship added', duration: 3000 });
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
      title="Add relationship"
      description="Relationships are directed: the source uses the destination."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="add-relationship-form" loading={busy} loadingLabel="Adding">
            Add relationship
          </Button>
        </>
      }
    >
      <form id="add-relationship-form" onSubmit={submit} className="c4-form">
        {error && <Alert tone="error" title="Could not add the relationship">{error}</Alert>}
        <ElementPicker label="Source" idx={idx} value={effSource} onChange={setSource} error={touched ? errs.source : undefined} />
        <ElementPicker label="Destination" idx={idx} value={destination} onChange={setDestination} error={touched ? errs.destination : undefined} />
        <Field label="Description" required error={touched ? errs.description : undefined}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Technology" optional>
          <Input value={technology} onChange={(e) => setTechnology(e.target.value)} autoComplete="off" />
        </Field>
        <TagsField value={tags} onChange={setTags} />
      </form>
    </Dialog>
  );
}
