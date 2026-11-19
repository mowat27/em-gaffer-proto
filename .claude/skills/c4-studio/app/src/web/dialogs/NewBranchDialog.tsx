import { useState, type FormEvent } from 'react';
import { Alert, Button, Dialog, DialogClose, Field, Input, Select } from '@pw/ui/react';
import { api, errorMessage } from '../api/client.ts';
import { useStudio } from '../state/studio.tsx';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function NewBranchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const s = useStudio();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = s.model;
  if (!model) return null;
  const source = from || s.branchName || model.defaultBranch;
  const nameError = !name ? 'Enter a branch name.' : !SLUG.test(name) || name.length > 64 ? 'Use lower-case letters, numbers and hyphens, up to 64 characters.' : model.branches.includes(name) ? 'A branch with this name already exists.' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError) return;
    setBusy(true);
    setError(null);
    try {
      await api.createBranch(model.slug, { name, from: { branch: source } });
      await s.refreshModels();
      s.navigate({ branch: name, view: s.url.view, element: undefined, rel: undefined });
      setName('');
      setTouched(false);
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
        if (!o) {
          setName('');
          setTouched(false);
          setError(null);
        }
        onOpenChange(o);
      }}
      title="New branch"
      description="A branch is a copy of a model you can change without touching the original."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="new-branch-form" loading={busy} loadingLabel="Creating">
            Create branch
          </Button>
        </>
      }
    >
      <form id="new-branch-form" onSubmit={submit} className="c4-form">
        {error && <Alert tone="error" title="Could not create the branch">{error}</Alert>}
        <Field label="Branch name" required error={touched ? nameError : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Create from" help="The head of this branch.">
          <Select value={source} onChange={(e) => setFrom(e.target.value)}>
            {model.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
