import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { GitBranch, GitCompare, GitFork, MoreHorizontal, RotateCcw } from 'lucide-react';
import {
  Alert, Badge, Button, Card, ConfirmDialog, DataTable, Dialog, DialogClose, EmptyState, Field, IconButton, Input, LoadingState, Menu, MenuItem, useToast,
  type Column,
} from '@pw/ui/react';
import type { BranchInfo, Version } from '../../shared/types.ts';
import { api, errorMessage } from '../api/client.ts';
import { LinkButton, SourceBadge } from '../lib/ui.tsx';
import { formatTime } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function HistoryPage() {
  const s = useStudio();
  const { toast } = useToast();
  const model = s.model;
  const branch = s.branchName;
  const headId = s.bs?.head?.id;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Version | null>(null);
  const [dsl, setDsl] = useState<string | null>(null);
  const [rollback, setRollback] = useState<Version | null>(null);
  const [rolling, setRolling] = useState(false);
  const [fork, setFork] = useState<Version | null>(null);

  useEffect(() => {
    if (!model || !branch) return;
    let cancelled = false;
    setError(null);
    api
      .versions(model.slug, branch)
      .then((v) => !cancelled && setVersions(v))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [model?.slug, branch, headId]);

  useEffect(() => {
    setSelected(null);
    setDsl(null);
  }, [model?.slug, branch]);

  const open = (v: Version) => {
    if (!model || !branch) return;
    setSelected(v);
    setDsl(null);
    api
      .version(model.slug, branch, v.id)
      .then((d) => setDsl(d.dsl))
      .catch((e) => setDsl(`Could not load this version: ${errorMessage(e)}`));
  };

  const doRollback = async () => {
    if (!model || !branch || !rollback) return;
    setRolling(true);
    try {
      const bs = await api.rollback(model.slug, branch, rollback.id);
      s.applyState(bs, true);
      toast({ tone: 'success', title: `Rolled back to ${rollback.id}`, duration: 4000 });
      setRollback(null);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not roll back', description: errorMessage(e) });
    } finally {
      setRolling(false);
    }
  };

  const columns: Column<Version>[] = [
    { key: 'id', header: 'Version', id: true, render: (v) => <code>{v.id}</code> },
    { key: 'createdAt', header: 'Time', render: (v) => formatTime(v.createdAt), sortValue: (v) => v.createdAt },
    { key: 'source', header: 'Source', render: (v) => <SourceBadge source={v.source} /> },
    { key: 'message', header: 'Message', wrap: true, render: (v) => <span>{v.message}{v.id === headId && <> <Badge tone="brand">Head</Badge></>}</span> },
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      actions: true,
      render: (v) => (
        <Menu align="end" label={`Actions for version ${v.id}`} trigger={<IconButton label={`Actions for version ${v.id}`} icon={MoreHorizontal} variant="ghost" size="sm" />}>
          <MenuItem icon={RotateCcw} onSelect={() => setRollback(v)} disabled={v.id === headId}>
            Rollback to this version
          </MenuItem>
          <MenuItem icon={GitFork} onSelect={() => setFork(v)}>
            Fork branch here
          </MenuItem>
          <MenuItem icon={GitCompare} onSelect={() => s.navigate({ page: 'compare', left: `${branch}@${v.id}`, right: branch ?? undefined })} disabled={v.id === headId}>
            Compare with head
          </MenuItem>
        </Menu>
      ),
    },
  ];

  if (!model || !branch) return <EmptyState title="No model selected">Create or choose a model in the top bar.</EmptyState>;

  return (
    <div className="c4-page c4-history">
      <aside className="c4-history-branches">
        <Card title="Branches" description="Parent to child lineage. Select a branch to switch to it.">
          <BranchTree />
        </Card>
      </aside>
      <div className="c4-history-main">
        <h2 className="c4-page-title">History of {branch}</h2>
        {error && <Alert tone="error" title="Could not load the history">{error}</Alert>}
        {!versions && !error && <LoadingState text="Loading versions" />}
        {versions && (
          <DataTable
            caption={`Versions of ${model.name} on ${branch}, newest first`}
            columns={columns}
            rows={versions}
            rowId={(v) => v.id}
            rowLabel={(v) => `version ${v.id}`}
            onRowClick={open}
            empty={<EmptyState title="No versions yet" compact>Edits create versions automatically.</EmptyState>}
            hover
            compact
          />
        )}
        {selected && (
          <Card title={`Version ${selected.id}`} description={`${formatTime(selected.createdAt)} - ${selected.message}`}>
            {dsl === null ? <LoadingState text="Loading DSL" /> : <pre className="c4-pre" aria-label={`DSL of version ${selected.id}`}>{dsl}</pre>}
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={!!rollback}
        onOpenChange={(o) => !o && setRollback(null)}
        title={`Roll back to ${rollback?.id ?? ''}?`}
        confirmLabel="Roll back"
        onConfirm={() => void doRollback()}
        loading={rolling}
        danger
      >
        The branch takes this version&apos;s DSL and ADRs and a new version is recorded. Nothing is lost: the current head stays in the history.
      </ConfirmDialog>
      {fork && <ForkDialog version={fork} onClose={() => setFork(null)} />}
    </div>
  );
}

function BranchTree() {
  const s = useStudio();
  const branches = s.detail?.lineage.branches;
  const roots = useMemo(() => {
    if (!branches) return [];
    const all = Object.values(branches);
    const children = new Map<string, BranchInfo[]>();
    const roots: BranchInfo[] = [];
    for (const b of all) {
      if (b.parent && branches[b.parent]) children.set(b.parent, [...(children.get(b.parent) ?? []), b]);
      else roots.push(b);
    }
    const render = (b: BranchInfo): { b: BranchInfo; kids: unknown[] } => ({ b, kids: (children.get(b.name) ?? []).map(render) });
    return roots.map(render);
  }, [branches]);
  if (!branches) return <LoadingState text="Loading branches" />;

  type Node = { b: BranchInfo; kids: Node[] };
  const renderNode = (n: Node) => (
    <li key={n.b.name}>
      <div className="c4-branch-row">
        <GitBranch size={14} aria-hidden="true" />
        <LinkButton onClick={() => s.navigate({ branch: n.b.name, element: undefined, rel: undefined })} aria-current={n.b.name === s.branchName ? 'true' : undefined} className={n.b.name === s.branchName ? 'is-current' : undefined}>
          {n.b.name}
        </LinkButton>
        {n.b.name === s.branchName && <Badge tone="brand">Current</Badge>}
        {n.b.parent === null && <Badge tone="neutral">Default</Badge>}
      </div>
      {n.b.forkedFrom && <div className="c4-muted c4-branch-meta">Forked from {n.b.forkedFrom}</div>}
      {n.kids.length > 0 && <ul className="c4-tree">{n.kids.map(renderNode)}</ul>}
    </li>
  );
  return <ul className="c4-tree c4-tree-root">{(roots as Node[]).map(renderNode)}</ul>;
}

function ForkDialog({ version, onClose }: { version: Version; onClose: () => void }) {
  const s = useStudio();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = s.model;
  if (!model) return null;
  const nameError = !name ? 'Enter a branch name.' : !SLUG.test(name) || name.length > 64 ? 'Use lower-case letters, numbers and hyphens, up to 64 characters.' : model.branches.includes(name) ? 'A branch with this name already exists.' : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError) return;
    setBusy(true);
    try {
      await api.createBranch(model.slug, { name, from: { branch: version.branch, version: version.id } });
      await s.refreshModels();
      s.navigate({ branch: name, page: 'diagram', element: undefined, rel: undefined });
      onClose();
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
      title="Fork branch here"
      description={`Creates a branch from version ${version.id}.`}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="fork-form" loading={busy} loadingLabel="Creating">
            Create branch
          </Button>
        </>
      }
    >
      <form id="fork-form" onSubmit={submit} className="c4-form">
        {error && <Alert tone="error" title="Could not fork">{error}</Alert>}
        <Field label="Branch name" required error={touched ? nameError : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
      </form>
    </Dialog>
  );
}
