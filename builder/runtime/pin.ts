/**
 * Pinning what a run reads lazily (D10, E1). Code is pinned by the process that loads it (extensions when pi starts,
 * builder modules when a workflow starts). Files read later are copied when the run starts, so a definition changed
 * while the run works never reaches it:
 *
 *   runs/<id>/pinned/<sha256>/<name>    a copy of a skill (its folder), a prompt template or SYSTEM.md/APPEND_SYSTEM.md,
 *                                        named by the hash of its content; pi gets these paths
 *   runs/<id>/pinned/agent/             pi's agent directory for the run: copies of settings.json and models.json,
 *                                        links to everything else of the agent's directory (auth.json, bin/, ...)
 *   runs/<id>/pinned/<sha256>/templates  a workflow run's template sets and shared partials (pinTemplates)
 *
 * A SYSTEM.md or APPEND_SYSTEM.md that pi would find in the agent's directory is passed with --system-prompt or
 * --append-system-prompt instead (pi then does not look for it). The run's workspace pruning removes pinned/ with it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { contentHash } from "./resolve.ts";
import type { Resolved, Resource } from "./types.ts";

export const PINNED_DIR = "pinned";

/** The flags whose value is a resource path pi reads. */
const PATH_FLAGS = new Set(["--skill", "--prompt-template", "--system-prompt", "--append-system-prompt"]);
/** Agent-directory files pi reads that are definitions: copied. Everything else is linked. */
const COPIED = new Set(["settings.json", "models.json"]);
/** Passed as flags, never found in the pinned agent directory. */
const BY_FLAG = new Set(["SYSTEM.md", "APPEND_SYSTEM.md"]);

const DISCOVERY_OFF = /^--no-(skills|extensions|prompt-templates|context-files|mcp|themes)$/;

/** Copy a file or folder into runs/<id>/pinned/<its sha256>/<its name>. Returns the copy's path and hash. */
export function pinCopy(runDir: string, src: string): { path: string; sha256: string } {
  const root = join(runDir, PINNED_DIR);
  const tmp = join(root, `.tmp-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const name = basename(src);
    cpSync(src, join(tmp, name), { recursive: true });
    const sha256 = contentHash(join(tmp, name));
    const dest = join(root, sha256);
    if (!existsSync(dest)) renameSync(tmp, dest);
    return { path: join(dest, name), sha256 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface PinnedResource extends Resource {
  /** The copy pi reads. */
  pinned: string;
  /** The copy's hash, when the file changed between resolving the run and pinning it. */
  pinnedSha256?: string;
}

/**
 * Pin an agent run's lazily read resources: the argv with pinned paths (and explicit flags for the system prompt files
 * pi would otherwise find in the agent's directory), PI_CODING_AGENT_DIR pointing at the pinned agent directory, and
 * every resource with its pinned path for agent.start. Throws when a resource cannot be copied.
 */
export function pinResources(r: Resolved, runDir: string): { argv: string[]; env: Record<string, string>; resources: (Resource | PinnedResource)[] } {
  const map = new Map<string, string>();
  const resources: (Resource | PinnedResource)[] = [];
  for (const res of r.resources) {
    if (res.kind !== "skill" && res.kind !== "prompt" && res.kind !== "system") {
      resources.push(res);
      continue;
    }
    let copy: { path: string; sha256: string };
    try {
      copy = pinCopy(runDir, res.path);
    } catch (err) {
      throw new Error(`could not pin ${res.ref} (${res.path}): ${(err as Error).message}`);
    }
    map.set(res.path, copy.path);
    resources.push({ ...res, pinned: copy.path, ...(copy.sha256 !== res.sha256 ? { pinnedSha256: copy.sha256 } : {}) });
  }
  const argv = r.argv.map((a, i) => (i > 0 && PATH_FLAGS.has(r.argv[i - 1]) && map.has(a) ? map.get(a)! : a));
  // System prompt files pi would find in the agent's directory: named explicitly, pinned.
  const named = new Set(argv.filter((_, i) => i > 0 && (argv[i - 1] === "--system-prompt" || argv[i - 1] === "--append-system-prompt")));
  const extra: string[] = [];
  for (const res of r.resources) {
    if (res.kind !== "system" || !map.has(res.path) || named.has(map.get(res.path)!)) continue;
    const name = basename(res.path);
    if (name === "SYSTEM.md" && !argv.includes("--system-prompt")) extra.push("--system-prompt", map.get(res.path)!);
    else if (name === "APPEND_SYSTEM.md") extra.push("--append-system-prompt", map.get(res.path)!);
  }
  let lead = 0;
  while (lead < argv.length && DISCOVERY_OFF.test(argv[lead])) lead++;
  argv.splice(lead, 0, ...extra);
  const env: Record<string, string> = {};
  if (r.agent) env.PI_CODING_AGENT_DIR = pinAgentDir(r.agent.dir, runDir);
  return { argv, env, resources };
}

/** runs/<id>/pinned/agent: copies of the agent directory's settings, links to the rest. */
export function pinAgentDir(agentDir: string, runDir: string): string {
  const dest = join(runDir, PINNED_DIR, "agent");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(agentDir)) {
    if (BY_FLAG.has(name)) continue;
    const src = join(agentDir, name);
    if (COPIED.has(name) && statSync(src).isFile()) cpSync(src, join(dest, name));
    else symlinkSync(src, join(dest, name));
  }
  return dest;
}

/**
 * Pin a workflow run's templates: `<agentics>/shared/templates` and every `<agentics>/builders/<id>/templates`, each
 * copied into pinned/<sha256>/templates. Returns a function that maps a path inside one of them to its copy (any other
 * path unchanged).
 */
export function pinTemplates(runDir: string, agentics: string): (path: string) => string {
  const dirs = [join(agentics, "shared", "templates")];
  const builders = join(agentics, "builders");
  if (existsSync(builders)) for (const b of readdirSync(builders)) if (!b.startsWith(".")) dirs.push(join(builders, b, "templates"));
  const pins: [string, string][] = [];
  for (const d of dirs) {
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    pins.push([d, pinCopy(runDir, d).path]);
  }
  return (path: string) => {
    for (const [from, to] of pins) {
      if (path === from) return to;
      if (path.startsWith(from + sep)) return to + path.slice(from.length);
    }
    return path;
  };
}
