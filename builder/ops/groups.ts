/**
 * Tool groups and the tool names an agent.yml or a machine config layer may name: the one map of groups to tools. A
 * name that is a group expands to its tools; `tool:<name>` names one tool even when a group has the same name (the
 * project's `git` tool versus the `git` group); `*` is every tool. A name that is neither is an error, so a typo never
 * silently grants nothing.
 *
 * Two kinds of group:
 *   - pi-native and extension tools, listed here: files (pi's own), project (shared:project-tools), outcome
 *     (shared:outcome), plus standalone extension tools that belong to no group;
 *   - ops/core groups (observe, runs, messaging, operate, process, definitions, verify, git, notify), fed by the
 *     registry in ops/core/index.ts: each group module names its own tools.
 *
 * The map is built on first use (the registry's modules import the config and the runtime, which import this file).
 */
import { coreGroups } from "./core/index.ts";

/** Tools pi or an extension in the tree provides, by group (not ops/core functions). */
function nativeGroups(): Record<string, readonly string[]> {
  return {
    files: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    project: ["git", "npm", "npx", "docker"],
    outcome: ["done", "halt"],
  };
}

/** Tools an extension in the tree registers that belong to no group. */
export function standaloneTools(): readonly string[] {
  return ["capture-learning", "fetch_docs", "try_rules"];
}

let cache: { groups: Readonly<Record<string, readonly string[]>>; all: readonly string[] } | null = null;

function load(): { groups: Readonly<Record<string, readonly string[]>>; all: readonly string[] } {
  if (cache) return cache;
  const native = nativeGroups();
  const core = coreGroups();
  for (const g of Object.keys(core)) if (g in native) throw new Error(`group ${g} is both pi-native and ops/core`);
  const groups: Record<string, readonly string[]> = { ...native, ...core };
  const all = [...new Set([...Object.values(groups).flat(), ...standaloneTools()])];
  cache = { groups, all };
  return cache;
}

/** Every group and its tools, in order: files, project, outcome, then the ops/core groups. */
export function groups(): Readonly<Record<string, readonly string[]>> {
  return load().groups;
}

/** Every tool name, in group order then the standalone ones. */
export function allTools(): readonly string[] {
  return load().all;
}

/** The group a tool belongs to, or null for a standalone tool or an unknown name. */
export function groupOf(tool: string): string | null {
  for (const [g, tools] of Object.entries(groups())) if (tools.includes(tool)) return g;
  return null;
}

/** Why `name` cannot be named in a tools list, or null when it can. */
export function unknownToolName(name: string): string | null {
  if (name === "*" || name in groups()) return null;
  const tool = name.startsWith("tool:") ? name.slice(5) : name;
  return allTools().includes(tool) ? null : `unknown tool or group "${name}"`;
}

/** The tools a list of names stands for, in order, without duplicates. Throws on a name that is not known. */
export function expandTools(names: readonly string[]): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (!out.includes(t)) out.push(t);
  };
  const g = groups();
  for (const name of names) {
    const why = unknownToolName(name);
    if (why) throw new Error(why);
    if (name === "*") allTools().forEach(add);
    else if (name in g) g[name].forEach(add);
    else add(name.startsWith("tool:") ? name.slice(5) : name);
  }
  return out;
}

export interface ToolLimit {
  enable: string[];
  disable: string[];
}

/** enable minus disable, expanded. */
export function toolsOf(t: { enable?: readonly string[]; disable?: readonly string[] } | undefined): string[] {
  const off = expandTools(t?.disable ?? []);
  return expandTools(t?.enable ?? []).filter((x) => !off.includes(x));
}
