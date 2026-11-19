import { useState } from 'react';
import { GitBranchPlus, MessageSquare, Monitor, Moon, MoreHorizontal, Network, Plus, Sun, Trash2 } from 'lucide-react';
import {
  Brand, Button, ButtonGroup, ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator, NavLink, Select, TopBar, TopBarNav, useTheme, useToast,
} from '@pw/ui/react';
import { api, errorMessage } from '../api/client.ts';
import { NewBranchDialog } from '../dialogs/NewBranchDialog.tsx';
import { useStudio } from '../state/studio.tsx';
import { useUi } from '../state/ui.tsx';
import { serializeUrl, type Page } from '../state/url.ts';

const NAV: { page: Page; label: string }[] = [
  { page: 'diagram', label: 'Diagram' },
  { page: 'history', label: 'History' },
  { page: 'compare', label: 'Compare' },
  { page: 'adrs', label: 'ADRs' },
  { page: 'jobs', label: 'Jobs' },
  { page: 'agent', label: 'Agent' },
];

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const opts = [
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'dark', label: 'Dark theme', icon: Moon },
    { value: 'system', label: 'System theme', icon: Monitor },
  ] as const;
  return (
    <ButtonGroup label="Theme">
      {opts.map((o) => (
        <IconButton key={o.value} label={o.label} icon={o.icon} variant={theme === o.value ? 'secondary' : 'ghost'} size="sm" aria-pressed={theme === o.value} data-testid={`theme-${o.value}`} onClick={() => setTheme(o.value)} />
      ))}
    </ButtonGroup>
  );
}

export function Header() {
  const s = useStudio();
  const ui = useUi();
  const { toast } = useToast();
  const { url, model, models, branchName } = s;
  const [newBranch, setNewBranch] = useState(false);
  const [delModel, setDelModel] = useState(false);
  const [delBranch, setDelBranch] = useState(false);
  const [busy, setBusy] = useState(false);

  const href = (page: Page) => serializeUrl({ ...url, page, element: undefined, rel: undefined, adr: undefined, job: undefined, run: undefined });

  const removeModel = async () => {
    if (!model) return;
    setBusy(true);
    try {
      await api.deleteModel(model.slug);
      await s.refreshModels();
      s.navigate({ model: undefined, branch: undefined, view: undefined, element: undefined, rel: undefined, page: 'diagram' });
      setDelModel(false);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not delete the model', description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const removeBranch = async () => {
    if (!model || !branchName) return;
    setBusy(true);
    try {
      await api.deleteBranch(model.slug, branchName);
      await s.refreshModels();
      s.navigate({ branch: undefined, element: undefined, rel: undefined });
      setDelBranch(false);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not delete the branch', description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar
        brand={<Brand name="C4 Studio" mark={<Network size={20} aria-hidden="true" />} href={href('diagram')} onClick={(e) => { e.preventDefault(); s.navigate({ page: 'diagram', element: undefined, rel: undefined }); }} />}
        nav={
          <TopBarNav label="Pages">
            {NAV.map((n) => (
              <NavLink
                key={n.page}
                href={href(n.page)}
                current={url.page === n.page}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  s.navigate({ page: n.page, element: undefined, rel: undefined, adr: undefined, job: undefined });
                }}
              >
                {n.label}
              </NavLink>
            ))}
          </TopBarNav>
        }
        actions={
          <>
            <Button variant="accent" size="sm" icon={MessageSquare} aria-pressed={ui.chatOpen} onClick={() => ui.setChatOpen(!ui.chatOpen)}>
              Chat
            </Button>
            <ThemeControl />
          </>
        }
      />
      <div className="c4-contextbar">
        <label className="c4-tb-inline">
          <span>Model</span>
          <Select value={model?.slug ?? ''} disabled={!models?.length} onChange={(e) => s.navigate({ model: e.target.value, branch: undefined, view: undefined, element: undefined, rel: undefined, left: undefined, right: undefined, adr: undefined })} data-testid="model-select">
            {(models ?? []).map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
            {!models?.length && <option value="">No models</option>}
          </Select>
        </label>
        <label className="c4-tb-inline">
          <span>Branch</span>
          <Select value={branchName ?? ''} disabled={!model} onChange={(e) => s.navigate({ branch: e.target.value, element: undefined, rel: undefined, left: undefined, right: undefined })} data-testid="branch-select">
            {(model?.branches ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="secondary" size="sm" icon={Plus} onClick={ui.openNewModel}>
          New model
        </Button>
        <Button variant="secondary" size="sm" icon={GitBranchPlus} onClick={() => setNewBranch(true)} disabled={!model}>
          New branch
        </Button>
        <Menu align="start" label="Model actions" trigger={<IconButton label="Model actions" icon={MoreHorizontal} variant="ghost" size="sm" disabled={!model} />}>
          <MenuItem icon={Trash2} danger disabled={!model || branchName === model.defaultBranch} onSelect={() => setDelBranch(true)}>
            Delete branch
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger onSelect={() => setDelModel(true)}>
            Delete model
          </MenuItem>
        </Menu>
      </div>

      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} />
      <ConfirmDialog open={delModel} onOpenChange={setDelModel} title={`Delete ${model?.name ?? 'model'}?`} confirmLabel="Delete model" onConfirm={() => void removeModel()} loading={busy}>
        All branches and the whole history of this model are removed from disk. This cannot be undone.
      </ConfirmDialog>
      <ConfirmDialog open={delBranch} onOpenChange={setDelBranch} title={`Delete branch ${branchName ?? ''}?`} confirmLabel="Delete branch" onConfirm={() => void removeBranch()} loading={busy}>
        The working copy of this branch is removed. Its versions stay in the history of the model.
      </ConfirmDialog>
    </>
  );
}
