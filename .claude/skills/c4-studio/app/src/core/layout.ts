import type { Layout, ViewLayout } from '../shared/types.ts';
import { readJson, writeJson } from './fsutil.ts';

export function emptyLayout(): Layout {
  return { version: 1, views: {} };
}

function normalise(raw: unknown): Layout {
  if (typeof raw !== 'object' || raw === null) return emptyLayout();
  const views = (raw as { views?: unknown }).views;
  if (typeof views !== 'object' || views === null) return emptyLayout();
  return { version: 1, views: { ...(views as Record<string, ViewLayout>) } };
}

export async function loadLayout(file: string): Promise<Layout> {
  try {
    return normalise(await readJson<unknown>(file));
  } catch {
    return emptyLayout();
  }
}

export async function saveLayout(file: string, layout: Layout): Promise<void> {
  await writeJson(file, layout);
}

export function validateViewLayout(v: unknown): v is ViewLayout {
  if (typeof v !== 'object' || v === null) return false;
  const e = (v as ViewLayout).elements;
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
  for (const p of Object.values(e)) {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

/** Replace one view's layout, keeping the others. */
export function replaceView(layout: Layout, key: string, view: ViewLayout): Layout {
  return { version: 1, views: { ...layout.views, [key]: view } };
}

/** Merge element positions and relationship vertices into one view's existing layout. */
export function mergeView(layout: Layout, key: string, patch: ViewLayout): Layout {
  const current = layout.views[key];
  const merged: ViewLayout = {
    elements: { ...(current?.elements ?? {}), ...patch.elements },
  };
  const rels = { ...(current?.relationships ?? {}), ...(patch.relationships ?? {}) };
  if (Object.keys(rels).length > 0) merged.relationships = rels;
  return { version: 1, views: { ...layout.views, [key]: merged } };
}

/** Forget one view's layout (auto layout runs again). */
export function deleteView(layout: Layout, key: string): Layout {
  const { [key]: _removed, ...rest } = layout.views;
  return { version: 1, views: rest };
}
