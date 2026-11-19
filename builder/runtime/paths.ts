/**
 * Where an agent's references point. An agent is a directory under agentics/agents/ holding an agent.yml, at any
 * depth; its id is its path there (`supabase-api`, `dev/slice-lab`). A folder without an agent.yml groups agents.
 *
 *   shared:<p>       agentics/shared/<kind>/<p>: skills/, extensions/, prompts/ or gates/ by what the list loads
 *   own:<p>          the agent's directory
 *   builder:<id>/<p> agentics/builders/<id>/<p>
 *   data:<p>         the nearest data/ (see dataPath)
 *   area:<name>[/p]  an area the agent.yml declares (see areaPath)
 *
 * A `*` in a shared:, own: or builder: reference is a glob over one path segment, so `shared:build/*` loads a group.
 * An extension or gate may leave out `.ts` (or name a directory with an index.ts), a prompt may leave out `.md`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENTICS_DIR } from "./root.ts";

export type RefKind = "skill" | "extension" | "prompt" | "gate" | "system";

const KIND_DIR: Record<RefKind, string> = { skill: "skills", extension: "extensions", prompt: "prompts", gate: "gates", system: "prompts" };

export const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, homedir());

export const agentsRoot = (agentics = AGENTICS_DIR): string => join(agentics, "agents");

const ID = /^[\w.-]+(\/[\w.-]+)*$/;

/** The agent's directory. Throws unless `id` names a directory with an agent.yml. */
export function agentDir(id: string, agentics = AGENTICS_DIR): string {
  if (!ID.test(id) || id.split("/").some((s) => s === "." || s === "..")) throw new Error(`"${id}" is not an agent id (a path under agentics/agents/)`);
  const dir = join(agentsRoot(agentics), id);
  if (!existsSync(join(dir, "agent.yml"))) throw new Error(`no agent ${id}: ${join(dir, "agent.yml")} does not exist`);
  return dir;
}

export function isAgent(id: string, agentics = AGENTICS_DIR): boolean {
  try {
    agentDir(id, agentics);
    return true;
  } catch {
    return false;
  }
}

/** Every agent id in the tree, sorted. */
export function listAgents(agentics = AGENTICS_DIR): string[] {
  const root = agentsRoot(agentics);
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || ["data", "state", "prompts", "extensions", "bin", "skills"].includes(e.name)) continue;
      const sub = join(dir, e.name);
      if (existsSync(join(sub, "agent.yml"))) out.push(relative(root, sub).split(sep).join("/"));
      walk(sub);
    }
  };
  walk(root);
  return out.sort();
}

/** The folders from the agents root down to the agent's parent, for defaults.yml (root first). */
export function foldersAbove(dir: string, agentics = AGENTICS_DIR): string[] {
  const root = agentsRoot(agentics);
  const rel = relative(root, dirname(dir));
  if (rel.startsWith("..") || isAbsolute(rel)) return [];
  const parts = rel ? rel.split(sep) : [];
  return [root, ...parts.map((_, i) => join(root, ...parts.slice(0, i + 1)))];
}

// ---- resource references ----

function globSegment(dir: string, pattern: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && re.test(n))
    .sort()
    .map((n) => join(dir, n));
}

/** Expand `*` segment by segment. */
function glob(base: string, rel: string): string[] {
  let paths = [base];
  for (const seg of rel.split("/").filter(Boolean)) paths = seg.includes("*") ? paths.flatMap((p) => globSegment(p, seg)) : paths.map((p) => join(p, seg));
  return paths;
}

/** The file or directory a path names for `kind`, or null. */
function asResource(p: string, kind: RefKind, fromGlob: boolean): string | null {
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  const isDir = (f: string) => existsSync(f) && statSync(f).isDirectory();
  switch (kind) {
    case "skill":
      if (isDir(p) && isFile(join(p, "SKILL.md"))) return p;
      return isFile(p) && p.endsWith(".md") ? p : null;
    case "extension":
    case "gate":
      if (isFile(p) && /\.(m?ts|m?js)$/.test(p)) return p;
      if (!fromGlob && isFile(`${p}.ts`)) return `${p}.ts`;
      return isDir(p) && isFile(join(p, "index.ts")) ? p : null;
    case "prompt":
    case "system":
      if (isFile(p) && p.endsWith(".md")) return p;
      return !fromGlob && isFile(`${p}.md`) ? `${p}.md` : null;
  }
}

export interface RefContext {
  /** The agent's directory, for own: and data:. */
  agentDir?: string;
  agentics?: string;
}

/** The paths a reference names (several for a glob). Throws when it names nothing. */
export function resolveRef(ref: string, kind: RefKind, c: RefContext): string[] {
  const agentics = c.agentics ?? AGENTICS_DIR;
  let base: string;
  let rel: string;
  if (ref.startsWith("shared:")) [base, rel] = [join(agentics, "shared", KIND_DIR[kind]), ref.slice(7)];
  else if (ref.startsWith("own:")) {
    if (!c.agentDir) throw new Error(`${ref}: own: needs an agent`);
    [base, rel] = [c.agentDir, ref.slice(4)];
  } else if (ref.startsWith("builder:")) [base, rel] = [join(agentics, "builders"), ref.slice(8)];
  else if (ref.startsWith("data:")) return [dataPath(ref, c).path];
  else if (isAbsolute(ref)) [base, rel] = ["/", ref];
  else throw new Error(`${ref}: a reference starts with shared:, own:, builder: or data:`);
  if (rel.split("/").includes("..")) throw new Error(`${ref}: .. is not allowed in a reference`);
  const fromGlob = rel.includes("*");
  const found = glob(base, rel)
    .map((p) => asResource(p, kind, fromGlob))
    .filter((p): p is string => p !== null);
  if (!found.length) throw new Error(`${ref} does not resolve: no ${kind} at ${join(base, rel)}`);
  return found;
}

// ---- data: ----

/**
 * Where `data:<p>` is: the agent's own data/, then the data/ of each folder above it up to agentics/agents/, then
 * agentics/shared/data/. The nearest match wins, and at each level data/local/ (gitignored) comes before data/.
 */
export function dataCandidates(rel: string, c: RefContext): string[] {
  const agentics = c.agentics ?? AGENTICS_DIR;
  const levels: string[] = [];
  if (c.agentDir) {
    const root = agentsRoot(agentics);
    for (let d = c.agentDir; ; d = dirname(d)) {
      levels.push(d);
      if (resolve(d) === resolve(root) || dirname(d) === d || !resolve(d).startsWith(resolve(root))) break;
    }
  }
  levels.push(join(agentics, "shared"));
  return levels.flatMap((l) => [join(l, "data", "local", rel), join(l, "data", rel)]);
}

export function dataPath(ref: string, c: RefContext): { path: string; candidates: string[] } {
  const rel = ref.replace(/^data:/, "");
  if (!rel || isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`${ref}: a data path is relative and has no ..`);
  const candidates = dataCandidates(rel, c);
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`${ref} is not in any data/ folder the agent can see (looked in ${candidates.map((p) => dirname(p)).filter((d, i, a) => a.indexOf(d) === i).join(", ")})`);
  return { path, candidates };
}

// ---- areas ----

export interface AreaSpec {
  path?: string;
  write?: boolean;
}

export interface Area {
  path: string;
  write: boolean;
}

/** An agent.yml's areas with absolute paths: relative to the agent's directory, `~` expanded, `data` defaults to data/. */
export function resolveAreas(areas: Record<string, AreaSpec> | undefined, dir: string): Record<string, Area> {
  const out: Record<string, Area> = {};
  for (const [name, a] of Object.entries(areas ?? {})) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`area ${name}: an area name is letters, digits, _ . -`);
    const p = a.path ?? (name === "data" ? "data" : null);
    if (p === null) throw new Error(`area ${name} needs a path`);
    const abs = expandHome(p);
    out[name] = { path: isAbsolute(abs) ? abs : resolve(dir, abs), write: a.write === true };
  }
  return out;
}

/** `area:<name>[/sub]` as a path. Throws when the area is not declared. */
export function areaPath(ref: string, areas: Record<string, Area>, owner = "the agent"): string {
  const rest = ref.replace(/^area:/, "");
  const [name, ...sub] = rest.split("/");
  const area = areas[name];
  if (!area) throw new Error(`${ref}: area ${name} is not declared by ${owner} (areas: ${Object.keys(areas).join(", ") || "none"})`);
  if (sub.includes("..")) throw new Error(`${ref}: .. is not allowed in an area path`);
  return join(area.path, ...sub);
}

/** A path in a run spec: area:, data:, ~, or a path relative to `cwd`. */
export function specPath(p: string, c: RefContext & { areas?: Record<string, Area>; owner?: string; cwd?: string }): string {
  if (p.startsWith("area:")) return areaPath(p, c.areas ?? {}, c.owner);
  if (p.startsWith("data:")) return dataPath(p, c).path;
  const abs = expandHome(p);
  return isAbsolute(abs) ? abs : resolve(c.cwd ?? process.cwd(), abs);
}

export const shortRef = (p: string, agentics = AGENTICS_DIR): string => {
  const rel = relative(dirname(agentics), p);
  return rel.startsWith("..") ? p : rel || basename(p);
};
