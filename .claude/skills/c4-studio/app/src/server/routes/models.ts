import { Hono } from 'hono';
import type { AdrInput, EditOp, Ref, ViewLayout } from '../../shared/types.ts';
import { compareRefs, parseRef } from '../../core/compare.ts';
import { HttpError, type StudioContext } from '../service.ts';
import { safeParse } from '../state.ts';

async function json<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError('invalid JSON body', 400);
  }
}

export function modelRoutes(ctx: StudioContext): Hono {
  const { service, store } = ctx;
  const app = new Hono();

  app.get('/', async (c) => c.json(await store.listModels()));

  app.post('/', async (c) => {
    const body = await json<{ name?: string; description?: string }>(c);
    if (!body?.name || typeof body.name !== 'string') throw new HttpError('name is required', 400);
    return c.json(await service.createModel({ name: body.name, description: body.description }), 201);
  });

  app.get('/:model', async (c) => c.json(await store.getModel(c.req.param('model'))));

  app.delete('/:model', async (c) => {
    await service.deleteModel(c.req.param('model'));
    return c.body(null, 204);
  });

  // ---- branches ----------------------------------------------------------

  app.post('/:model/branches', async (c) => {
    const body = await json<{ name?: string; from?: Ref }>(c);
    if (!body?.name) throw new HttpError('name is required', 400);
    return c.json(await service.createBranch(c.req.param('model'), { name: body.name, from: body.from }), 201);
  });

  app.delete('/:model/branches/:branch', async (c) => {
    await service.deleteBranch(c.req.param('model'), c.req.param('branch'));
    return c.body(null, 204);
  });

  app.get('/:model/branches/:branch', async (c) => c.json(await service.branchState(c.req.param('model'), c.req.param('branch'))));

  app.put('/:model/branches/:branch/dsl', async (c) => {
    const body = await json<{ dsl?: string; message?: string }>(c);
    return c.json(await service.setDsl(c.req.param('model'), c.req.param('branch'), body?.dsl as string, { message: body?.message }));
  });

  app.post('/:model/branches/:branch/edits', async (c) => {
    const body = await json<{ ops?: EditOp[]; message?: string }>(c);
    const r = await service.edit(c.req.param('model'), c.req.param('branch'), body?.ops as EditOp[], { message: body?.message });
    return c.json({ ...r.state, created: r.created });
  });

  app.put('/:model/branches/:branch/layout/:viewKey', async (c) => {
    const body = await json<ViewLayout>(c);
    await service.setLayout(c.req.param('model'), c.req.param('branch'), c.req.param('viewKey'), body);
    return c.body(null, 204);
  });

  app.delete('/:model/branches/:branch/layout/:viewKey', async (c) => {
    await service.deleteLayout(c.req.param('model'), c.req.param('branch'), c.req.param('viewKey'));
    return c.body(null, 204);
  });

  // ---- versions ----------------------------------------------------------

  app.get('/:model/branches/:branch/versions', async (c) => {
    await store.requireBranch(c.req.param('model'), c.req.param('branch'));
    return c.json(await store.listVersions(c.req.param('model'), c.req.param('branch')));
  });

  app.get('/:model/branches/:branch/versions/:id', async (c) => {
    const v = await store.getVersion(c.req.param('model'), c.req.param('id'));
    return c.json({ version: v.version, dsl: v.dsl, workspace: safeParse(v.dsl).workspace, layout: v.layout, adrs: v.adrs });
  });

  app.post('/:model/branches/:branch/rollback', async (c) => {
    const body = await json<{ version?: string }>(c);
    return c.json(await service.rollback(c.req.param('model'), c.req.param('branch'), body?.version as string));
  });

  app.post('/:model/branches/:branch/snapshot', async (c) => {
    let message = '';
    try {
      message = ((await c.req.json()) as { message?: string })?.message ?? '';
    } catch {
      // empty body
    }
    const v = await service.snapshot(c.req.param('model'), c.req.param('branch'), message);
    return v ? c.json(v) : c.body(null, 204);
  });

  app.post('/:model/branches/:branch/validate', async (c) => c.json(await service.validate(c.req.param('model'), c.req.param('branch'))));

  // ---- ADRs --------------------------------------------------------------

  app.get('/:model/branches/:branch/adrs', async (c) => c.json(await service.listAdrs(c.req.param('model'), c.req.param('branch'))));

  app.post('/:model/branches/:branch/adrs', async (c) => {
    const body = await json<AdrInput>(c);
    return c.json(await service.createAdr(c.req.param('model'), c.req.param('branch'), body), 201);
  });

  app.put('/:model/branches/:branch/adrs/:id', async (c) => {
    const body = await json<AdrInput>(c);
    return c.json(await service.updateAdr(c.req.param('model'), c.req.param('branch'), c.req.param('id'), body));
  });

  app.delete('/:model/branches/:branch/adrs/:id', async (c) => {
    await service.deleteAdr(c.req.param('model'), c.req.param('branch'), c.req.param('id'));
    return c.body(null, 204);
  });

  // ---- compare -----------------------------------------------------------

  app.get('/:model/compare', async (c) => {
    const left = c.req.query('left');
    const right = c.req.query('right');
    if (!left || !right) throw new HttpError('left and right are required (<branch>[@<version>])', 400);
    return c.json(await compareRefs(store, c.req.param('model'), parseRef(left), parseRef(right)));
  });

  return app;
}
