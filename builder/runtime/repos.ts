/**
 * input.repos of a workflow run spec (design section 3, Repositories): a clone source per repository name, resolved
 * when the run starts so run.json pins it (D10) and config_resolve shows it. `app` is the dispatch's repository: its
 * source replaces the dispatch's url, and with a `ref` the commit that ref names replaces the dispatch's base for the
 * whole job (engine/workflow.ts), so prepare, checks, commit and the agent all measure from it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { specPath } from "./paths.ts";
import type { RepoSource, ResolvedRepo } from "./types.ts";

const NAME = /^[\w.-]+$/;

function sourceOf(name: string, v: unknown): { from: string; ref?: string } {
  if (typeof v === "string" && v) return { from: v };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => k !== "from" && k !== "ref");
    if (typeof o.from === "string" && o.from && (o.ref === undefined || (typeof o.ref === "string" && o.ref)) && !extra.length) {
      return { from: o.from, ...(o.ref !== undefined ? { ref: o.ref as string } : {}) };
    }
  }
  throw new Error(`input.repos.${name}: a path, or { from: <path>, ref?: <commit, branch or HEAD> }`);
}

/** input.repos with absolute paths and each ref's commit. Throws with what is wrong; undefined when there are none. */
export function resolveRepos(repos: Record<string, RepoSource> | undefined, c: Parameters<typeof specPath>[1]): Record<string, ResolvedRepo> | undefined {
  if (repos === undefined) return undefined;
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) throw new Error("input.repos: a map from repository name to its source, e.g. { app: area:apps/invoice-lite }");
  const out: Record<string, ResolvedRepo> = {};
  for (const [name, value] of Object.entries(repos)) {
    if (!NAME.test(name)) throw new Error(`input.repos.${name}: a repository name is letters, digits, _ . -`);
    const src = sourceOf(name, value);
    let path: string;
    try {
      path = specPath(src.from, c);
    } catch (err) {
      throw new Error(`input.repos.${name}: ${(err as Error).message}`);
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`input.repos.${name}: ${path} is not a directory`);
    const r: ResolvedRepo = { from: src.from, path };
    if (src.ref !== undefined) {
      const res = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${src.ref}^{commit}`], { cwd: path, encoding: "utf8" });
      const sha = res.status === 0 ? (res.stdout || "").trim() : "";
      if (!sha) throw new Error(`input.repos.${name}: ${src.ref} is not a commit in ${path}`);
      r.ref = src.ref;
      r.base = sha;
    }
    out[name] = r;
  }
  return out;
}
