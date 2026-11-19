import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentRunSummary,
  BranchState,
  EditOp,
  Job,
  ModelDetail,
  ModelSummary,
  Status,
  ValidationResult,
  View,
  ViewLayout,
  Workspace,
} from '../../shared/types.ts';
import { api } from '../api/client.ts';
import { useServerEvents } from '../api/events.ts';
import { buildIndex, type ModelIndex } from './modelIndex.ts';
import { markArrival } from './perf.ts';
import { useUrlState, type UrlPatch, type UrlState } from './url.ts';

interface Core {
  bs: BranchState | null;
  /** Last workspace that parsed; kept while the DSL is broken. */
  workspace: Workspace | null;
}

export interface Studio {
  url: UrlState;
  navigate: (patch: UrlPatch, opts?: { replace?: boolean }) => void;
  status: Status | null;
  models: ModelSummary[] | null;
  model: ModelSummary | null;
  detail: ModelDetail | null;
  branchName: string | null;
  bs: BranchState | null;
  workspace: Workspace | null;
  idx: ModelIndex | null;
  view: View | null;
  loadError: string | null;
  jobs: Job[];
  validation: ValidationResult | null;
  validating: boolean;
  runValidate: () => Promise<void>;
  edit: (ops: EditOp[], message?: string) => Promise<BranchState & { created: string[] }>;
  patchLayout: (viewKey: string, layout: ViewLayout) => void;
  applyState: (bs: BranchState, force?: boolean) => void;
  refreshModels: () => Promise<ModelSummary[]>;
  refreshDetail: () => Promise<void>;
  goToElement: (id: string) => void;
  upsertJob: (job: Job) => void;
  /** Latest finished agent run on the open model and branch (from the server's agent-run events) */
  lastAgentRun: AgentRunSummary | null;
}

const Ctx = createContext<Studio | null>(null);

export function useStudio(): Studio {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStudio needs StudioProvider');
  return v;
}

const evKey = (e: { ts: string; kind: string; text: string }) => `${e.ts}|${e.kind}|${e.text}`;

function mergeJob(prev: Job | undefined, next: Job): Job {
  if (!prev) return next;
  const seen = new Set<string>();
  const events = [...prev.events, ...next.events].filter((e) => {
    const k = evKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...prev, ...next, events };
}

// What the person last had open, per browser: the model, and each model's branch and view.
interface LastOpen {
  model?: string;
  byModel: Record<string, { branch?: string; view?: string }>;
}
const LAST_KEY = 'c4studio.lastOpen';
function readLast(): LastOpen {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as LastOpen | null;
    return v && typeof v === 'object' && v.byModel ? v : { byModel: {} };
  } catch {
    return { byModel: {} };
  }
}
function writeLast(v: LastOpen): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const [url, navigate] = useUrlState();
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [core, setCore] = useState<Core>({ bs: null, workspace: null });
  const [jobMap, setJobMap] = useState<Record<string, Job>>({});
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const last = useRef<LastOpen>(readLast());
  const model = useMemo(
    () => (models ? (models.find((m) => m.slug === url.model) ?? models.find((m) => m.slug === last.current.model) ?? models[0] ?? null) : null),
    [models, url.model],
  );
  const rememberedBranch = model ? last.current.byModel[model.slug]?.branch : undefined;
  const branchName = model
    ? url.branch && model.branches.includes(url.branch)
      ? url.branch
      : rememberedBranch && model.branches.includes(rememberedBranch)
        ? rememberedBranch
        : model.defaultBranch
    : null;

  const cur = useRef({ model: null as string | null, branch: null as string | null });
  cur.current = { model: model?.slug ?? null, branch: branchName };
  const coreRef = useRef(core);
  coreRef.current = core;

  // Initial loads.
  useEffect(() => {
    api.status().then(setStatus).catch((e) => setLoadError(String(e.message ?? e)));
    api.models().then(setModels).catch((e) => setLoadError(String(e.message ?? e)));
    api
      .jobs()
      .then((list) => setJobMap((m) => Object.fromEntries(list.map((j) => [j.id, mergeJob(m[j.id], j)]))))
      .catch(() => undefined);
  }, []);

  const refreshModels = useCallback(async () => {
    const list = await api.models();
    setModels(list);
    return list;
  }, []);

  const refreshDetail = useCallback(async () => {
    const slug = cur.current.model;
    if (!slug) return setDetail(null);
    try {
      const d = await api.model(slug);
      if (cur.current.model === slug) setDetail(d);
    } catch {
      /* the model may have just been deleted */
    }
  }, []);

  // Keep the URL canonical: model and branch always present once models are known. A model opened
  // without a view reopens on the view last used for it on this branch.
  useEffect(() => {
    if (model && branchName && (url.model !== model.slug || url.branch !== branchName)) {
      const remembered = last.current.byModel[model.slug];
      const view = url.view ?? (remembered?.branch === branchName ? remembered.view : undefined);
      navigate(url.model !== model.slug ? { model: model.slug, branch: branchName, view, element: undefined, rel: undefined } : { branch: branchName, view }, { replace: true });
    }
  }, [model, branchName, url.model, url.branch, url.view, navigate]);

  // Remember what is open.
  useEffect(() => {
    if (!model || !branchName || url.model !== model.slug) return;
    const prev = last.current.byModel[model.slug];
    const view = url.view ?? (prev?.branch === branchName ? prev.view : undefined);
    last.current = { model: model.slug, byModel: { ...last.current.byModel, [model.slug]: { branch: branchName, view } } };
    writeLast(last.current);
  }, [model, branchName, url.model, url.view]);

  const applyState = useCallback((bs: BranchState, force = false) => {
    const prev = coreRef.current;
    const same = !!prev.bs && prev.bs.model === bs.model && prev.bs.branch === bs.branch;
    if (same && !force && bs.revision <= prev.bs!.revision) return;
    markArrival(bs.revision);
    setCore({ bs, workspace: bs.workspace ?? (same ? prev.workspace : null) });
  }, []);

  // Load the current branch whenever model or branch changes.
  const slug = model?.slug ?? null;
  useEffect(() => {
    if (!slug || !branchName) {
      setCore({ bs: null, workspace: null });
      return;
    }
    let cancelled = false;
    setCore((p) => (p.bs && p.bs.model === slug && p.bs.branch === branchName ? p : { bs: null, workspace: null }));
    api
      .branch(slug, branchName)
      .then((bs) => {
        if (!cancelled) {
          setLoadError(null);
          applyState(bs, true);
        }
      })
      .catch((e) => !cancelled && setLoadError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [slug, branchName, applyState]);

  const headId = core.bs?.head?.id;
  useEffect(() => {
    void refreshDetail();
  }, [slug, headId, core.bs?.branch, refreshDetail]);

  useEffect(() => {
    setValidation(core.bs?.validation ?? null);
  }, [core.bs?.model, core.bs?.branch, core.bs?.validation]);

  const [lastAgentRun, setLastAgentRun] = useState<AgentRunSummary | null>(null);
  const upsertJob = useCallback((job: Job) => setJobMap((m) => ({ ...m, [job.id]: mergeJob(m[job.id], job) })), []);

  useServerEvents(
    (ev) => {
      switch (ev.type) {
        case 'models':
          void refreshModels();
          break;
        case 'branch': {
          const c = cur.current;
          if (ev.model === c.model && ev.branch === c.branch) applyState(ev.state);
          else if (ev.model === c.model) void refreshModels();
          break;
        }
        case 'branch-removed': {
          void refreshModels();
          const c = cur.current;
          if (ev.model === c.model && ev.branch === c.branch) navigate({ branch: undefined, view: undefined, element: undefined, rel: undefined }, { replace: true });
          break;
        }
        case 'job':
          upsertJob(ev.job);
          break;
        case 'agent-run':
          if (ev.run.model === cur.current.model && ev.run.branch === cur.current.branch) setLastAgentRun(ev.run);
          break;
        case 'validation':
          if (ev.model === cur.current.model && ev.branch === cur.current.branch) setValidation(ev.result);
          break;
        default:
          break;
      }
    },
    () => {
      // (Re)connected: resync everything that may have changed while we were away.
      void refreshModels();
      const c = cur.current;
      if (c.model && c.branch) api.branch(c.model, c.branch).then((bs) => applyState(bs, true)).catch(() => undefined);
    },
  );

  const edit = useCallback(
    async (ops: EditOp[], message?: string) => {
      const c = cur.current;
      if (!c.model || !c.branch) throw new Error('No branch selected');
      const res = await api.edits(c.model, c.branch, ops, message);
      const { created: _created, ...state } = res;
      applyState(state as BranchState);
      return res;
    },
    [applyState],
  );

  const patchLayout = useCallback((viewKey: string, layout: ViewLayout) => {
    setCore((p) =>
      p.bs ? { ...p, bs: { ...p.bs, layout: { ...p.bs.layout, views: { ...p.bs.layout.views, [viewKey]: layout } } } } : p,
    );
  }, []);

  const runValidate = useCallback(async () => {
    const c = cur.current;
    if (!c.model || !c.branch) return;
    setValidating(true);
    try {
      setValidation(await api.validate(c.model, c.branch));
    } finally {
      setValidating(false);
    }
  }, []);

  const workspace = core.workspace;
  const idx = useMemo(() => (workspace ? buildIndex(workspace) : null), [workspace]);
  const view = useMemo(() => (workspace ? (workspace.views.find((v) => v.key === url.view) ?? workspace.views[0] ?? null) : null), [workspace, url.view]);

  const goToElement = useCallback(
    (id: string) => {
      const el = idx?.byId.get(id);
      if (!idx || !el) return;
      const inView = view && (view.elements.includes(id) || view.scope === id);
      if (inView) return navigate({ page: 'diagram', element: id, rel: undefined });
      const candidates = idx.ws.views.filter((v) => v.elements.includes(id));
      const pick = candidates.find((v) => v.kind === 'container' || v.kind === 'component') ?? candidates[0];
      navigate({ page: 'diagram', view: pick?.key ?? url.view, element: id, rel: undefined });
    },
    [idx, view, navigate, url.view],
  );

  const jobs = useMemo(() => Object.values(jobMap).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [jobMap]);

  const value: Studio = {
    url,
    navigate,
    status,
    models,
    model,
    detail,
    branchName,
    bs: core.bs,
    workspace,
    idx,
    view,
    loadError,
    jobs,
    validation,
    validating,
    runValidate,
    edit,
    patchLayout,
    applyState,
    refreshModels,
    refreshDetail,
    goToElement,
    upsertJob,
    lastAgentRun,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
