import { useCallback, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, LayoutGrid, Link2, Maximize, Plus, ShieldCheck } from 'lucide-react';
import { Alert, Breadcrumbs, Button, EmptyState, LoadingState, Popover, Select, useToast } from '@pw/ui/react';
import { api, errorMessage } from '../api/client.ts';
import { Canvas } from '../diagram/Canvas.tsx';
import { AddElementDialog } from '../dialogs/AddElementDialog.tsx';
import { AddRelationshipDialog } from '../dialogs/AddRelationshipDialog.tsx';
import { LinkButton, ValidationBadge } from '../lib/ui.tsx';
import { ResizeHandle } from '../lib/resize.tsx';
import { useStoredState } from '../lib/storage.ts';
import { Inspector } from '../panels/Inspector.tsx';
import { VIEW_KIND_LABEL, viewName, viewTrail, viewsByKind } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';
import { useUi } from '../state/ui.tsx';
import type { ViewLayout } from '../../shared/types.ts';

export function DiagramPage() {
  const s = useStudio();
  const ui = useUi();
  const { toast } = useToast();
  const { bs, idx, view, model, branchName, url } = s;
  const aside = useRef<HTMLElement>(null);
  const asideWidth = useCallback(() => aside.current?.getBoundingClientRect().width ?? 0, []);
  const asideMax = useCallback(() => window.innerWidth * 0.5, []);
  const [collapsed, setCollapsedAll] = useStoredState('c4studio.labelsCollapsed', false);
  // Labels collapsed or shown one at a time, per model and view; the toolbar toggle resets them.
  const [overrides, setOverrides] = useStoredState<Record<string, Record<string, boolean>>>('c4studio.labelOverrides', {});
  const overrideKey = `${model?.slug ?? ''}|${view?.key ?? ''}`;
  const viewOverrides = overrides[overrideKey];
  const toggleLabel = useCallback(
    (relId: string, value: boolean) => setOverrides({ ...overrides, [overrideKey]: { ...(overrides[overrideKey] ?? {}), [relId]: value } }),
    [overrides, overrideKey, setOverrides],
  );
  const setCollapsed = (value: boolean) => {
    setCollapsedAll(value);
    if (viewOverrides) {
      const { [overrideKey]: _drop, ...restOverrides } = overrides;
      setOverrides(restOverrides);
    }
  };
  const drill = useCallback((viewKey: string) => s.navigate({ view: viewKey, element: undefined, rel: undefined }), [s.navigate]);
  const [fit, setFit] = useState(0);
  const [auto, setAuto] = useState(0);
  const [addElement, setAddElement] = useState(false);
  const [addRel, setAddRel] = useState(false);

  const persist = useCallback(
    (layout: ViewLayout) => {
      if (!model || !branchName || !view) return;
      s.patchLayout(view.key, layout);
      api.putLayout(model.slug, branchName, view.key, layout).catch((err) => toast({ tone: 'error', title: 'Could not save the layout', description: errorMessage(err) }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model?.slug, branchName, view?.key, s.patchLayout, toast],
  );
  const selectElement = useCallback((id: string | null) => s.navigate({ element: id ?? undefined, rel: undefined }), [s.navigate]);
  const selectRel = useCallback((id: string) => s.navigate({ rel: id, element: undefined }), [s.navigate]);

  // Breadcrumbs follow the C4 levels from the landscape down to the open view; going up selects the
  // element you drilled into. The selected element, if any, comes last.
  const crumbs = useMemo(() => {
    if (!model || !view || !idx) return [];
    const trail = viewTrail(idx, view).map((step, i, all) => ({
      label:
        i < all.length - 1 || url.element || url.rel ? (
          <LinkButton onClick={() => s.navigate({ view: step.view.key, element: i < all.length - 1 ? step.focus : undefined, rel: undefined })}>{crumbName(step.view)}</LinkButton>
        ) : (
          crumbName(step.view)
        ),
    }));
    const sel = url.element ? idx.byId.get(url.element) : undefined;
    return [{ label: model.name }, ...trail, ...(sel ? [{ label: sel.name }] : [])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, view, idx, url.element, url.rel]);
  function crumbName(v: NonNullable<typeof view>): string {
    const scope = v.scope ? idx?.byId.get(v.scope)?.name : undefined;
    return v.title || (scope ? `${VIEW_KIND_LABEL[v.kind]}: ${scope}` : VIEW_KIND_LABEL[v.kind]);
  }

  if (!s.models) return <LoadingState block text="Loading models" />;
  if (s.models.length === 0) {
    return (
      <EmptyState title="No models yet" actions={<Button variant="primary" icon={Plus} onClick={ui.openNewModel}>New model</Button>}>
        Create one from the top bar.
      </EmptyState>
    );
  }
  if (!bs || !idx) {
    return s.loadError ? <Alert tone="error" title="Could not load the model">{s.loadError}</Alert> : <LoadingState block text="Loading model" />;
  }

  const viewLayout = bs.layout.views[view?.key ?? ''];
  const groups = viewsByKind(idx.ws.views);

  return (
    <div className="c4-diagram-page">
      <div className="c4-toolbar" role="toolbar" aria-label="Diagram tools">
        <label className="c4-tb-inline">
          <span>View</span>
          <Select aria-label="View" value={view?.key ?? ''} disabled={!view} onChange={(e) => s.navigate({ view: e.target.value, element: undefined, rel: undefined })}>
            {groups.map(([kind, vs]) => (
              <optgroup key={kind} label={VIEW_KIND_LABEL[kind]}>
                {vs.map((v) => (
                  <option key={v.key} value={v.key}>
                    {viewName(v)}
                  </option>
                ))}
              </optgroup>
            ))}
            {!view && <option value="">No views</option>}
          </Select>
        </label>
        <Button variant="secondary" size="sm" icon={collapsed ? EyeOff : Eye} aria-pressed={collapsed} onClick={() => setCollapsed(!collapsed)} disabled={!view}>
          Labels: {collapsed ? 'collapsed' : 'shown'}
        </Button>
        <Button variant="secondary" size="sm" icon={LayoutGrid} onClick={() => setAuto((n) => n + 1)} disabled={!view}>
          Auto layout
        </Button>
        <Button variant="secondary" size="sm" icon={Maximize} onClick={() => setFit((n) => n + 1)} disabled={!view}>
          Fit
        </Button>
        <span className="c4-tb-sep" aria-hidden="true" />
        <Button variant="secondary" size="sm" icon={Plus} onClick={() => setAddElement(true)}>
          Add element
        </Button>
        <Button variant="secondary" size="sm" icon={Link2} onClick={() => setAddRel(true)} disabled={idx.ws.elements.length < 2}>
          Add relationship
        </Button>
        <span className="c4-tb-sep" aria-hidden="true" />
        <Button variant="secondary" size="sm" icon={ShieldCheck} loading={s.validating} loadingLabel="Validating" onClick={() => void s.runValidate().catch((err) => toast({ tone: 'error', title: 'Validation failed', description: errorMessage(err) }))}>
          Validate
        </Button>
        {s.validation ? (
          <Popover
            title={`Validation ${s.validation.status} (${s.validation.tool}, ${s.validation.durationMs} ms)`}
            trigger={
              <button type="button" className="c4-badge-button" aria-label="Show validation output">
                <ValidationBadge result={s.validation} validating={s.validating} />
              </button>
            }
          >
            <pre className="c4-pre c4-pre-sm">{s.validation.output || 'No output.'}</pre>
          </Popover>
        ) : (
          <ValidationBadge result={null} validating={s.validating} />
        )}
      </div>

      <aside className="c4-aside" aria-label="Inspector" ref={aside}>
        <Inspector />
      </aside>
      <ResizeHandle panel="aside" label="Resize the inspector" grows="right" min={240} max={asideMax} measure={asideWidth} className="c4-resize-aside" />

      <Breadcrumbs items={crumbs} label="Location" className="c4-crumbs" />

      <div className="c4-canvas-area">
        {view ? (
          <Canvas
            key={`${model?.slug}|${branchName}|${view.key}`}
            idx={idx}
            view={view}
            viewLayout={viewLayout}
            revision={bs.revision}
            labelsCollapsed={collapsed}
            labelOverrides={viewOverrides}
            onToggleLabel={toggleLabel}
            onDrill={drill}
            measure
            selectedElement={url.element}
            selectedRel={url.rel}
            onSelectElement={selectElement}
            onSelectRel={selectRel}
            onLayoutChange={persist}
            fitSignal={fit}
            autoLayoutSignal={auto}
            onAutoLayout={persist}
          />
        ) : (
          <EmptyState title="No views yet">Add a view in the DSL, or ask the chat to create one.</EmptyState>
        )}
      </div>

      <AddElementDialog open={addElement} onOpenChange={setAddElement} />
      <AddRelationshipDialog open={addRel} onOpenChange={setAddRel} />
    </div>
  );
}
