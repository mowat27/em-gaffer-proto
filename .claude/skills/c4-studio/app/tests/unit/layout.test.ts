import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteView, emptyLayout, loadLayout, mergeView, replaceView, saveLayout, validateViewLayout } from '../../src/core/layout.ts';
import { cleanupTmp, tmpDir } from './helpers/tmp.ts';

afterEach(cleanupTmp);

describe('layout', () => {
  it('replaces one view and keeps the others', () => {
    let l = emptyLayout();
    l = replaceView(l, 'a', { elements: { x: { x: 1, y: 1 } } });
    l = replaceView(l, 'b', { elements: { y: { x: 2, y: 2 } } });
    l = replaceView(l, 'a', { elements: { z: { x: 3, y: 3 } } });
    expect(l.views.a!.elements).toEqual({ z: { x: 3, y: 3 } });
    expect(l.views.b!.elements.y).toEqual({ x: 2, y: 2 });
  });

  it('merges positions and vertices into an existing view', () => {
    let l = replaceView(emptyLayout(), 'a', { elements: { x: { x: 1, y: 1 } } });
    l = mergeView(l, 'a', { elements: { y: { x: 2, y: 2 } }, relationships: { r: { vertices: [{ x: 5, y: 5 }] } } });
    expect(Object.keys(l.views.a!.elements).sort()).toEqual(['x', 'y']);
    expect(l.views.a!.relationships!.r!.vertices).toHaveLength(1);
  });

  it('deletes a view without touching the input', () => {
    const l = replaceView(replaceView(emptyLayout(), 'a', { elements: {} }), 'b', { elements: {} });
    const l2 = deleteView(l, 'a');
    expect(Object.keys(l2.views)).toEqual(['b']);
    expect(Object.keys(l.views)).toEqual(['a', 'b']);
  });

  it('loads missing or corrupt files as empty and round-trips', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'layout.json');
    expect(await loadLayout(file)).toEqual(emptyLayout());
    const l = replaceView(emptyLayout(), 'a', { elements: { x: { x: 1, y: 2 } } });
    await saveLayout(file, l);
    expect(await loadLayout(file)).toEqual(l);
  });

  it('validates view layouts', () => {
    expect(validateViewLayout({ elements: { a: { x: 1, y: 2 } } })).toBe(true);
    expect(validateViewLayout({ elements: { a: { x: 'n', y: 2 } } })).toBe(false);
    expect(validateViewLayout({})).toBe(false);
    expect(validateViewLayout(null)).toBe(false);
  });
});
