/**
 * One change to one definition, the same way for every change tool (design section 9, D10, E15, E25):
 *
 *   1. take the definition's lock; refuse a stale `expectedVersion` (E15: re-read and retry)
 *   2. build the new files from the current ones; nothing changes when they are the same
 *   3. stage the change in a copy of the agent tree; refuse when it widens the calling agent or a run above it (E25)
 *   4. validate the copy (ops/definitions/validate.ts); refuse when the definition fails or something else breaks
 *   5. a caller in propose mode (`definitions: { changes: propose }` in its agent.yml, or in a run above it) gets a
 *      change set in agentics/changesets/ instead; the operator applies it with changeset_apply
 *   6. otherwise keep the previous version in agentics/history/, write the files, and journal `definition.changed` in
 *      the machine feed and the caller's journal
 *
 * The result names the new version and what the change affects: the agents and builders that load the definition.
 * Runs pin what they started with (D10, E1), so a change applies from the next run.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { journalSend } from "../../runtime/journal-client.ts";
import { appendFeed } from "../../runtime/feed.ts";
import { loadAgent } from "../../runtime/resolve.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { runsDirOf } from "../core/common.ts";
import { ToolError, type ToolContext } from "../core/tool.ts";
import { inTree, notDefinitionFile, readFileSet, versionOf, type Def, type FileSet } from "./kinds.ts";
import { diffSets, saveChangeSet, saveHistory, withLock, writeFileSet, type Caller } from "./store.ts";
import { affectsOf, gatesOf, realTree, stage, stageChange, tsFilesOf, validateStaged, widening } from "./validate.ts";

export type Op = "create" | "update" | "delete" | "rollback" | "activate" | "clone";

export interface ChangeRequest {
  /** The tool making the change, and its arguments (a change set calls it again with them). */
  tool: string;
  args: Record<string, unknown>;
  def: Def;
  op: Op;
  /** The version the caller read; null: the definition must not exist yet. */
  expectedVersion: string | null;
  /** The new files from the current ones (null: delete). Called under the lock. Throws a ToolError when it cannot. */
  next(current: FileSet | null): FileSet | null;
  reason?: string;
}

export interface ChangeResult {
  kind: string;
  id: string;
  change: Op;
  /** The version written (null: deleted), or for a proposal the version it would write. */
  version: string | null;
  previous: string | null;
  affects: { agents: string[]; builders: string[] };
  /** Where the previous version is kept. */
  history?: string;
  unchanged?: true;
  proposed?: true;
  changeset?: string;
  diff?: string;
  warnings?: string[];
}

/** The agent tree a context works on. */
export const agenticsOf = (ctx: ToolContext): string => ctx.runtime.options.agenticsDir ?? AGENTICS_DIR;

/** Who made a change, as history and change sets record it. */
export function callerOf(ctx: ToolContext): Caller {
  const c = ctx.caller;
  return { kind: c.kind, ...(c.runId ? { runId: c.runId } : {}), ...(c.agent ? { agent: c.agent } : {}) };
}

/** The agent runs from the caller up to the root of its tree (E25 and propose mode). The CLI has none. */
export function callerChain(ctx: ToolContext): { runId?: string; agent: string; record?: RunRecord }[] {
  const out: { runId?: string; agent: string; record?: RunRecord }[] = [];
  if (ctx.caller.kind === "cli") return out;
  let rec = ctx.caller.runId ? ctx.runtime.get(ctx.caller.runId) : null;
  if (!rec && ctx.caller.agent) out.push({ agent: ctx.caller.agent });
  for (let depth = 0; rec && depth < 32; depth++) {
    if (rec.kind === "agent" && rec.spec.agent) out.push({ runId: rec.id, agent: rec.spec.agent, record: rec });
    rec = rec.parent ? ctx.runtime.get(rec.parent) : null;
  }
  return out;
}

/**
 * Does the caller propose rather than write? When its agent, or an agent run above it, has `definitions: { changes:
 * propose }`: as its run pinned it at start, or as its agent.yml says now (a narrowing applies at once, G6).
 */
export function proposes(ctx: ToolContext): string | null {
  const agentics = agenticsOf(ctx);
  for (const r of callerChain(ctx)) {
    if (r.record?.resolved?.changes === "propose") return r.agent;
    try {
      if (loadAgent(r.agent, agentics).yml.definitions?.changes === "propose") return r.agent;
    } catch {
      /* a broken agent.yml: its run's pinned setting decides */
    }
  }
  return null;
}

/** Is `path` (or, when it does not exist yet, its nearest existing folder) inside the tree, links resolved? */
export function insideTree(agentics: string, path: string): boolean {
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const rel = relative(realpathSync(agentics), realpathSync(probe));
    return !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Contexts applying a change set: the set's id (history and the feed name it). */
export const applying = new WeakMap<ToolContext, string>();

const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

export async function change(ctx: ToolContext, req: ChangeRequest): Promise<ChangeResult> {
  const def = req.def;
  const label = `${def.kind} ${def.id}`;
  return withLock(def, async () => {
    const current = readFileSet(def);
    const previous = current ? versionOf(current, def.single) : null;
    if (req.expectedVersion !== previous) {
      const now = previous === null ? "it does not exist" : `it is at version ${previous}`;
      const was = req.expectedVersion === null ? "you expected it not to exist" : `you expected version ${req.expectedVersion}`;
      throw new ToolError("refused", `${label} has changed: ${was}, ${now}. Read it again (${def.kind}_get or history_list) and retry with that version (E15).`);
    }
    const next = req.next(current);
    if (!next && !current) throw new ToolError("failed", `${label} does not exist`);
    for (const rel of next?.keys() ?? []) {
      const why = def.single ? null : notDefinitionFile(def, rel);
      if (why) throw new ToolError("invalid", `${label}: ${why}`);
      // A link inside the tree never takes a write outside it (the machine config, ~/.gaffer: design section 10).
      const target = def.single ? def.path : join(def.path, ...rel.split("/"));
      if (!insideTree(def.agentics, target)) throw new ToolError("refused", `${label}: ${rel} resolves outside the agent tree ${def.agentics}`);
    }
    const version = next ? versionOf(next, def.single) : null;
    if (version !== null && version === previous) return { kind: def.kind, id: def.id, change: req.op, version, previous, affects: { agents: [], builders: [] }, unchanged: true };

    const agentics = def.agentics;
    const staged = stage(agentics);
    try {
      const stagedDef = stageChange(def, next, staged);
      for (const r of callerChain(ctx)) {
        const who = r.agent === ctx.caller.agent && r.runId === ctx.caller.runId ? `the calling agent ${r.agent}` : `agent ${r.agent}${r.runId ? ` (run ${r.runId}, above the caller)` : ""}`;
        const gained = widening(r.agent, agentics, staged.agentics);
        // A gate is a limit too: an agent never changes one that it, or a run above it, loads.
        if (def.kind === "gate" && gatesOf(r.agent, agentics).includes(def.path)) gained.push(`a changed gate ${def.id}, which checks its own tool calls`);
        if (gained.length) throw new ToolError("refused", `${label}: the change would widen ${who}: it would gain ${gained.join("; ")}. An agent never raises its own limits or those of a run above it (E25, G6); the operator can.`);
      }
      const changedTs = next ? new Map([...next].filter(([rel, content]) => !current?.get(rel)?.equals(content))) : new Map();
      const { report, info } = await validateStaged(def, staged, realTree(agentics), next ? tsFilesOf(stagedDef, changedTs) : [], !next);
      if (report.errors.length) throw new ToolError("invalid", `${label}: the change does not validate, nothing was written:\n${list(report.errors)}`);
      const affects = affectsOf(next ? stagedDef : inTree(def, staged.agentics), info);
      const warnings = report.warnings.length ? { warnings: report.warnings } : {};
      const by = callerOf(ctx);

      const proposer = applying.has(ctx) ? null : proposes(ctx);
      if (proposer) {
        const diff = diffSets(current, next, { a: previous ? `${label} ${previous}` : `${label} (none)`, b: version ? `${label} ${version}` : `${label} (deleted)` });
        const cs = saveChangeSet(agentics, { by, tool: req.tool, args: req.args, kind: def.kind, defId: def.id, baseVersion: previous, version, ...(req.reason ? { reason: req.reason } : {}), diff, affects });
        appendFeed(runsDirOf(ctx), { kind: "definition.changed", ...(ctx.caller.runId ? { runId: ctx.caller.runId } : {}), data: { kind: def.kind, id: def.id, change: req.op, proposed: true, changeset: cs.id, version, previous, by, affects } });
        journalSend({ kind: "definition.changed", data: { kind: def.kind, id: def.id, change: req.op, proposed: true, changeset: cs.id, version, previous, affects } });
        return { kind: def.kind, id: def.id, change: req.op, version, previous, affects, proposed: true, changeset: cs.id, diff, ...warnings };
      }

      const changeset = applying.get(ctx);
      const history = current ? saveHistory(def, current, { by, change: { tool: req.tool, op: req.op, next: version, ...(changeset ? { changeset } : {}) }, ...(req.reason ? { reason: req.reason } : {}) }) : undefined;
      writeFileSet(def, next, current);
      const data = { kind: def.kind, id: def.id, change: req.op, version, previous, by, affects, ...(history ? { history } : {}), ...(changeset ? { changeset } : {}), ...(req.reason ? { reason: req.reason } : {}) };
      appendFeed(runsDirOf(ctx), { kind: "definition.changed", ...(ctx.caller.runId ? { runId: ctx.caller.runId } : {}), data });
      journalSend({ kind: "definition.changed", data });
      return { kind: def.kind, id: def.id, change: req.op, version, previous, affects, ...(history ? { history } : {}), ...warnings };
    } finally {
      staged.remove();
    }
  });
}
