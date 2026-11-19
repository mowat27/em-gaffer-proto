/**
 * definitions: builders, agents and their resources as versioned definitions (design section 9, D10, E15, E25). Where
 * each kind lives and what its version is: ops/definitions/kinds.ts. How a change is made (lock, expectedVersion,
 * staged validation, E25, propose mode, history, definition.changed): ops/definitions/change.ts.
 *
 *   builders    builder_list, builder_get, builder_create, builder_clone, builder_update, builder_activate,
 *               builder_delete
 *   agents      agent_list, agent_get (resolved), agent_create (from shared/agent-templates/), agent_update,
 *               agent_delete
 *   resources   skill_*, template_*, gate_*, listener_*, prompt_*: list, get, create, update, delete
 *   versions    definitions_validate, history_list, history_diff, history_rollback
 *   change sets changeset_list, changeset_apply (for agents with definitions: { changes: propose })
 *
 * Every change takes `expectedVersion` (the version the caller read; a create expects none), validates before it
 * writes, keeps the previous version in agentics/history/ and returns `{ version, affects }`. Content comes as whole
 * files (`files`: path -> content, null removes one; `content` for a one-file definition) or as exact replacements
 * (`edits`: find must occur once).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { listAgents } from "../../runtime/paths.ts";
import { loadAgent, resolve } from "../../runtime/resolve.ts";
import { NO_LIMIT } from "../../runtime/run.ts";
import { activeBuilder } from "../definitions/active.ts";
import { agenticsOf, applying, callerOf, change, proposes, type ChangeRequest, type Op } from "../definitions/change.ts";
import { currentVersion, KINDS, listIds, locate, readFileSet, versionOf, type Def, type FileSet, type Kind } from "../definitions/kinds.ts";
import { diffSets, findHistory, historyFiles, listChangeSets, listHistory, readChangeSet, readDirSet, updateChangeSet } from "../definitions/store.ts";
import { checkBuilder, checkDefinition, inspectTree, realTree, tsFilesOf, typeCheck, type TsError } from "../definitions/validate.ts";
import { toolsOf } from "../groups.ts";
import { callTool, defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

// ---- schemas ----

const Id = (what: string) => Type.String({ description: what });
const Expected = Type.Union([Type.String(), Type.Null()], { description: "The version you read (from _get or _list); null when it must not exist yet. A stale one is refused: read again and retry." });
const Files = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), { description: "Path (relative to the definition) -> the file's whole new content; null removes the file" });
const Edits = Type.Array(Type.Object({ file: Type.Optional(Type.String({ description: "Relative path; leave out for a one-file definition" })), find: Type.String({ minLength: 1 }), replace: Type.String() }, { additionalProperties: false }), {
  description: "Exact replacements, in order: find must occur exactly once in the file",
});
const Content = Type.String({ description: "The whole file, for a one-file definition (gate, listener, prompt, a file skill)" });
const Reason = Type.Optional(Type.String({ description: "Why: kept in the history and the feed" }));
const KindT = Type.Union(KINDS.map((k) => Type.Literal(k)));

interface ContentArgs {
  files?: Record<string, string | null>;
  edits?: { file?: string; find: string; replace: string }[];
  content?: string;
}

const ContentFields = { files: Type.Optional(Files), edits: Type.Optional(Edits), content: Type.Optional(Content) };

// ---- helpers ----

function where(ctx: ToolContext, kind: Kind, id: string): Def {
  try {
    return locate(kind, id, agenticsOf(ctx));
  } catch (err) {
    throw new ToolError("invalid", (err as Error).message);
  }
}

function mustRead(def: Def): FileSet {
  const files = readFileSet(def);
  if (!files) throw new ToolError("failed", `no ${def.kind} ${def.id} (${def.path})`);
  return files;
}

const count = (s: string, find: string) => s.split(find).length - 1;

/** The files after `args` change `current`. Throws a ToolError naming what does not apply. */
function applyContent(def: Def, current: FileSet | null, a: ContentArgs, required: boolean): FileSet {
  const out: FileSet = new Map(current ?? []);
  const only = def.single ? [...(current?.keys() ?? [])][0] ?? def.path.split("/").pop()! : null;
  if (required && a.files === undefined && a.edits === undefined && a.content === undefined) throw new ToolError("invalid", `${def.kind}_${current ? "update" : "create"}: give files, edits or content`);
  if (a.content !== undefined) {
    if (!only) throw new ToolError("invalid", `${def.kind} ${def.id} is a directory: give files (path -> content) or edits, not content`);
    out.set(only, Buffer.from(a.content));
  }
  for (const [rel, text] of Object.entries(a.files ?? {})) {
    if (only && rel !== only) throw new ToolError("invalid", `${def.kind} ${def.id} is one file, ${only}: give content (or files with that name)`);
    if (text === null) out.delete(rel);
    else out.set(rel.replace(/^\.\//, ""), Buffer.from(text));
  }
  for (const [i, e] of (a.edits ?? []).entries()) {
    const file = e.file ?? only;
    if (!file) throw new ToolError("invalid", `edits[${i}]: name the file`);
    const old = out.get(file);
    if (!old) throw new ToolError("invalid", `edits[${i}]: ${file} is not in ${def.kind} ${def.id}`);
    const text = old.toString("utf8");
    const n = count(text, e.find);
    if (n !== 1) throw new ToolError("invalid", `edits[${i}]: the text to find occurs ${n} times in ${file} (it must occur exactly once)`);
    out.set(file, Buffer.from(text.replace(e.find, () => e.replace)));
  }
  return out;
}

/** Text of a file, or a note for one that is not text. */
const textOf = (b: Buffer): string => (b.includes(0) ? `(binary, ${b.length} bytes)` : b.toString("utf8"));

function describe(def: Def, files: FileSet, file?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: def.kind,
    id: def.id,
    path: def.path,
    version: versionOf(files, def.single),
    files: [...files].map(([path, b]) => ({ path, bytes: b.length })),
  };
  if (def.single) out.content = textOf([...files.values()][0]);
  else if (file !== undefined) {
    const b = files.get(file.replace(/^\.\//, ""));
    if (!b) throw new ToolError("failed", `${file} is not in ${def.kind} ${def.id} (files lists them)`);
    out.file = file;
    out.content = textOf(b);
  }
  return out;
}

function run(ctx: ToolContext, tool: string, args: object, def: Def, op: Op, expectedVersion: string | null, next: ChangeRequest["next"], reason?: string) {
  return change(ctx, { tool, args: args as Record<string, unknown>, def, op, expectedVersion, next, ...(reason ? { reason } : {}) });
}

const plural: Record<Kind, string> = { builder: "builders", agent: "agents", skill: "skills", template: "template sets", gate: "gates", listener: "listeners", prompt: "prompt templates", active: "active builder" };

/** list, get, create, update, delete for a resource kind. */
function resourceTools(kind: Kind, idHelp: string, where_: string): ToolDef[] {
  return [
    defineTool({
      name: `${kind}_list`,
      group: "definitions",
      description: `List the ${plural[kind]} (${where_}) with their versions.`,
      params: Type.Object({}, { additionalProperties: false }),
      run: async (_a: Record<string, never>, ctx: ToolContext) => {
        const agentics = agenticsOf(ctx);
        return { [plural[kind].replace(/ /g, "_")]: listIds(kind, agentics).map((id) => ({ id, version: currentVersion(locate(kind, id, agentics)) })) };
      },
    }),
    defineTool({
      name: `${kind}_get`,
      group: "definitions",
      description: `One ${kind} with its version and files; for a directory, give file to read one.`,
      params: Type.Object({ id: Id(idHelp), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
      run: async (a: { id: string; file?: string }, ctx: ToolContext) => {
        const def = where(ctx, kind, a.id);
        return describe(def, mustRead(def), a.file);
      },
    }),
    defineTool({
      name: `${kind}_create`,
      group: "definitions",
      description: `Create a ${kind}: validated before it is written. Gives its version and what loads it.`,
      params: Type.Object({ id: Id(idHelp), ...ContentFields, reason: Reason }, { additionalProperties: false }),
      run: async (a: { id: string; reason?: string } & ContentArgs, ctx: ToolContext) => {
        const def = where(ctx, kind, a.id);
        return run(ctx, `${kind}_create`, a, def, "create", null, (cur) => applyContent(def, cur, a, true), a.reason);
      },
    }),
    defineTool({
      name: `${kind}_update`,
      group: "definitions",
      description: `Change a ${kind}: takes the expectedVersion you read, validates, keeps the previous version in the history. Gives the new version and what loads it (it applies from their next run).`,
      params: Type.Object({ id: Id(idHelp), expectedVersion: Expected, ...ContentFields, reason: Reason }, { additionalProperties: false }),
      run: async (a: { id: string; expectedVersion: string | null; reason?: string } & ContentArgs, ctx: ToolContext) => {
        const def = where(ctx, kind, a.id);
        return run(ctx, `${kind}_update`, a, def, "update", a.expectedVersion, (cur) => {
          if (!cur) throw new ToolError("failed", `no ${kind} ${a.id}: create it with ${kind}_create`);
          return applyContent(def, cur, a, true);
        }, a.reason);
      },
    }),
    defineTool({
      name: `${kind}_delete`,
      group: "definitions",
      description: `Delete a ${kind}: takes expectedVersion, refused while anything valid loads it, keeps it in the history (history_rollback restores it).`,
      params: Type.Object({ id: Id(idHelp), expectedVersion: Type.String(), reason: Reason }, { additionalProperties: false }),
      run: async (a: { id: string; expectedVersion: string; reason?: string }, ctx: ToolContext) => run(ctx, `${kind}_delete`, a, where(ctx, kind, a.id), "delete", a.expectedVersion, () => null, a.reason),
    }),
  ];
}

// ---- builders ----

const builderList = defineTool({
  name: "builder_list",
  group: "definitions",
  description: "List the builders (agentics/builders/) with their versions, and which one the build server runs: the machine config's server.builder when the operator pinned it, else active.yml, else the default.",
  params: Type.Object({}, { additionalProperties: false }),
  run: async (_a: Record<string, never>, ctx: ToolContext) => {
    const agentics = agenticsOf(ctx);
    const active = activeBuilder(ctx.config, agentics);
    const activeDef = locate("active", "builder", agentics);
    return {
      active: { ...active, activeYml: { path: activeDef.path, version: currentVersion(activeDef) } },
      builders: listIds("builder", agentics).map((id) => ({ id, version: currentVersion(locate("builder", id, agentics)), active: id === active.id })),
    };
  },
});

const builderGet = defineTool({
  name: "builder_get",
  group: "definitions",
  description: "One builder: its version, files, whether it is active, and its workflow (name, provides, steps) loaded in a separate process. Give file to read one.",
  params: Type.Object({ id: Id("A builder id"), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
  run: async (a: { id: string; file?: string }, ctx: ToolContext) => {
    const def = where(ctx, "builder", a.id);
    const out = describe(def, mustRead(def), a.file);
    const b = await checkBuilder(a.id, realTree(agenticsOf(ctx)));
    return { ...out, active: activeBuilder(ctx.config, agenticsOf(ctx)).id === a.id, definition: b.ok ? { name: b.name, provides: b.provides, steps: b.steps } : { error: b.error } };
  },
});

const builderCreate = defineTool({
  name: "builder_create",
  group: "definitions",
  description: "Create a builder (agentics/builders/<id>/ with a builder.ts whose default export is the workflow): type-checked, loaded and its template sets rendered before it is written.",
  params: Type.Object({ id: Id("The new builder's id (one path segment)"), files: Files, reason: Reason }, { additionalProperties: false }),
  run: async (a: { id: string; files: Record<string, string | null>; reason?: string }, ctx: ToolContext) => {
    const def = where(ctx, "builder", a.id);
    return run(ctx, "builder_create", a, def, "create", null, (cur) => applyContent(def, cur, a, true), a.reason);
  },
});

const builderClone = defineTool({
  name: "builder_clone",
  group: "definitions",
  description: "Copy a builder (every file, its templates included) under a new id, to change it without touching the original. builder_activate makes the server run it.",
  params: Type.Object({ from: Id("The builder to copy"), id: Id("The new builder's id"), reason: Reason }, { additionalProperties: false }),
  run: async (a: { from: string; id: string; reason?: string }, ctx: ToolContext) => {
    const source = mustRead(where(ctx, "builder", a.from));
    return run(ctx, "builder_clone", a, where(ctx, "builder", a.id), "clone", null, () => new Map(source), a.reason ?? `cloned from ${a.from}`);
  },
});

const builderUpdate = defineTool({
  name: "builder_update",
  group: "definitions",
  description:
    "Change a builder's files: takes the expectedVersion you read, type-checks changed modules, loads it in a separate process, renders its template sets against the sample dispatches, keeps the previous version. Jobs already running keep theirs (E1).",
  params: Type.Object({ id: Id("A builder id"), expectedVersion: Expected, files: Type.Optional(Files), edits: Type.Optional(Edits), reason: Reason }, { additionalProperties: false }),
  run: async (a: { id: string; expectedVersion: string | null; reason?: string } & ContentArgs, ctx: ToolContext) => {
    const def = where(ctx, "builder", a.id);
    return run(ctx, "builder_update", a, def, "update", a.expectedVersion, (cur) => {
      if (!cur) throw new ToolError("failed", `no builder ${a.id}: create it with builder_create or builder_clone`);
      return applyContent(def, cur, a, true);
    }, a.reason);
  },
});

const builderActivate = defineTool({
  name: "builder_activate",
  group: "definitions",
  description: "Make a builder the one the build server runs from its next job (agentics/builders/active.yml, versioned: expectedVersion is active.yml's from builder_list, null when there is none). The machine config's server.builder, when the operator set it, still wins.",
  params: Type.Object({ id: Id("The builder to activate"), expectedVersion: Expected, reason: Reason }, { additionalProperties: false }),
  run: async (a: { id: string; expectedVersion: string | null; reason?: string }, ctx: ToolContext) => {
    where(ctx, "builder", a.id);
    const def = where(ctx, "active", "builder");
    const out = await run(ctx, "builder_activate", a, def, "activate", a.expectedVersion, () => new Map([["active.yml", Buffer.from(`# The builder the build server runs (builder_activate). The machine config's server.builder wins when the operator sets it.\nbuilder: ${a.id}\n`)]]), a.reason);
    const now = activeBuilder(ctx.config, agenticsOf(ctx));
    return { ...out, builder: a.id, ...(now.source === "config" && now.id !== a.id ? { pinned: { by: now.layer, builder: now.id, note: "the operator pinned server.builder in the machine config: the server runs that one until the pin is removed" } } : {}) };
  },
});

const builderDelete = defineTool({
  name: "builder_delete",
  group: "definitions",
  description: "Delete a builder: takes expectedVersion; refused for the active builder and for one another builder runs as a step. Kept in the history.",
  params: Type.Object({ id: Id("A builder id"), expectedVersion: Type.String(), reason: Reason }, { additionalProperties: false }),
  run: async (a: { id: string; expectedVersion: string; reason?: string }, ctx: ToolContext) => {
    const active = activeBuilder(ctx.config, agenticsOf(ctx));
    if (active.id === a.id) throw new ToolError("refused", `builder ${a.id} is the active builder (${active.source === "config" ? `pinned by ${active.layer}` : active.source}): activate another one first`);
    return run(ctx, "builder_delete", a, where(ctx, "builder", a.id), "delete", a.expectedVersion, () => null, a.reason);
  },
});

// ---- agents ----

const agentList = defineTool({
  name: "agent_list",
  group: "definitions",
  description: "List the agents in the tree (agentics/agents/, any depth): id, description, mode, version.",
  params: Type.Object({ under: Type.Optional(Type.String({ description: "Only agents under this folder, e.g. dev" })) }, { additionalProperties: false }),
  run: async (a: { under?: string }, ctx: ToolContext) => {
    const agentics = agenticsOf(ctx);
    const ids = listAgents(agentics).filter((id) => !a.under || id === a.under || id.startsWith(`${a.under.replace(/\/$/, "")}/`));
    return {
      agents: ids.map((id) => {
        try {
          const y = loadAgent(id, agentics).yml;
          return { id, description: y.description, mode: y.mode ?? "headless", version: currentVersion(locate("agent", id, agentics)) };
        } catch (err) {
          return { id, error: (err as Error).message, version: currentVersion(locate("agent", id, agentics)) };
        }
      }),
      templates: agentTemplates(agentics),
    };
  },
});

const agentGet = defineTool({
  name: "agent_get",
  group: "definitions",
  description: "One agent, resolved: agent.yml merged over defaults.yml and what it extends, the tools it asks for and those the machine limit leaves it, every skill, extension, prompt and gate it loads with its hash, its version and files. Give file to read one.",
  params: Type.Object({ id: Id("An agent id (its path under agentics/agents/)"), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
  run: async (a: { id: string; file?: string }, ctx: ToolContext) => {
    const agentics = agenticsOf(ctx);
    const def = where(ctx, "agent", a.id);
    const out = describe(def, mustRead(def), a.file);
    try {
      const loaded = loadAgent(a.id, agentics);
      const r = resolve({ agent: a.id, workspace: "none", mode: "rpc" }, { config: { limit: NO_LIMIT }, agentics, runDir: "<runDir>" });
      const limit = toolsOf(ctx.config.limit);
      return {
        ...out,
        resolved: {
          yml: loaded.yml,
          defaults: loaded.defaults,
          tools: r.tools,
          toolsInLimit: r.tools.filter((t) => limit.includes(t)),
          resources: r.resources,
          areas: r.areas,
          ...(r.writes ? { writes: r.writes } : {}),
          mayStart: r.mayStart,
          settings: r.settings,
          changes: loaded.yml.definitions?.changes ?? "write",
        },
      };
    } catch (err) {
      return { ...out, error: (err as Error).message };
    }
  },
});

/** The agent templates in shared/agent-templates/. */
export function agentTemplates(agentics: string): string[] {
  const dir = join(agentics, "shared", "agent-templates");
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory()).sort() : [];
}

/** A template's files with {{id}}, {{name}} and {{description}} filled in (quoted in YAML files). */
function fromTemplate(agentics: string, template: string, vars: Record<string, string>): FileSet {
  const dir = join(agentics, "shared", "agent-templates", template);
  if (!/^[\w.-]+$/.test(template) || !existsSync(dir)) throw new ToolError("invalid", `no agent template ${template} (templates: ${agentTemplates(agentics).join(", ") || "none"})`);
  const out: FileSet = new Map();
  for (const [rel, b] of readDirSet(dir)) {
    const yml = /\.ya?ml$/.test(rel);
    const fill = (_m: string, k: string) => (yml && k === "description" ? JSON.stringify(vars[k]) : vars[k]);
    out.set(rel, b.includes(0) ? b : Buffer.from(b.toString("utf8").replace(/\{\{(id|name|description)\}\}/g, fill)));
  }
  return out;
}

const agentCreate = defineTool({
  name: "agent_create",
  group: "definitions",
  description: "Create an agent at a path in the tree from a template in agentics/shared/agent-templates/ (default basic): agent.yml, SYSTEM.md, prompts/. files adds or replaces files of the template. Validated before it is written.",
  params: Type.Object(
    {
      path: Id("The new agent's id: its path under agentics/agents/, e.g. dev/my-agent"),
      template: Type.Optional(Type.String({ description: "A folder in agentics/shared/agent-templates/ (default basic)" })),
      description: Type.Optional(Type.String({ description: "The agent.yml description" })),
      files: Type.Optional(Files),
      reason: Reason,
    },
    { additionalProperties: false },
  ),
  run: async (a: { path: string; template?: string; description?: string; files?: Record<string, string | null>; reason?: string }, ctx: ToolContext) => {
    const agentics = agenticsOf(ctx);
    const def = where(ctx, "agent", a.path);
    if (existsSync(def.path) && !existsSync(join(def.path, "agent.yml")) && readFileSet(def)) throw new ToolError("refused", `agentics/agents/${a.path} holds files and is not an agent (a folder that groups agents, with defaults.yml?): choose another path`);
    const name = a.path.split("/").pop()!;
    const template = a.template ?? "basic";
    const base = fromTemplate(agentics, template, { id: a.path, name, description: (a.description ?? `${name}: describe what this agent does`).replace(/\n/g, " ") });
    const out = await run(ctx, "agent_create", a, def, "create", null, () => applyContent(def, base, { ...(a.files ? { files: a.files } : {}) }, false), a.reason ?? `from template ${template}`);
    return { ...out, path: def.path, template, files: [...(readFileSet(def)?.keys() ?? [])] };
  },
});

const agentUpdate = defineTool({
  name: "agent_update",
  group: "definitions",
  description:
    "Change an agent's files (agent.yml, SYSTEM.md, prompts, settings.json for its model, its own extensions): takes the expectedVersion you read, validates (agent.yml schema, references resolve, changed modules type-check). Refused when it would widen your own agent or a run above you (E25). Applies from the agent's next run.",
  params: Type.Object({ id: Id("An agent id"), expectedVersion: Expected, ...ContentFields, reason: Reason }, { additionalProperties: false }),
  run: async (a: { id: string; expectedVersion: string | null; reason?: string } & ContentArgs, ctx: ToolContext) => {
    const def = where(ctx, "agent", a.id);
    return run(ctx, "agent_update", a, def, "update", a.expectedVersion, (cur) => {
      if (!cur) throw new ToolError("failed", `no agent ${a.id}: create it with agent_create`);
      return applyContent(def, cur, a, true);
    }, a.reason);
  },
});

const agentDelete = defineTool({
  name: "agent_delete",
  group: "definitions",
  description: "Delete an agent's definition files: takes expectedVersion; refused while a builder runs it or another agent extends it. Its data/, state/ and nested agents stay. Kept in the history.",
  params: Type.Object({ id: Id("An agent id"), expectedVersion: Type.String(), reason: Reason }, { additionalProperties: false }),
  run: async (a: { id: string; expectedVersion: string; reason?: string }, ctx: ToolContext) => run(ctx, "agent_delete", a, where(ctx, "agent", a.id), "delete", a.expectedVersion, () => null, a.reason),
});

// ---- versions ----

const definitionsValidate = defineTool({
  name: "definitions_validate",
  group: "definitions",
  description: "Validate definitions as they are, without changing anything: one (kind and id), every one of a kind, or all. The same checks a change gets: schema, references, type-check, templates rendered against the sample dispatches.",
  params: Type.Object({ kind: Type.Optional(KindT), id: Type.Optional(Type.String()) }, { additionalProperties: false }),
  run: async (a: { kind?: Kind; id?: string }, ctx: ToolContext) => {
    if (a.id && !a.kind) throw new ToolError("invalid", "an id needs its kind");
    const agentics = agenticsOf(ctx);
    const tree = realTree(agentics);
    const defs = a.kind && a.id ? [where(ctx, a.kind, a.id)] : (a.kind ? [a.kind] : KINDS).flatMap((k) => listIds(k, agentics).map((id) => locate(k, id, agentics)));
    const info = await inspectTree(tree);
    const ts = defs.flatMap((d) => tsFilesOf(d, readFileSet(d) ?? new Map()));
    let tsErrors: TsError[] = [];
    let tsProblem: string | null = null;
    try {
      tsErrors = await typeCheck(ts, tree);
    } catch (err) {
      tsProblem = (err as Error).message;
    }
    const results = [];
    for (const d of defs) {
      const r = await checkDefinition(d, tree, info, tsErrors);
      if (tsProblem && tsFilesOf(d, readFileSet(d) ?? new Map()).length) r.errors.push(tsProblem);
      results.push({ kind: d.kind, id: d.id, version: currentVersion(d), ok: !r.errors.length, errors: r.errors, warnings: r.warnings });
    }
    return { ok: results.every((r) => r.ok), checked: results.length, failed: results.filter((r) => !r.ok).length, results };
  },
});

const historyList = defineTool({
  name: "history_list",
  group: "definitions",
  description: "Earlier versions of a definition (agentics/history/<kind>/<id>/), newest first: version, when, who replaced it and with what.",
  params: Type.Object({ kind: KindT, id: Type.String() }, { additionalProperties: false }),
  run: async (a: { kind: Kind; id: string }, ctx: ToolContext) => {
    const def = where(ctx, a.kind, a.id);
    return { kind: a.kind, id: a.id, current: currentVersion(def), entries: listHistory(def.agentics, a.kind, a.id) };
  },
});

const historyDiff = defineTool({
  name: "history_diff",
  group: "definitions",
  description: "The difference between two versions of a definition, as a unified diff: from (default the newest in the history) to (default current). A version may be shortened to 6 or more characters.",
  params: Type.Object({ kind: KindT, id: Type.String(), from: Type.Optional(Type.String()), to: Type.Optional(Type.String({ description: "A version, or current" })) }, { additionalProperties: false }),
  run: async (a: { kind: Kind; id: string; from?: string; to?: string }, ctx: ToolContext) => {
    const def = where(ctx, a.kind, a.id);
    const at = (v: string): { label: string; files: FileSet | null } => {
      if (v === "current") {
        const files = readFileSet(def);
        return { label: `current ${files ? versionOf(files, def.single) : "(none)"}`, files };
      }
      try {
        const e = findHistory(def.agentics, a.kind, a.id, v);
        return { label: `${e.version} (${e.savedAt})`, files: historyFiles(e) };
      } catch (err) {
        throw new ToolError("failed", (err as Error).message);
      }
    };
    const newest = listHistory(def.agentics, a.kind, a.id)[0];
    const from = a.from ?? newest?.version;
    if (!from) throw new ToolError("failed", `${a.kind} ${a.id} has no history yet`);
    const x = at(from);
    const y = at(a.to ?? "current");
    return { kind: a.kind, id: a.id, from: x.label, to: y.label, diff: diffSets(x.files, y.files, { a: x.label, b: y.label }) || "(no difference)" };
  },
});

const historyRollback = defineTool({
  name: "history_rollback",
  group: "definitions",
  description: "Restore an earlier version of a definition from its history, as a change like any other: takes the expectedVersion of what is there now (null when it was deleted), validates, keeps the current version in the history.",
  params: Type.Object({ kind: KindT, id: Type.String(), version: Type.String({ description: "The version to restore (history_list)" }), expectedVersion: Expected, reason: Reason }, { additionalProperties: false }),
  run: async (a: { kind: Kind; id: string; version: string; expectedVersion: string | null; reason?: string }, ctx: ToolContext) => {
    const def = where(ctx, a.kind, a.id);
    let files: FileSet;
    try {
      files = historyFiles(findHistory(def.agentics, a.kind, a.id, a.version));
    } catch (err) {
      throw new ToolError("failed", (err as Error).message);
    }
    return run(ctx, "history_rollback", a, def, "rollback", a.expectedVersion, () => files, a.reason ?? `rolled back to ${a.version}`);
  },
});

// ---- change sets ----

const changesetList = defineTool({
  name: "changeset_list",
  group: "definitions",
  description: "Change sets agents in propose mode saved (agentics/changesets/), newest first; give id for one with its diff.",
  params: Type.Object({ id: Type.Optional(Type.String()), state: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("applied")])) }, { additionalProperties: false }),
  run: async (a: { id?: string; state?: "proposed" | "applied" }, ctx: ToolContext) => {
    const agentics = agenticsOf(ctx);
    if (a.id) {
      try {
        return readChangeSet(agentics, a.id);
      } catch (err) {
        throw new ToolError("failed", (err as Error).message);
      }
    }
    return { changesets: listChangeSets(agentics).filter((c) => !a.state || c.state === a.state).map(({ diff: _diff, args: _args, ...c }) => c) };
  },
});

const changesetApply = defineTool({
  name: "changeset_apply",
  group: "definitions",
  description: "Apply a change set an agent with definitions: { changes: propose } saved: its change is made as if its tool were called now, with the same arguments (a stale base version is refused). For the operator and UIs.",
  params: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  run: async (a: { id: string }, ctx: ToolContext) => {
    const agentics = agenticsOf(ctx);
    let cs;
    try {
      cs = readChangeSet(agentics, a.id);
    } catch (err) {
      throw new ToolError("failed", (err as Error).message);
    }
    if (cs.state !== "proposed") throw new ToolError("failed", `change set ${a.id} was ${cs.state}${cs.appliedAt ? ` at ${cs.appliedAt}` : ""}`);
    const proposer = proposes(ctx);
    if (proposer) throw new ToolError("refused", `agent ${proposer} proposes changes: a change set is applied by the operator`);
    if (!ctx.caller.allowed.has(cs.tool)) throw new ToolError("refused", `change set ${a.id} is a ${cs.tool}, which is not allowed for this caller`);
    const c: ToolContext = { ...ctx };
    applying.set(c, a.id);
    const result = (await callTool(cs.tool, cs.args, c)) as { version?: string | null };
    updateChangeSet(agentics, { ...cs, state: "applied", appliedAt: new Date().toISOString(), appliedBy: callerOf(ctx), version: result.version ?? null });
    return { changeset: a.id, applied: true, result };
  },
});

export const tools: ToolDef[] = [
  builderList,
  builderGet,
  builderCreate,
  builderClone,
  builderUpdate,
  builderActivate,
  builderDelete,
  agentList,
  agentGet,
  agentCreate,
  agentUpdate,
  agentDelete,
  ...resourceTools("skill", "A shared skill: its path under agentics/shared/skills/, e.g. build/build-state-change", "agentics/shared/skills/"),
  ...resourceTools("template", "<builder>/<set> (agentics/builders/<builder>/templates/<set>/) or shared/<set> (agentics/shared/templates/<set>/)", "builders' templates/ and shared/templates/"),
  ...resourceTools("gate", "A shared gate: its file name under agentics/shared/gates/ without .ts", "agentics/shared/gates/"),
  ...resourceTools("listener", "A shared listener: its file name under agentics/shared/listeners/ without .ts", "agentics/shared/listeners/"),
  ...resourceTools("prompt", "<agent id>/<name> (the agent's prompts/<name>.md) or shared/<name> (agentics/shared/prompts/)", "agents' prompts/ and shared/prompts/"),
  definitionsValidate,
  historyList,
  historyDiff,
  historyRollback,
  changesetList,
  changesetApply,
];
