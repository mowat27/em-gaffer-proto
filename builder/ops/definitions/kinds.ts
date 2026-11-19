/**
 * Definitions: what the definitions tools change, where each kind lives in the agent tree, which files belong to one,
 * and its version (design section 9, D10). A definition's version is the sha256 of its files: for a directory the same
 * hash as runtime/resolve.ts contentHash (each file's relative path and content hash, in walk order), for a single
 * file the hash of its content. So a builder's version is the Builder-Version its workflow runs record, and a skill's is
 * the hash agent.start journals.
 *
 *   kind       id                         where (under agentics/)                       one file or a directory
 *   builder    supabase-api               builders/<id>/                                directory
 *   agent      dev/slice-lab              agents/<id>/ (its own files, see below)       directory
 *   skill      build/build-state-change   shared/skills/<id>/ (or <id>.md)              directory (or file)
 *   template   supabase-api/state-change  builders/<builder>/templates/<set>/           directory
 *              shared/partials            shared/templates/<set>/
 *   gate       write-scope                shared/gates/<id>.ts                          file
 *   listener   metrics                    shared/listeners/<id>.ts                      file
 *   prompt     verifier/verify            agents/<agent>/prompts/<name>.md              file
 *              shared/<name>              shared/prompts/<name>.md
 *   active     builder                    builders/active.yml (the active builder)      file
 *
 * An agent's definition is its directory without what is not definition: nested agents (folders with an agent.yml),
 * data/, state/, work/, sessions/, bin/, credentials (auth.json) and pi's model cache (models-store.json). Those stay
 * when the agent is changed or deleted. An agent's own skills, prompts and extensions are its files; skill_*, gate_*
 * and the other resource tools act on shared ones (prompt_* also on an agent's prompts/).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { listAgents } from "../../runtime/paths.ts";

export type Kind = "builder" | "agent" | "skill" | "template" | "gate" | "listener" | "prompt" | "active";
export const KINDS: readonly Kind[] = ["builder", "agent", "skill", "template", "gate", "listener", "prompt", "active"];

export interface Def {
  kind: Kind;
  id: string;
  /** The definition's directory or file (absolute). */
  path: string;
  /** One file (gate, listener, prompt, active, a file skill) rather than a directory. */
  single: boolean;
  /** The agent tree it is in. */
  agentics: string;
}

/** relative posix path -> content. A single-file definition holds one entry, its file name. */
export type FileSet = Map<string, Buffer>;

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function segments(kind: Kind, id: string, count?: number): string[] {
  const segs = id.split("/");
  if (!id || segs.some((s) => !SEGMENT.test(s))) throw new Error(`"${id}" is not a ${kind} id: path segments of letters, digits, _ . - (not starting with . or -)`);
  if (count !== undefined && segs.length !== count) throw new Error(`"${id}" is not a ${kind} id: ${count === 1 ? "one segment" : `${count} segments`} expected`);
  return segs;
}

/** Where a definition lives. Throws when the id is not one of its kind. It need not exist. */
export function locate(kind: Kind, id: string, agentics: string): Def {
  const def = (path: string, single: boolean): Def => ({ kind, id, path, single, agentics });
  switch (kind) {
    case "builder":
      segments(kind, id, 1);
      if (id === "active.yml") throw new Error(`"${id}" is not a builder id`);
      return def(join(agentics, "builders", id), false);
    case "agent":
      segments(kind, id);
      return def(join(agentics, "agents", id), false);
    case "skill":
      segments(kind, id);
      return def(join(agentics, "shared", "skills", id), id.endsWith(".md"));
    case "template": {
      const [owner, set] = segments(kind, id, 2);
      return def(owner === "shared" ? join(agentics, "shared", "templates", set) : join(agentics, "builders", owner, "templates", set), false);
    }
    case "gate":
      segments(kind, id, 1);
      return def(join(agentics, "shared", "gates", `${id.replace(/\.ts$/, "")}.ts`), true);
    case "listener":
      segments(kind, id, 1);
      return def(join(agentics, "shared", "listeners", `${id.replace(/\.ts$/, "")}.ts`), true);
    case "prompt": {
      const segs = segments(kind, id);
      if (segs.length < 2) throw new Error(`"${id}" is not a prompt id: <agent>/<name> or shared/<name>`);
      const name = `${segs[segs.length - 1].replace(/\.md$/, "")}.md`;
      const owner = segs.slice(0, -1).join("/");
      return def(owner === "shared" ? join(agentics, "shared", "prompts", name) : join(agentics, "agents", owner, "prompts", name), true);
    }
    case "active":
      if (id !== "builder") throw new Error(`the active definition's id is "builder" (agentics/builders/active.yml), not "${id}"`);
      return def(join(agentics, "builders", "active.yml"), true);
  }
}

// ---- files and versions ----

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Never part of any definition. */
const ALWAYS_SKIPPED = new Set(["node_modules", ".git"]);
/** In an agent's directory, not part of its definition. */
const AGENT_SKIPPED = new Set(["data", "state", "work", "sessions", "bin", "auth.json", "models-store.json"]);

/** Is `rel` (posix, relative to the definition) something the definition may hold? Null when it may, else why not. */
export function notDefinitionFile(def: Def, rel: string): string | null {
  const segs = rel.split("/");
  if (!rel || rel.startsWith("/") || segs.some((s) => !s || s === "." || s === "..")) return `${rel}: a file path is relative, with no . or .. segments`;
  if (segs.some((s) => ALWAYS_SKIPPED.has(s))) return `${rel}: inside ${segs.find((s) => ALWAYS_SKIPPED.has(s))}/`;
  if (def.kind === "agent") {
    if (AGENT_SKIPPED.has(segs[0])) return `${rel}: ${segs[0]} is not part of an agent's definition (data, state, work, sessions, bin and credentials stay as they are)`;
    for (let i = 1; i < segs.length; i++) if (existsSync(join(def.path, ...segs.slice(0, i), "agent.yml"))) return `${rel}: inside the nested agent ${segs.slice(0, i).join("/")}`;
  }
  return null;
}

/** Order of contentHash's walk: per directory by name (localeCompare), depth first. */
export function compareRel(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].localeCompare(y[i]);
  }
  return x.length - y.length;
}

/** The definition's files (relative posix paths, in walk order), or null when it does not exist. */
export function defFiles(def: Def): string[] | null {
  if (!existsSync(def.path)) return null;
  const st = statSync(def.path);
  if (def.single) return st.isFile() ? [basename(def.path)] : null;
  if (!st.isDirectory()) return null;
  const out: string[] = [];
  const walk = (dir: string, top: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ALWAYS_SKIPPED.has(e.name)) continue;
      if (def.kind === "agent" && top && AGENT_SKIPPED.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (def.kind === "agent" && existsSync(join(p, "agent.yml"))) continue;
        walk(p, false);
      } else if (e.isFile()) out.push(relative(def.path, p).split(sep).join("/"));
    }
  };
  walk(def.path, true);
  return out;
}

/** The definition's files and their content, or null when it does not exist (a directory with none of its files). */
export function readFileSet(def: Def): FileSet | null {
  const files = defFiles(def);
  if (!files || (!def.single && !files.length)) return null;
  const set: FileSet = new Map();
  for (const rel of files) set.set(rel, readFileSync(def.single ? def.path : join(def.path, ...rel.split("/"))));
  return set;
}

/** The version of a file set: contentHash of the directory it would be, or of the one file. */
export function versionOf(files: FileSet, single: boolean): string {
  if (single) {
    const [only] = [...files.values()];
    return sha256(only ?? Buffer.alloc(0));
  }
  const lines = [...files.keys()].sort(compareRel).map((rel) => `${rel}\0${sha256(files.get(rel)!)}`);
  return sha256(lines.join("\n"));
}

/** The definition's version now, or null when it does not exist. */
export function currentVersion(def: Def): string | null {
  const files = readFileSet(def);
  return files ? versionOf(files, def.single) : null;
}

// ---- listing ----

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const dirsIn = (p: string) => (isDir(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort() : []);
const filesIn = (p: string, ext: string) => (isDir(p) ? readdirSync(p).filter((n) => n.endsWith(ext) && !n.startsWith(".") && isFile(join(p, n))).sort() : []);

/** Every id of a kind that exists in the tree, sorted. */
export function listIds(kind: Kind, agentics: string): string[] {
  switch (kind) {
    case "builder":
      return dirsIn(join(agentics, "builders")).filter((b) => isFile(join(agentics, "builders", b, "builder.ts")));
    case "agent":
      return listAgents(agentics);
    case "skill": {
      const root = join(agentics, "shared", "skills");
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const name of dirsIn(dir)) {
          const p = join(dir, name);
          if (isFile(join(p, "SKILL.md"))) out.push(relative(root, p).split(sep).join("/"));
          else walk(p);
        }
        if (dir !== root) for (const f of filesIn(dir, ".md")) out.push(relative(root, join(dir, f)).split(sep).join("/"));
      };
      walk(root);
      return out.sort();
    }
    case "template": {
      const out: string[] = [];
      for (const b of listIds("builder", agentics)) for (const set of dirsIn(join(agentics, "builders", b, "templates"))) out.push(`${b}/${set}`);
      for (const set of dirsIn(join(agentics, "shared", "templates"))) out.push(`shared/${set}`);
      return out.sort();
    }
    case "gate":
      return filesIn(join(agentics, "shared", "gates"), ".ts").map((f) => f.replace(/\.ts$/, ""));
    case "listener":
      return filesIn(join(agentics, "shared", "listeners"), ".ts").map((f) => f.replace(/\.ts$/, ""));
    case "prompt": {
      const out = filesIn(join(agentics, "shared", "prompts"), ".md").map((f) => `shared/${f.replace(/\.md$/, "")}`);
      for (const a of listAgents(agentics)) for (const f of filesIn(join(agentics, "agents", a, "prompts"), ".md")) out.push(`${a}/${f.replace(/\.md$/, "")}`);
      return out.sort();
    }
    case "active":
      return isFile(join(agentics, "builders", "active.yml")) ? ["builder"] : [];
  }
}

/** The same definition in another tree (a staged copy of this one). */
export function inTree(def: Def, agentics: string): Def {
  return locate(def.kind, def.id, agentics);
}

/** True when two paths are the same or one is inside the other. */
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
