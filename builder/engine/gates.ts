/**
 * Gates: checks that run inside an agent's pi process on the tool calls they name. A gate on `tool_call` sees the call
 * before the tool runs and allows it, blocks it with a reason, or rewrites its input. A gate on `tool_result` sees the
 * result and allows it or patches it. Gates decide alone and fail closed: runtime/gate-host.ts blocks a call whose
 * gate throws, with the error as the reason (E9), and journals every decision as `tool.gate`.
 *
 * A gate is a module an agent.yml's `gates` list names (shared:<name> is agentics/shared/gates/<name>.ts):
 *
 *   export default defineGate({
 *     tools: ["write", "edit"],            // the tools it sees, or "*"
 *     on: "tool_call",                     // or "tool_result"; default tool_call
 *     check: (call, ctx) => (ctx.mayWrite(String(call.input.path)) ? allow() : block("outside the agent's writes")),
 *   });
 *
 * A module may export a list of gates instead, for a tool_call gate and a tool_result gate that share state. Gates run
 * in the order the agent.yml lists them; the first block wins and later gates do not run for that call.
 *
 * The GateContext is built from what the runner wrote for the run (runtime/resolve.ts gateHostFor): the workspace, its
 * base commit, the agent's `writes` and `areas`, the protected config paths, and whether the run has a dispatch.
 *
 * Plain Node only: no pi import, so gates are tested without pi.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type GateEvent = "tool_call" | "tool_result";

/** A tool result as a tool_result gate sees it, and the fields a patch may set. */
export interface ToolResultFields {
  content: unknown[];
  details?: unknown;
  isError: boolean;
  structuredContent?: unknown;
}

export interface GateCall {
  tool: string;
  input: Record<string, unknown>;
  /** tool_result gates only. */
  result?: ToolResultFields;
}

/**
 * What a gate decides. `block` on tool_result replaces the result with an error carrying the reason. `path` names the
 * path a block is about, for the journal (default: the call's `path` input).
 */
export type Decision = { allow: true } | { block: true; reason: string; path?: string } | { rewrite: Record<string, unknown> } | { patch: Partial<ToolResultFields> };

export interface Area {
  path: string;
  write: boolean;
}

/** What the runner writes for a run's gates ($BUILDER_GATES): paths are absolute except relative `writes` globs. */
export interface GateContextData {
  /** The workspace (pi's working directory). */
  cwd: string;
  /** The base commit changes are measured from. Empty: $BUILDER_BASE, else HEAD. */
  base: string;
  /** Globs the agent may write: relative to cwd, or absolute (an agent.yml's own: and ~ entries). */
  writes: string[];
  areas: Record<string, Area>;
  /** Files and directories no agent may change: the machine config layers and ~/.gaffer/. */
  protectedPaths: string[];
  /** The run builds a slice from a dispatch: the slice rules apply. */
  dispatch: boolean;
}

/** The file $BUILDER_GATES names: the run's gates in the agent.yml's order, and their context. */
export interface GateHostFile {
  gates: { ref: string; path: string }[];
  ctx: GateContextData;
}

export interface GateContext extends Readonly<GateContextData> {
  /** In `writes` or a writable area, and not protected. A relative path is relative to cwd. */
  mayWrite(path: string): boolean;
  /** The path is a protected config file, or inside a protected directory (also through a symlink). */
  isProtected(path: string): boolean;
  /** `rel` (relative to cwd) exists in the base commit. */
  existsAtBase(rel: string): boolean;
  /** Paths (relative to cwd) changed since base: tracked changes and untracked files. Throws outside a git work tree. */
  changedFiles(): string[];
}

export interface Gate {
  tools: "*" | readonly string[];
  on: GateEvent;
  check(call: GateCall, ctx: GateContext): Decision | Promise<Decision>;
}

export interface GateSpec {
  tools: "*" | readonly string[];
  on?: GateEvent;
  check: Gate["check"];
}

/** A gate, checked when it is defined. */
export function defineGate(spec: GateSpec): Gate {
  const { tools, on = "tool_call", check } = spec;
  if (tools !== "*" && !(Array.isArray(tools) && tools.length && tools.every((t) => typeof t === "string" && t))) throw new Error('a gate names its tools: a list of tool names, or "*"');
  if (on !== "tool_call" && on !== "tool_result") throw new Error(`a gate's on is tool_call or tool_result, not ${String(on)}`);
  if (typeof check !== "function") throw new Error("a gate needs a check function");
  return { tools: tools === "*" ? "*" : [...tools], on, check };
}

export const allow = (): Decision => ({ allow: true });
export const block = (reason: string, path?: string): Decision => ({ block: true, reason, ...(path !== undefined ? { path } : {}) });

/** True when `g` looks like what defineGate returns. */
export function isGate(g: unknown): g is Gate {
  if (!g || typeof g !== "object") return false;
  const x = g as Partial<Gate>;
  return (x.tools === "*" || Array.isArray(x.tools)) && (x.on === "tool_call" || x.on === "tool_result") && typeof x.check === "function";
}

export const gateSees = (g: Gate, tool: string): boolean => g.tools === "*" || g.tools.includes("*") || g.tools.includes(tool);

/** A gate's return value as a Decision for `on`. Throws when it is not one (the host then fails closed). */
export function decisionOf(value: unknown, on: GateEvent): Decision {
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== "object") throw new Error(`returned ${JSON.stringify(value)}, not a decision`);
  if (d.allow === true) return { allow: true };
  if (d.block === true) {
    if (typeof d.reason !== "string" || !d.reason.trim()) throw new Error("blocked without a reason");
    return { block: true, reason: d.reason, ...(typeof d.path === "string" ? { path: d.path } : {}) };
  }
  if (d.rewrite && typeof d.rewrite === "object" && !Array.isArray(d.rewrite)) {
    if (on !== "tool_call") throw new Error("returned a rewrite on tool_result: only a tool_call gate rewrites the input");
    return { rewrite: d.rewrite as Record<string, unknown> };
  }
  if (d.patch && typeof d.patch === "object" && !Array.isArray(d.patch)) {
    if (on !== "tool_result") throw new Error("returned a patch on tool_call: only a tool_result gate patches the result");
    return { patch: d.patch as Partial<ToolResultFields> };
  }
  throw new Error(`returned ${JSON.stringify(value)}, not a decision`);
}

// ---- paths ----

export const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, homedir());

/** A tool's path argument as pi resolves it: a leading @ dropped, ~ expanded, relative to cwd. */
export function resolvePath(cwd: string, p: unknown): string {
  return resolve(cwd, expandHome(String(p ?? "").replace(/^@/, "")));
}

/** `abs` relative to `cwd` when it is inside it, else null (cwd itself is null too). */
export function relIn(cwd: string, abs: string): string | null {
  const rel = relative(cwd, abs);
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

const within = (dir: string, p: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The path with symlinks resolved in its longest existing prefix. */
export function canonicalPath(p: string): string {
  const tail: string[] = [];
  for (let head = p; ; ) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return p;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** A glob as a regular expression: `*` and `?` within one path segment, `**` across segments, `dir/**` also the dir. */
export function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "/" && glob.slice(i + 1) === "**") {
      re += "(?:/.*)?";
      break;
    }
    if (c === "*" && glob[i + 1] === "*") {
      const segmentStart = i === 0 || glob[i - 1] === "/";
      i++;
      if (segmentStart && glob[i + 1] === "/") {
        re += "(?:.*/)?";
        i++;
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// ---- shell-write heuristics ----

/** Shell commands that write a file: in-place sed, tee, redirection, mv, cp, patch, truncate, rm. */
export const SHELL_WRITE = /\bsed\b[^|;&]*\s-i|\btee\b|\bmv\b|\bcp\b|\bpatch\b|\btruncate\b|\brm\b|>>?/;

/**
 * The words of a command that writes (SHELL_WRITE), options left out, or null when it does not write. A path built at
 * runtime is not seen: the shell is not a hard boundary.
 */
export function shellWriteWords(command: unknown): string[] | null {
  const cmd = String(command ?? "");
  if (!SHELL_WRITE.test(cmd)) return null;
  return cmd.split(/[\s'"`;|&<>()]+/).filter((w) => w && !w.startsWith("-"));
}

/** The words a command redirects output to (`> f`, `>> f`, `2> f`); not `>&2`. */
export function redirectTargets(command: unknown): string[] {
  return [...String(command ?? "").matchAll(/>>?\s*([^\s'"`;|&<>()]+)/g)].map((m) => m[1]);
}

/** The paths a call may write, absolute: write's and edit's `path`; for bash, every word of a command that writes. */
export function writtenPaths(call: GateCall, cwd: string): string[] {
  if (call.tool === "write" || call.tool === "edit") return [resolvePath(cwd, call.input.path)];
  if (call.tool === "bash") return (shellWriteWords(call.input.command) ?? []).map((w) => resolvePath(cwd, w));
  return [];
}

// ---- the context ----

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** The GateContext for a run. `base` empty means $BUILDER_BASE, else HEAD. */
export function gateContext(d: GateContextData, env: NodeJS.ProcessEnv = process.env): GateContext {
  const cwd = resolve(d.cwd);
  const base = d.base || env.BUILDER_BASE || "HEAD";
  const writes = [...(d.writes ?? [])];
  const areas = { ...(d.areas ?? {}) };
  const protectedPaths = [...(d.protectedPaths ?? [])];
  const guarded = protectedPaths.flatMap((p) => [p, canonicalPath(p)]);
  const writeRes = writes.map((w) => ({ absolute: isAbsolute(w), re: globRegExp(w) }));

  const isProtected = (path: string): boolean => {
    const abs = resolvePath(cwd, path);
    const forms = [abs, canonicalPath(abs)];
    return guarded.some((p) => forms.some((f) => within(p, f)));
  };
  const mayWrite = (path: string): boolean => {
    const abs = resolvePath(cwd, path);
    if (isProtected(abs)) return false;
    const rel = relIn(cwd, abs);
    if (writeRes.some((w) => (w.absolute ? w.re.test(abs) : rel !== null && w.re.test(rel)))) return true;
    return Object.values(areas).some((a) => a.write && within(resolve(a.path), abs));
  };
  return {
    cwd,
    base,
    writes,
    areas,
    protectedPaths,
    dispatch: d.dispatch === true,
    mayWrite,
    isProtected,
    existsAtBase(rel) {
      try {
        // `./` makes the path relative to cwd (the app directory), not to the repository root.
        execFileSync("git", ["cat-file", "-e", `${base}:./${rel}`], { cwd, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    changedFiles() {
      const tracked = git(cwd, ["diff", base, "--name-only", "--no-renames", "--relative"]).split("\n").filter(Boolean);
      const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
      return [...tracked, ...untracked];
    },
  };
}
