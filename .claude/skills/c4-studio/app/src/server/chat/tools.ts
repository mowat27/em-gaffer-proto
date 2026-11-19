import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { EditOp } from '../../shared/types.ts';
import { parseRef } from '../../core/compare.ts';
import { homeDir, skillSearchDirs } from '../../core/paths.ts';
import { HttpError, type StudioContext } from '../service.ts';
import { globToRegExp, listDir, resolveScoped, walkFiles } from '../scope.ts';

const staticKind = z.enum(['person', 'softwareSystem', 'container', 'component']);

export const editOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setElement'),
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    technology: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal('addElement'),
    parent: z.string().nullable().describe('Parent element id; null for person and softwareSystem. container -> softwareSystem id; component -> container id.'),
    kind: staticKind,
    name: z.string(),
    description: z.string().optional(),
    technology: z.string().optional(),
    tags: z.array(z.string()).optional(),
    identifier: z.string().optional().describe('Optional identifier (last path segment); generated from the name when omitted.'),
  }),
  z.object({ op: z.literal('removeElement'), id: z.string() }),
  z.object({
    op: z.literal('addRelationship'),
    source: z.string(),
    destination: z.string(),
    description: z.string(),
    technology: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal('setRelationship'),
    id: z.string(),
    description: z.string().optional(),
    technology: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({ op: z.literal('removeRelationship'), id: z.string() }),
  z.object({
    op: z.literal('addView'),
    kind: z.enum(['systemLandscape', 'systemContext', 'container', 'component']),
    scope: z.string().optional().describe('Required for systemContext, container (software system id) and component (container id).'),
    key: z.string(),
    description: z.string(),
  }),
  z.object({ op: z.literal('removeView'), key: z.string() }),
]);

const adrInputSchema = z.object({
  title: z.string(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'deprecated', 'superseded']).optional(),
  date: z.string().optional(),
  elements: z.array(z.string()).optional().describe('Element ids this decision concerns'),
  supersedes: z.string().optional().describe('ADR id (for example "0001") this one supersedes'),
  context: z.string(),
  decision: z.string(),
  consequences: z.string(),
});

/** Run a mutating tool body and turn known failures into a returnable error object so the model can retry. */
async function guarded<T extends object>(fn: () => Promise<T>): Promise<T | { ok: false; error: string; parseError?: unknown }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, error: err.message, ...(err.parseError ? { parseError: err.parseError } : {}) };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const MAX_READ_BYTES = 1_000_000;

/** Tools for the AI SDK chat, bound to one model and branch. Every execute returns plain JSON. */
export function buildTools(ctx: StudioContext, model: string, branch: string) {
  const state = () => ctx.service.branchState(model, branch);
  const jsonSafe = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  return {
    get_model: tool({
      description: 'Get the current DSL, a list of elements (id, kind, name) and views (key, kind) of this branch.',
      inputSchema: z.object({}),
      execute: async () => {
        const s = await state();
        return jsonSafe({
          dsl: s.dsl,
          parseError: s.parseError,
          elements: (s.workspace?.elements ?? []).map((e) => ({ id: e.id, kind: e.kind, name: e.name })),
          views: (s.workspace?.views ?? []).map((v) => ({ key: v.key, kind: v.kind })),
        });
      },
    }),

    get_element: tool({
      description: 'Get one element by id with its relationships and the views it appears in.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const ws = (await state()).workspace;
        const el = ws?.elements.find((e) => e.id === id);
        if (!ws || !el) return { ok: false, error: `element not found: ${id}` };
        return jsonSafe({
          ok: true,
          element: el,
          relationships: ws.relationships.filter((r) => r.source === id || r.destination === id),
          views: ws.views.filter((v) => v.elements.includes(id)).map((v) => v.key),
        });
      },
    }),

    list_relationships: tool({
      description: 'List relationships, optionally only those touching one element. Implied relationships are flagged.',
      inputSchema: z.object({ element: z.string().optional() }),
      execute: async ({ element }) => {
        const ws = (await state()).workspace;
        const rels = (ws?.relationships ?? []).filter((r) => !element || r.source === element || r.destination === element);
        return jsonSafe({ relationships: rels.map((r) => ({ id: r.id, source: r.source, destination: r.destination, description: r.description, technology: r.technology, tags: r.tags, implied: r.implied })) });
      },
    }),

    list_views: tool({
      description: 'List views with key, kind, scope, title and element count.',
      inputSchema: z.object({}),
      execute: async () => {
        const ws = (await state()).workspace;
        return jsonSafe({ views: (ws?.views ?? []).map((v) => ({ key: v.key, kind: v.kind, scope: v.scope, title: v.title, description: v.description, elements: v.elements.length })) });
      },
    }),

    edit_model: tool({
      description:
        'Apply targeted edits to the DSL (add/rename/remove elements, relationships, views). All ops are applied together; if the result does not parse nothing is written and the error is returned. Returns the ids created.',
      inputSchema: z.object({ ops: z.array(editOpSchema).min(1), message: z.string().describe('Short description of the change, recorded as the version message') }),
      execute: ({ ops, message }) =>
        guarded(async () => {
          const r = await ctx.service.edit(model, branch, ops as EditOp[], { source: 'agent', message });
          return { ok: true as const, created: r.created, revision: r.state.revision, elements: r.state.workspace?.elements.length ?? 0, views: r.state.workspace?.views.map((v) => v.key) ?? [] };
        }),
    }),

    replace_dsl: tool({
      description: 'Replace the whole workspace DSL. Nothing is written when it does not parse; the parse error is returned.',
      inputSchema: z.object({ dsl: z.string(), message: z.string() }),
      execute: ({ dsl, message }) =>
        guarded(async () => {
          const s = await ctx.service.setDsl(model, branch, dsl, { source: 'agent', message });
          return { ok: true as const, revision: s.revision, elements: s.workspace?.elements.length ?? 0, views: s.workspace?.views.map((v) => v.key) ?? [] };
        }),
    }),

    patch_dsl: tool({
      description:
        'Change any part of the DSL by exact text replacement: view includes, excludes and titles, dynamic and deployment views, groups, properties, element moves, anything edit_model cannot express. Each `find` must match the current DSL exactly once (or set all: true). All edits are applied together; nothing is written when one does not match or the result does not parse.',
      inputSchema: z.object({
        edits: z
          .array(z.object({ find: z.string().min(1).describe('Exact text in the current DSL, with enough context to be unique'), replace: z.string(), all: z.boolean().optional().describe('Replace every occurrence') }))
          .min(1),
        message: z.string().describe('Short description of the change, recorded as the version message'),
      }),
      execute: ({ edits, message }) =>
        guarded(async () => {
          let dsl = (await state()).dsl;
          for (const [i, e] of edits.entries()) {
            const count = dsl.split(e.find).length - 1;
            if (count === 0) return { ok: false as const, error: `edit ${i + 1}: find text not found; read the DSL with get_model and copy it exactly` };
            if (count > 1 && !e.all) return { ok: false as const, error: `edit ${i + 1}: find text occurs ${count} times; add surrounding lines or set all: true` };
            dsl = e.all ? dsl.split(e.find).join(e.replace) : dsl.replace(e.find, () => e.replace);
          }
          const s = await ctx.service.setDsl(model, branch, dsl, { source: 'agent', message });
          return { ok: true as const, revision: s.revision, elements: s.workspace?.elements.length ?? 0, views: s.workspace?.views.map((v) => v.key) ?? [] };
        }),
    }),

    validate_model: tool({
      description: 'Run the Structurizr validator (parse plus inspections) on the branch workspace.',
      inputSchema: z.object({}),
      execute: () => guarded(async () => jsonSafe(await ctx.service.validate(model, branch))),
    }),

    list_files: tool({
      description: 'List files under a directory of the project (relative to the project root). With glob, searches recursively; otherwise lists immediate children.',
      inputSchema: z.object({ dir: z.string().optional(), glob: z.string().optional() }),
      execute: ({ dir, glob }) =>
        guarded(async () => {
          const abs = await resolveScoped(ctx, dir ?? '.');
          if (glob) return { ok: true as const, files: (await walkFiles(abs, { glob, maxFiles: 300 })).slice(0, 300) };
          const { files, dirs } = await listDir(abs);
          return { ok: true as const, files, dirs };
        }),
    }),

    read_file: tool({
      description: 'Read a text file of the project (relative to the project root).',
      inputSchema: z.object({ path: z.string(), maxLines: z.number().int().positive().max(2000).optional() }),
      execute: ({ path: p, maxLines }) =>
        guarded(async () => {
          const abs = await resolveScoped(ctx, p);
          const st = await fs.stat(abs);
          if (!st.isFile()) return { ok: false as const, error: `not a file: ${p}` };
          if (st.size > MAX_READ_BYTES) return { ok: false as const, error: `file too large (${st.size} bytes)` };
          const text = await fs.readFile(abs, 'utf8');
          if (text.includes('\0')) return { ok: false as const, error: 'binary file' };
          const lines = text.split('\n');
          const limit = maxLines ?? 400;
          return { ok: true as const, path: path.relative(ctx.projectRoot, abs), totalLines: lines.length, truncated: lines.length > limit, content: lines.slice(0, limit).join('\n') };
        }),
    }),

    search_files: tool({
      description: 'Search project files with a regular expression. Returns file, line and text of matches.',
      inputSchema: z.object({ pattern: z.string(), glob: z.string().optional(), maxResults: z.number().int().positive().max(200).optional() }),
      execute: ({ pattern, glob, maxResults }) =>
        guarded(async () => {
          let re: RegExp;
          try {
            re = new RegExp(pattern);
          } catch (err) {
            return { ok: false as const, error: `invalid pattern: ${(err as Error).message}` };
          }
          const root = await resolveScoped(ctx, '.');
          const files = await walkFiles(root, { glob, maxFiles: 3000 });
          const limit = maxResults ?? 50;
          const matches: { file: string; line: number; text: string }[] = [];
          for (const f of files) {
            if (matches.length >= limit) break;
            const abs = path.join(root, f);
            try {
              const st = await fs.stat(abs);
              if (st.size > MAX_READ_BYTES) continue;
              const text = await fs.readFile(abs, 'utf8');
              if (text.includes('\0')) continue;
              const lines = text.split('\n');
              for (let i = 0; i < lines.length && matches.length < limit; i++) {
                if (re.test(lines[i]!)) matches.push({ file: f, line: i + 1, text: lines[i]!.slice(0, 240) });
              }
            } catch {
              // unreadable file
            }
          }
          return { ok: true as const, matches, truncated: matches.length >= limit };
        }),
    }),

    list_skills: tool({
      description: 'List skills available to read: names from <project>/.claude/skills, ~/.claude/skills and the repository skills directory.',
      inputSchema: z.object({}),
      execute: async () => ({ skills: await listSkillNames(ctx) }),
    }),

    read_skill: tool({
      description: 'Read a skill: SKILL.md, or a named file inside the skill directory (for example references/structurizr-dsl.md).',
      inputSchema: z.object({ name: z.string(), file: z.string().optional() }),
      execute: ({ name, file }) =>
        guarded(async () => {
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false as const, error: 'invalid skill name' };
          for (const base of skillSearchDirs(ctx.projectRoot, ctx.skillDir)) {
            const dir = path.join(base, name);
            const target = path.join(dir, file ?? 'SKILL.md');
            const rel = path.relative(dir, target);
            if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false as const, error: 'file is outside the skill' };
            try {
              const text = await fs.readFile(target, 'utf8');
              return { ok: true as const, path: target.replace(homeDir(), '~'), content: text.slice(0, 60_000), truncated: text.length > 60_000 };
            } catch {
              // try the next search dir
            }
          }
          return { ok: false as const, error: `skill file not found: ${name}/${file ?? 'SKILL.md'}` };
        }),
    }),

    list_adrs: tool({
      description: 'List the architecture decision records of this branch.',
      inputSchema: z.object({}),
      execute: () =>
        guarded(async () => {
          const adrs = await ctx.service.listAdrs(model, branch);
          return { ok: true as const, adrs: adrs.map((a) => ({ id: a.id, title: a.title, status: a.status, date: a.date, elements: a.elements, supersedes: a.supersedes, supersededBy: a.supersededBy })) };
        }),
    }),

    get_adr: tool({
      description: 'Read one architecture decision record in full: context, decision, consequences and metadata.',
      inputSchema: z.object({ id: z.string().describe('ADR id, for example "0001"') }),
      execute: ({ id }) => guarded(async () => ({ ok: true as const, adr: jsonSafe(await ctx.service.getAdr(model, branch, id)) })),
    }),

    add_adr: tool({
      description: 'Record a new architecture decision (context, decision, consequences). Follow the ADR rules: no implementation status or to-dos, and no references that go stale (repository files, code, docs, tickets, commits, branches, versions, owners).',
      inputSchema: adrInputSchema,
      execute: (input) =>
        guarded(async () => {
          const adr = await ctx.service.createAdr(model, branch, input, { source: 'agent' });
          return { ok: true as const, id: adr.id, file: adr.file };
        }),
    }),

    update_adr: tool({
      description:
        'Change an existing decision: any of title, status (proposed, accepted, rejected, deprecated, superseded), date, elements, supersedes, context, decision, consequences. Fields you omit keep their current value. Setting supersedes marks the other ADR superseded.',
      inputSchema: adrInputSchema.partial().extend({ id: z.string().describe('ADR id, for example "0001"') }),
      execute: ({ id, ...patch }) =>
        guarded(async () => {
          const { id: _id, file: _file, supersededBy: _by, ...current } = await ctx.service.getAdr(model, branch, id);
          const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
          const adr = await ctx.service.updateAdr(model, branch, id, { ...current, ...defined }, { source: 'agent' });
          return { ok: true as const, id: adr.id, status: adr.status, title: adr.title };
        }),
    }),

    delete_adr: tool({
      description: 'Delete a decision record. Prefer update_adr with status deprecated or superseded unless the user asks for deletion. It can be restored from History.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        guarded(async () => {
          await ctx.service.deleteAdr(model, branch, id, { source: 'agent' });
          return { ok: true as const, deleted: id };
        }),
    }),

    open_page: tool({
      description:
        'Show the user a page of C4 Studio for this model: a diagram view (optionally with one element or relationship selected), the history, ADRs (optionally one ADR), compare, or jobs. The browser navigates when the tool returns. Use it to point the user at what you are talking about.',
      inputSchema: z.object({
        page: z.enum(['diagram', 'history', 'adrs', 'compare', 'jobs']).default('diagram'),
        view: z.string().optional().describe('View key for the diagram page (see list_views). Omit to keep the current view, or to pick one that contains the element.'),
        element: z.string().optional().describe('Element id to select on the diagram'),
        relationship: z.string().optional().describe('Relationship id to select on the diagram'),
        adr: z.string().optional().describe('ADR id, for example "0001", for the adrs page'),
        branch: z.string().optional().describe('Branch to show; defaults to the chat branch'),
      }),
      execute: (input) =>
        guarded(async () => {
          const target = input.branch ?? branch;
          const s = await ctx.service.branchState(model, target);
          const ws = s.workspace;
          if (input.view && ws && !ws.views.some((v) => v.key === input.view)) return { ok: false as const, error: `unknown view key: ${input.view}` };
          if (input.element && ws && !ws.elements.some((e) => e.id === input.element)) return { ok: false as const, error: `unknown element id: ${input.element}` };
          if (input.relationship && ws && !ws.relationships.some((r) => r.id === input.relationship)) return { ok: false as const, error: `unknown relationship id: ${input.relationship}` };
          let view = input.view;
          if (!view && input.page === 'diagram' && input.element && ws) {
            const holding = ws.views.filter((v) => v.elements.includes(input.element!));
            view = (holding.find((v) => v.kind === 'container' || v.kind === 'component') ?? holding[0])?.key;
          }
          return {
            ok: true as const,
            navigate: { model, branch: target, page: input.page, view, element: input.element, rel: input.relationship, adr: input.adr },
          };
        }),
    }),

    create_branch: tool({
      description: 'Fork a new branch of this model. `from` is "branch" or "branch@version"; defaults to the default branch. Does not switch the current chat branch.',
      inputSchema: z.object({ name: z.string(), from: z.string().optional() }),
      execute: ({ name, from }) =>
        guarded(async () => {
          const info = await ctx.service.createBranch(model, { name, from: from ? parseRef(from) : undefined });
          return { ok: true as const, branch: info.name, forkedFrom: info.forkedFrom };
        }),
    }),
  };
}

export const TOOL_NAMES = [
  'get_model',
  'get_element',
  'list_relationships',
  'list_views',
  'edit_model',
  'replace_dsl',
  'patch_dsl',
  'validate_model',
  'list_files',
  'read_file',
  'search_files',
  'list_skills',
  'read_skill',
  'list_adrs',
  'get_adr',
  'add_adr',
  'update_adr',
  'delete_adr',
  'create_branch',
  'open_page',
] as const;

export async function listSkillNames(ctx: Pick<StudioContext, 'projectRoot' | 'skillDir'>): Promise<string[]> {
  const names = new Set<string>();
  for (const base of skillSearchDirs(ctx.projectRoot, ctx.skillDir)) {
    try {
      for (const e of await fs.readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        try {
          await fs.access(path.join(base, e.name, 'SKILL.md'));
          names.add(e.name);
        } catch {
          // not a skill
        }
      }
    } catch {
      // missing dir
    }
  }
  return [...names].sort();
}

// re-export for tests
export { globToRegExp };
