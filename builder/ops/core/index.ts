/**
 * The registry of ops/core tools: one module per group, each exporting `tools: ToolDef[]`. ops/groups.ts derives the
 * core groups from here, so a group module is the only file that names its tools (a new tool is one entry in one file).
 *
 *   observe      ops/core/observe.ts       built (P5)
 *   runs         ops/core/runs.ts          built (P5)
 *   operate      ops/core/operate.ts       built (P5)
 *   process      ops/core/process.ts       the process part of P5
 *   definitions  ops/core/definitions.ts   the definitions part of P5
 *   verify       ops/core/verify.ts        the verify part of P5
 *   git          ops/core/git.ts           the process part of P5
 *   messaging    ops/core/messaging.ts     built (P6)
 *   notify       ops/core/notify.ts        built (P6)
 *
 * The registry is built on first use, not at load: group modules import the runtime and the config, which import
 * ops/groups.ts, which reads this registry.
 */
import { tools as definitions } from "./definitions.ts";
import { tools as git } from "./git.ts";
import { tools as messaging } from "./messaging.ts";
import { tools as notify } from "./notify.ts";
import { tools as observe } from "./observe.ts";
import { tools as operate } from "./operate.ts";
import { tools as processTools } from "./process.ts";
import { tools as runs } from "./runs.ts";
import type { GroupName, ToolDef } from "./tool.ts";
import { tools as verify } from "./verify.ts";

export { callTool, isToolError, listTools, ToolError, type Caller, type GroupName, type ToolContext, type ToolDef, type ToolInfo } from "./tool.ts";

/** The core groups, in the order `*` and `builder tools` list them. */
export function coreGroupOrder(): GroupName[] {
  return ["verify", "observe", "runs", "messaging", "operate", "process", "definitions", "git", "notify"];
}

let built: Map<string, ToolDef> | null = null;

/** Every ops/core tool by name, in group order. Throws when a module registers a tool twice or in another group. */
export function registry(): ReadonlyMap<string, ToolDef> {
  if (built) return built;
  const modules: Record<string, ToolDef[]> = { verify, observe, runs, messaging, operate, process: processTools, definitions, git, notify };
  const m = new Map<string, ToolDef>();
  for (const group of coreGroupOrder()) {
    for (const t of modules[group] ?? []) {
      if (t.group !== group) throw new Error(`ops/core/${group}.ts registers ${t.name} in group ${t.group}`);
      if (!/^[a-z][a-z0-9_]*$/.test(t.name)) throw new Error(`ops/core/${group}.ts: ${t.name} is not a snake_case tool name`);
      if (m.has(t.name)) throw new Error(`tool ${t.name} is registered twice`);
      m.set(t.name, t);
    }
  }
  built = m;
  return m;
}

/** The core groups and their tool names (ops/groups.ts merges them with the pi-native groups). */
export function coreGroups(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of coreGroupOrder()) out[g] = [];
  for (const t of registry().values()) out[t.group].push(t.name);
  return out;
}

/** An ops/core tool that is built (not a stub): the runner loads ops/pi-extension.ts for a run that has one. */
export function isAvailableCoreTool(name: string): boolean {
  const d = registry().get(name);
  return !!d && !d.stub;
}
