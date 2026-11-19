import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import type { JobRequest, Status } from '../../shared/types.ts';
import { resolveClaudeBinary } from '../../core/claude.ts';
import { isInsideReal } from '../../core/fsutil.ts';
import { findC4Modeller } from '../../core/paths.ts';
import { detectValidator } from '../../core/validate.ts';
import { chatProviders } from '../chat/providers.ts';
import { HttpError, type StudioContext } from '../service.ts';
import { listDir, resolveScoped, walkFiles } from '../scope.ts';

const MAX_IMPORT_BYTES = 5_000_000;

export async function importModelFromBody(
  ctx: StudioContext,
  body: { path?: string; dsl?: string; name?: string; description?: string },
) {
  const hasPath = typeof body?.path === 'string' && body.path.trim() !== '';
  const hasDsl = typeof body?.dsl === 'string' && body.dsl.trim() !== '';
  if (hasPath === hasDsl) throw new HttpError('provide exactly one of path or dsl', 400);
  let dsl: string;
  let sourceLabel: string;
  let fallbackName: string;
  if (hasPath) {
    const typed = body.path!.trim();
    const abs = path.isAbsolute(typed) ? typed : path.resolve(ctx.projectRoot, typed);
    if (!path.isAbsolute(typed) && !(await isInsideReal(ctx.projectRoot, abs))) {
      throw new HttpError(`relative path is outside the project: ${typed}`, 400);
    }
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new HttpError(`file not found: ${typed}`, 404);
    }
    if (!st.isFile()) throw new HttpError(`not a file: ${typed}`, 400);
    if (st.size > MAX_IMPORT_BYTES) throw new HttpError('file is too large to import', 400);
    dsl = await fs.readFile(abs, 'utf8');
    sourceLabel = typed;
    fallbackName = path.basename(abs, path.extname(abs));
  } else {
    dsl = body.dsl!;
    sourceLabel = 'text';
    fallbackName = 'imported-model';
  }
  const parsed = ctx.service.checkParses(dsl);
  const warnings = [...parsed.warnings];
  if (/^\s*!include\b/m.test(dsl)) warnings.push('The DSL uses !include; relative includes will not resolve from the imported copy.');
  const name = (body.name?.trim() || parsed.name?.trim() || fallbackName).trim();
  const summary = await ctx.service.importModel({ name, description: body.description, dsl, sourceLabel });
  return { ...summary, warnings };
}

let validatorCache: { at: number; value: Status['validator'] } | null = null;

export function miscRoutes(ctx: StudioContext): Hono {
  const app = new Hono();

  app.get('/status', async (c) => {
    if (!validatorCache || Date.now() - validatorCache.at > 30_000) validatorCache = { at: Date.now(), value: await detectValidator() };
    const status: Status = {
      projectRoot: ctx.projectRoot,
      modelsDir: ctx.modelsDir,
      skillDir: ctx.skillDir,
      c4ModellerDir: findC4Modeller(ctx.projectRoot, ctx.skillDir),
      validator: validatorCache.value,
      claudeBinary: resolveClaudeBinary(),
      providers: chatProviders(ctx.config),
      config: ctx.config,
      version: ctx.version,
    };
    return c.json(status);
  });

  app.post('/models/import', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError('invalid JSON body', 400);
    }
    return c.json(await importModelFromBody(ctx, body), 201);
  });

  app.get('/events', (c) => ctx.hub.sse(c.req.raw.signal));

  // ---- jobs --------------------------------------------------------------

  app.get('/jobs', (c) => c.json(ctx.jobs.list()));

  app.post('/jobs', async (c) => {
    let body: JobRequest;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError('invalid JSON body', 400);
    }
    return c.json(await ctx.jobs.submit(body), 202);
  });

  app.get('/jobs/:id', (c) => {
    const job = ctx.jobs.get(c.req.param('id'));
    if (!job) throw new HttpError(`job not found: ${c.req.param('id')}`, 404);
    return c.json(job);
  });

  app.delete('/jobs/:id', (c) => {
    ctx.jobs.cancel(c.req.param('id'));
    return c.body(null, 204);
  });

  // ---- project files -----------------------------------------------------

  app.get('/project/files', async (c) => {
    const dir = c.req.query('dir') ?? '.';
    const glob = c.req.query('glob');
    const abs = await resolveScoped(ctx, dir);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new HttpError(`directory not found: ${dir}`, 404);
    }
    if (!st.isDirectory()) throw new HttpError(`not a directory: ${dir}`, 400);
    const { files, dirs } = await listDir(abs);
    if (glob) return c.json({ files: await walkFiles(abs, { glob, maxFiles: 2000 }), dirs });
    return c.json({ files, dirs });
  });

  return app;
}
