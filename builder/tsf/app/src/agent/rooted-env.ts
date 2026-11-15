/**
 * RootedEnv (DESIGN 8, D4): the execution environment of the factory's coding tools. `read`, `write` and `edit` resolve
 * every path through `env.absolutePath` (pi-durable tools/path-utils.js), so the one override below keeps them inside
 * the project and away from the protected paths (the harness adds the skill folder when it lies inside the project).
 * `bash` is not confined by path: enabling `coding_tools.bash` is a ceiling decision equal to full trust.
 */
import { lstat, readlink, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/**
 * Relative to the project root; a protected directory covers everything below it. `tsf/layers` and `tsf/mod.just` are
 * code the factory runs without asking (layers are imported into the server at the next start; the mod launches it),
 * so a file tool that could write them could widen the ceiling (DESIGN 14, spec 2.5).
 */
export const PROTECTED: readonly string[] = [
  "tsf/permissions.json",
  "tsf/.env",
  "tsf/data",
  "tsf/layers",
  "tsf/mod.just",
  // The rest of tsf/app (the factory's own source, DESIGN "Liquid core") is editable: web, server, core, layers and
  // package.json. Installed modules are not (change package.json; the launcher installs on the next restart), and
  // .tsf-base records where the copy came from.
  "tsf/app/node_modules",
  "tsf/app/.tsf-base",
];

/**
 * `PROTECTED` plus `skillDir` (the server's own code, imported at every start) when the project contains it, as when
 * the factory is installed in the repository that holds the skill. A skill folder outside the project needs no entry.
 */
export function protectedPaths(root: string, skillDir: string): readonly string[] {
  const rel = relative(resolve(root), resolve(skillDir));
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  // A project that is the skill folder itself (install refuses it) gets everything protected: fail closed.
  return inside ? [...PROTECTED, rel === "" ? "." : rel] : PROTECTED;
}

const MAX_LINK_HOPS = 40;
/** APFS and NTFS are case-insensitive by default: compare protected paths without case there. */
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

function fold(p: string): string {
  return FOLD_CASE ? p.toLowerCase() : p;
}

/** `p` equals `base` or lies below it (segment-wise: `tsf/.env.example` is not inside `tsf/.env`). */
function within(base: string, p: string): boolean {
  const rel = relative(fold(base), fold(p));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The real path of `abs` without requiring it to exist: walk up to the deepest existing ancestor (`lstat`, so a
 * dangling symlink counts as existing), `realpath` it, and re-append the missing remainder, which cannot hold a symlink
 * because it does not exist. A dangling symlink is followed by hand (its target is where a write would create the file).
 * `NodeExecutionEnv.canonicalPath` on the full path is `not_found` for a new file, which is why it is not used.
 */
async function canonicalise(abs: string, hops = 0): Promise<string> {
  if (hops > MAX_LINK_HOPS) throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  try {
    return join(await realpath(existing), ...rest);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // lstat found it, realpath did not: a dangling symlink (or one removed meanwhile).
    const target = await readlink(existing);
    return canonicalise(join(resolve(dirname(existing), target), ...rest), hops + 1);
  }
}

export class RootedEnv extends NodeExecutionEnv {
  /** `realpath` of the project root, computed once. */
  readonly root: string;
  private readonly protectedAbs: readonly string[];

  constructor(root: string, opts: { shellEnv?: NodeJS.ProcessEnv; protectedPaths?: readonly string[] } = {}) {
    super({ cwd: root, ...(opts.shellEnv ? { shellEnv: opts.shellEnv } : {}) });
    this.root = realpathSync(resolve(root));
    this.protectedAbs = (opts.protectedPaths ?? PROTECTED).map((p) => resolve(this.root, p));
  }

  override async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    const lexical = await super.absolutePath(path, context);
    if (!lexical.ok) return lexical;
    const abs = lexical.value;
    let real: string;
    try {
      real = await canonicalise(abs);
    } catch (error) {
      // Fail closed: a path that cannot be resolved is not handed to a tool.
      const e = error as NodeJS.ErrnoException;
      return err(new FileError("permission_denied", `cannot resolve ${path}: ${e.code ?? e.message}`, path));
    }
    if (!within(this.root, real)) {
      return err(new FileError("permission_denied", `outside the project: ${path}`, path));
    }
    for (const protectedAbs of this.protectedAbs) {
      // Canonicalised on every call, like the request path: `tsf` or `tsf/data` may be a symlink, or appear later.
      let protectedReal: string;
      try {
        protectedReal = await canonicalise(protectedAbs);
      } catch {
        protectedReal = protectedAbs;
      }
      if (within(protectedReal, real) || within(protectedAbs, real)) {
        return err(
          new FileError("permission_denied", `protected path: ${relative(this.root, protectedAbs)} is not available to file tools`, path),
        );
      }
    }
    return ok(abs);
  }
}
