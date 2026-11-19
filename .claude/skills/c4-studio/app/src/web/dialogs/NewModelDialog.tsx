import { useState, type FormEvent } from 'react';
import { AiTag, Alert, Button, Choice, ChoiceGroup, Dialog, DialogClose, Field, Fieldset, Input, Radio, Select, Textarea } from '@pw/ui/react';
import type { ParseError } from '../../shared/types.ts';
import { ApiError, api, errorMessage } from '../api/client.ts';
import { useStudio } from '../state/studio.tsx';

type Mode = 'empty' | 'prompt' | 'reverse' | 'import';
const NEW = '__new__';

export function NewModelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const s = useStudio();
  const [mode, setMode] = useState<Mode>('empty');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState(NEW);
  const [codePath, setCodePath] = useState('.');
  const [dslPath, setDslPath] = useState('');
  const [dslText, setDslText] = useState('');
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<ParseError | null>(null);

  const existing = s.models ?? [];
  const reverseExisting = mode === 'reverse' && target !== NEW;
  const importNeedsSource = mode === 'import' && !dslPath.trim() && !dslText.trim();
  const errs = {
    name: (mode === 'import' ? false : !reverseExisting) && !name.trim() ? 'Enter a name.' : undefined,
    prompt: mode === 'prompt' && !prompt.trim() ? 'Describe the system to model.' : undefined,
    source: importNeedsSource ? 'Enter a file path or paste the DSL text.' : undefined,
  };
  const invalid = !!(errs.name || errs.prompt || errs.source);

  const reset = () => {
    setName('');
    setDescription('');
    setPrompt('');
    setTarget(NEW);
    setCodePath('.');
    setDslPath('');
    setDslText('');
    setTouched(false);
    setAttempted(false);
    setError(null);
    setParseError(null);
  };

  const open_ = async (slug: string, branch: string) => {
    await s.refreshModels();
    s.navigate({ model: slug, branch, page: 'diagram', view: undefined, element: undefined, rel: undefined, left: undefined, right: undefined, job: undefined, adr: undefined });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setAttempted(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    setParseError(null);
    try {
      if (mode === 'empty') {
        const m = await api.createModel({ name: name.trim(), description: description.trim() || undefined });
        await open_(m.slug, m.defaultBranch);
      } else if (mode === 'prompt') {
        const m = await api.createModel({ name: name.trim(), description: description.trim() || undefined });
        const job = await api.createJob({ type: 'create', model: m.slug, branch: m.defaultBranch, prompt: prompt.trim() });
        s.upsertJob(job);
        await s.refreshModels();
        s.navigate({ model: m.slug, branch: m.defaultBranch, page: 'jobs', job: job.id, view: undefined, element: undefined, rel: undefined });
      } else if (mode === 'reverse') {
        let slug: string;
        let branch: string;
        if (reverseExisting) {
          const m = existing.find((x) => x.slug === target)!;
          slug = m.slug;
          branch = m.slug === s.model?.slug && s.branchName ? s.branchName : m.defaultBranch;
        } else {
          const m = await api.createModel({ name: name.trim(), description: description.trim() || undefined });
          slug = m.slug;
          branch = m.defaultBranch;
        }
        const job = await api.createJob({
          type: 'reverse',
          model: slug,
          branch,
          prompt: prompt.trim() || 'Reverse engineer the codebase into a C4 model.',
          codePath: codePath.trim() || '.',
        });
        s.upsertJob(job);
        await s.refreshModels();
        s.navigate({ model: slug, branch, page: 'jobs', job: job.id, view: undefined, element: undefined, rel: undefined });
      } else {
        const body = dslPath.trim() ? { path: dslPath.trim() } : { dsl: dslText };
        const m = await api.importModel({ ...body, name: name.trim() || undefined, description: description.trim() || undefined });
        await open_(m.slug, m.defaultBranch || 'main');
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.parseError) setParseError(err.parseError);
      setError(errorMessage(err instanceof ApiError && err.parseError ? new ApiError(err.status, err.message) : err));
    } finally {
      setBusy(false);
    }
  };

  const submitLabel = { empty: 'Create model', prompt: 'Create with AI', reverse: 'Start reverse engineering', import: 'Import model' }[mode];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      size="lg"
      title="New model"
      description="Start with an empty workspace, ask Claude to draft one, model an existing codebase, or import a Structurizr DSL file."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant={mode === 'prompt' || mode === 'reverse' ? 'accent' : 'primary'} type="submit" form="new-model-form" loading={busy} loadingLabel="Working">
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="new-model-form" onSubmit={submit} className="c4-form">
        <Fieldset legend="How do you want to start?">
          <ChoiceGroup row>
            {(
              [
                ['empty', 'Empty', 'A skeleton workspace'],
                ['prompt', 'From prompt', 'Claude drafts the model'],
                ['reverse', 'Reverse engineer', 'Model a codebase'],
                ['import', 'Import DSL file', 'Bring an existing workspace'],
              ] as [Mode, string, string][]
            ).map(([value, label, hint]) => (
              <Choice
                key={value}
                label={value === 'prompt' || value === 'reverse' ? <>{label} <AiTag /></> : label}
                hint={hint}
                control={<Radio name="new-model-mode" checked={mode === value} onChange={() => setMode(value)} />} />
            ))}
          </ChoiceGroup>
        </Fieldset>

        {error && (
          <Alert tone="error" title={parseError ? 'The DSL does not parse' : 'Could not create the model'}>
            {parseError ? `Line ${parseError.line}: ${parseError.message}` : error}
          </Alert>
        )}

        {mode === 'reverse' && (
          <Field label="Model" help="Reverse engineering into an existing model updates its current branch.">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value={NEW}>New model</option>
              {existing.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode === 'import' && (
          <>
            <Field label="File path" help="Absolute, or relative to the project root. Leave empty to paste the DSL instead." error={attempted ? errs.source : undefined}>
              <Input value={dslPath} onChange={(e) => setDslPath(e.target.value)} placeholder="docs/architecture/workspace.dsl" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="DSL text" optional help={dslPath.trim() ? 'Ignored while a file path is set.' : 'Paste the contents of a workspace.dsl file.'}>
              <Textarea rows={8} value={dslText} onChange={(e) => setDslText(e.target.value)} spellCheck={false} className="c4-mono" disabled={!!dslPath.trim()} />
            </Field>
          </>
        )}

        {!reverseExisting && (
          <Field label="Name" required={mode !== 'import'} optional={mode === 'import'} error={touched || attempted ? errs.name : undefined} help={mode === 'import' ? 'Defaults to the workspace name in the DSL.' : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} autoComplete="off" />
          </Field>
        )}
        {!reverseExisting && mode !== 'reverse' && (
          <Field label="Description" optional>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
          </Field>
        )}

        {mode === 'prompt' && (
          <Field label="Prompt" required error={attempted ? errs.prompt : undefined} help="Describe the system, its users and the main technologies.">
            <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
        )}

        {mode === 'reverse' && (
          <>
            <Field label="Code path" help="Relative to the project root, or absolute.">
              <Input value={codePath} onChange={(e) => setCodePath(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Notes for Claude" optional>
              <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}
