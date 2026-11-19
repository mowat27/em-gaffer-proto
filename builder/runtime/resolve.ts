/**
 * config_resolve: a run spec, the agent's agent.yml, the defaults.yml of each folder above it, the machine limit and
 * the parent run's tools, resolved into exactly what the runner passes to pi. Nothing is discovered implicitly: pi
 * starts with discovery off and gets every skill, extension and prompt template as an explicit path, recorded here
 * with its content hash.
 *
 * agent.yml (an unknown key is an error naming the file and the key):
 *
 *   description   required
 *   mode          headless | interactive | rpc | durable: the default for runs of this agent
 *   prompt        SYSTEM.md / APPEND_SYSTEM.md: the system prompt; anything else: a prompt template, which a
 *                 headless, rpc or durable run with no message starts with (`/<name> <input.args>`)
 *   extends       another agent whose prompt, uses and gates this one reuses; its own keys win
 *   uses          { skills, extensions, prompts }: references (runtime/paths.ts), globs allowed
 *   gates         references (shared:<name> is shared/gates/<name>.ts): the runner loads them through the gate host
 *                 (gateHostFor, runtime/gate-host.ts)
 *   tools         { enable, disable }: groups or tool names (ops/groups.ts)
 *   writes        globs the agent may write, relative to the workspace, or own:<glob> / ~/... / absolute; enforced
 *                 with the writable areas by the write-scope gate
 *   areas         { <name>: { path, write } }: local folders a run spec may name as area:<name>
 *   runs          { may_start: [workflow:<glob>, agent:<glob>, *] } (E8)
 *   api           { listen: [host:]port, token: env:NAME }: runs of this agent serve the API (runtime/api.ts)
 *   definitions   { changes: write | propose }: propose makes the agent's change tools save change sets instead of
 *                 writing (ops/definitions/change.ts); pinned in the resolved run as `changes`
 *   triggers      [{ on: job.failed }, { cron, prompt }] (runtime/triggers.ts): pinned for durable runs, which arm them
 *
 * A run spec's workspace `{ dir: parent }` is the starting run's own workspace (its cwd), worked in place.
 *
 * defaults.yml in a folder above the agent merges under its agent.yml, nearest folder last: maps merge key by key,
 * lists replace.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { parse } from "yaml";
import type { GateHostFile } from "../engine/gates.ts";
import { CONFIG_FILES_ENV, isMap, mergeLayers, PACKAGED_CONFIG } from "../ops/config.ts";
import { toolsOf, unknownToolName, type ToolLimit } from "../ops/groups.ts";
import { apiSettings } from "./api.ts";
import { agentDir, expandHome, foldersAbove, resolveAreas, resolveRef, specPath, type AreaSpec, type RefKind } from "./paths.ts";
import { piSettings } from "./pi.ts";
import { resolveRepos } from "./repos.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "./root.ts";
import { parseTriggers } from "./triggers.ts";
import { MODES, type Mode, type Resolved, type Resource, type RunRecord, type RunSpec, type WorkspaceSpec } from "./types.ts";

export interface AgentYml {
  description?: string;
  mode?: Mode;
  prompt?: string;
  extends?: string;
  uses?: { skills?: string[]; extensions?: string[]; prompts?: string[] };
  gates?: string[];
  tools?: { enable?: string[]; disable?: string[] };
  writes?: string[];
  areas?: Record<string, AreaSpec>;
  runs?: { may_start?: string[] };
  api?: unknown;
  triggers?: unknown;
  definitions?: { changes?: "write" | "propose" };
}

// ---- agent.yml and defaults.yml ----

type Rule = "string" | "strings" | "tools" | "boolean" | "any" | { oneOf: readonly string[] } | { map: Record<string, Rule> } | { mapOf: Rule };

const AGENT_RULES: Record<string, Rule> = {
  description: "string",
  mode: { oneOf: MODES },
  prompt: "string",
  extends: "string",
  uses: { map: { skills: "strings", extensions: "strings", prompts: "strings" } },
  gates: "strings",
  tools: { map: { enable: "tools", disable: "tools" } },
  writes: "strings",
  areas: { mapOf: { map: { path: "string", write: "boolean" } } },
  runs: { map: { may_start: "strings" } },
  api: "any",
  triggers: "any",
  definitions: { map: { changes: { oneOf: ["write", "propose"] } } },
};

function checkValue(v: unknown, rule: Rule, key: string): void {
  const fail = (why: string): never => {
    throw new Error(`${key} ${why}`);
  };
  if (rule === "any") return;
  if (rule === "string") return void (typeof v === "string" || fail("must be a string"));
  if (rule === "boolean") return void (typeof v === "boolean" || fail("must be true or false"));
  if (rule === "strings" || rule === "tools") {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail("must be a list of strings");
    if (rule === "tools") for (const name of v as string[]) if (unknownToolName(name)) fail(`names an ${unknownToolName(name)}`);
    return;
  }
  if ("oneOf" in rule) return void (rule.oneOf.includes(v as string) || fail(`must be one of ${rule.oneOf.join(", ")}`));
  if (!isMap(v)) return fail("must be a map");
  for (const [k, x] of Object.entries(v)) {
    if ("mapOf" in rule) checkValue(x, rule.mapOf, `${key}.${k}`);
    else if (!(k in rule.map)) throw new Error(`unknown key ${key}.${k}`);
    else checkValue(x, rule.map[k], `${key}.${k}`);
  }
}

/** Check a parsed agent.yml or defaults.yml. Throws `<file>: <key> <why>`. */
export function checkAgentYml(raw: unknown, file: string, o: { requireDescription: boolean }): AgentYml {
  const doc = raw ?? {};
  try {
    if (!isMap(doc)) throw new Error("must hold a map of keys");
    for (const [k, v] of Object.entries(doc)) {
      if (!(k in AGENT_RULES)) throw new Error(`unknown key ${k}`);
      if (v !== null && v !== undefined) checkValue(v, AGENT_RULES[k], k);
    }
    if (doc.api !== null && doc.api !== undefined) apiSettings(doc.api);
    if (doc.triggers !== null && doc.triggers !== undefined) parseTriggers(doc.triggers);
    if (o.requireDescription && (typeof doc.description !== "string" || !doc.description.trim())) throw new Error("description is required");
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  return doc as AgentYml;
}

function readYml(file: string, requireDescription: boolean): { doc: AgentYml; text: string } {
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message.split("\n")[0]}`);
  }
  return { doc: checkAgentYml(raw, file, { requireDescription }), text };
}

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** A file's content hash, or for a directory a hash over each file's relative path and content hash. */
export function contentHash(path: string): string {
  if (!statSync(path).isDirectory()) return sha256(readFileSync(path));
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) lines.push(`${relative(path, p)}\0${sha256(readFileSync(p))}`);
    }
  };
  walk(path);
  return sha256(lines.join("\n"));
}

export interface LoadedAgent {
  id: string;
  dir: string;
  ymlHash: string;
  defaults: { path: string; sha256: string }[];
  /** agent.yml over the defaults, over what it extends. */
  yml: AgentYml;
}

/** own: references in what an agent hands to one that extends it, made absolute so they still point at it. */
function absolutise(refs: string[] | undefined, dir: string): string[] | undefined {
  return refs?.map((r) => (r.startsWith("own:") ? join(dir, r.slice(4)) : r));
}

/** An agent's agent.yml merged over the defaults.yml above it and over what it extends. */
export function loadAgent(id: string, agentics = AGENTICS_DIR, seen: string[] = []): LoadedAgent {
  if (seen.includes(id)) throw new Error(`agent ${id} extends itself: ${[...seen, id].join(" -> ")}`);
  const dir = agentDir(id, agentics);
  const own = readYml(join(dir, "agent.yml"), true);
  const defaults: { path: string; sha256: string }[] = [];
  let yml: AgentYml = {};
  for (const folder of foldersAbove(dir, agentics)) {
    const file = join(folder, "defaults.yml");
    if (!existsSync(file)) continue;
    const d = readYml(file, false);
    defaults.push({ path: file, sha256: sha256(d.text) });
    yml = mergeLayers(yml, d.doc);
  }
  yml = mergeLayers(yml, own.doc);
  if (yml.extends) {
    const base = loadAgent(yml.extends, agentics, [...seen, id]);
    const inherited: AgentYml = {
      ...(base.yml.prompt ? { prompt: absolutise([base.yml.prompt], base.dir)![0] } : {}),
      ...(base.yml.uses
        ? {
            uses: {
              ...(base.yml.uses.skills ? { skills: absolutise(base.yml.uses.skills, base.dir) } : {}),
              ...(base.yml.uses.extensions ? { extensions: absolutise(base.yml.uses.extensions, base.dir) } : {}),
              ...(base.yml.uses.prompts ? { prompts: absolutise(base.yml.uses.prompts, base.dir) } : {}),
            },
          }
        : {}),
      ...(base.yml.gates ? { gates: absolutise(base.yml.gates, base.dir) } : {}),
    };
    yml = mergeLayers(inherited, yml);
  }
  return { id, dir, ymlHash: sha256(own.text), defaults, yml };
}

// ---- E8 and tool ceilings ----

const globMatch = (pattern: string, s: string) => new RegExp(`^${pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(s);

/** What a spec starts, as runs.may_start names it: `agent:<id>` or `workflow:<id>`. */
export const runTarget = (spec: RunSpec): string => (spec.agent ? `agent:${spec.agent}` : `workflow:${spec.workflow ?? ""}`);

/** E8: an agent run may start only what its runs.may_start matches. Workflow runs and non-runs start anything. */
export function checkMayStart(parent: RunRecord | null | undefined, spec: RunSpec): void {
  if (!parent || parent.kind !== "agent") return;
  const patterns = parent.resolved?.mayStart ?? [];
  const target = runTarget(spec);
  if (!patterns.some((p) => p === "*" || globMatch(p, target))) {
    throw new Error(`run refused: agent ${parent.spec.agent} (run ${parent.id}) may not start ${target} (runs.may_start: ${patterns.length ? patterns.join(", ") : "none"})`);
  }
}

// ---- resolving a run ----

export interface ResolveOptions {
  /** The machine config: its limit caps every run's tools. */
  config: { limit: ToolLimit };
  /** The run starting this one: E8, its tool ceiling, and its areas for a workflow's paths. */
  parent?: RunRecord | null;
  /** The run's folder. Default `<runDir>` (resolve before a run exists). */
  runDir?: string;
  agentics?: string;
  /** What relative paths in the spec are relative to (default the process's working directory). */
  cwd?: string;
}

/** Shell-like quoting for a prompt-template argument: pi's template parser respects quotes the way a shell does. */
export function quoteArg(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The job id a dispatch's callback names: its last path segment. */
const callbackJobId = (callback: unknown): string => (typeof callback === "string" ? (callback.split("/").pop() ?? "") : "");

interface DispatchShape {
  task?: { sliceId?: unknown; title?: unknown; context?: unknown; attempt?: unknown };
  callback?: unknown;
}

/** A dispatch inline, or read from a data: path or a file. */
export function loadDispatch(value: unknown, c: { agentDir?: string; agentics?: string; cwd?: string }): { dispatch: unknown; source?: { ref: string; path: string; sha256: string } } {
  if (typeof value !== "string") return { dispatch: value };
  const path = specPath(value, { ...c });
  const text = readFileSync(path, "utf8");
  let dispatch: unknown;
  try {
    dispatch = JSON.parse(text);
  } catch (err) {
    throw new Error(`${value}: not JSON: ${(err as Error).message}`);
  }
  return { dispatch, source: { ref: value, path, sha256: sha256(text) } };
}

/** The BUILDER_* job variables for a dispatch (the extensions and the pi stub read them). */
export function dispatchEnv(dispatch: unknown, o: { jobId?: string; runId: string; base?: string }): Record<string, string> {
  const d = (dispatch ?? {}) as DispatchShape;
  const t = d.task ?? {};
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  return {
    BUILDER_JOB_ID: o.jobId || callbackJobId(d.callback) || o.runId,
    BUILDER_SLICE_ID: str(t.sliceId),
    BUILDER_SLICE_TITLE: str(t.title),
    BUILDER_SLICE_CONTEXT: str(t.context),
    BUILDER_ATTEMPT: str(t.attempt ?? 1),
    BUILDER_SLICE_FILE: ".slice.json",
    ...(o.base ? { BUILDER_BASE: o.base } : {}),
  };
}

/** The spec's workspace with `{ dir: parent }` made the starting run's own workspace. Throws when it has none. */
export function specWorkspace(spec: RunSpec, parent: RunRecord | null | undefined): WorkspaceSpec {
  const ws = spec.workspace ?? "empty";
  if (typeof ws !== "object" || !ws || !("dir" in ws) || ws.dir !== "parent") return ws as WorkspaceSpec;
  if (!parent) throw new Error("workspace { dir: parent } is the starting run's own workspace: only a run can start one (run_start from an agent)");
  const pw = parent.resolved?.workspace;
  if (!pw || pw === "none" || parent.kind === "server") throw new Error(`workspace { dir: parent }: run ${parent.id} has no workspace to share`);
  return { dir: { path: parent.resolved!.cwd } };
}

function resolveWorkspace(ws: WorkspaceSpec, runDir: string, c: Parameters<typeof specPath>[1]): { workspace: WorkspaceSpec; cwd: string } {
  if (ws === "empty") return { workspace: "empty", cwd: join(runDir, "workspace") };
  if (ws === "none") return { workspace: "none", cwd: runDir };
  if (typeof ws === "object" && ws && "dir" in ws) {
    const path = specPath(ws.dir.path, c);
    return { workspace: { dir: { path } }, cwd: path };
  }
  if (typeof ws === "object" && ws && "snapshot" in ws) {
    const from = specPath(ws.snapshot.from, c);
    const into = ws.snapshot.into ? specPath(ws.snapshot.into, c) : join(runDir, "workspace");
    return { workspace: { snapshot: { from, ...(ws.snapshot.ref ? { ref: ws.snapshot.ref } : {}), into } }, cwd: into };
  }
  throw new Error(`workspace ${JSON.stringify(ws)}: one of empty, none, { dir: { path } }, { snapshot: { from, ref?, into? } }`);
}

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i;

/** The env with anything that looks like a secret hidden, for printing. */
export const redactEnv = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET.test(k) ? "[redacted]" : v]));

/** Resolve a run spec. Throws with what is wrong (unknown agent, bad agent.yml, an undeclared area, E8, ...). */
export function resolve(spec: RunSpec, opts: ResolveOptions): Resolved {
  const kind = spec.workflow && !spec.agent ? "workflow" : spec.agent && !spec.workflow ? "agent" : null;
  if (!kind) throw new Error("a run spec names exactly one of workflow and agent");
  checkMayStart(opts.parent, spec);
  return kind === "workflow" ? resolveWorkflow(spec, opts) : resolveAgent(spec, opts);
}

function parentAgentDir(parent: RunRecord | null | undefined): string | undefined {
  return parent?.kind === "agent" ? parent.resolved?.agent?.dir : (parent?.resolved?.agent?.dir ?? undefined);
}

function resolveWorkflow(spec: RunSpec, opts: ResolveOptions): Resolved {
  if (spec.mode && spec.mode !== "headless") throw new Error(`a workflow run is headless: set steps.<step>.mode to run one agent step in ${spec.mode} mode`);
  for (const [name, s] of Object.entries(spec.steps ?? {})) {
    if (s.mode && s.mode !== "headless" && s.mode !== "rpc") throw new Error(`steps.${name}.mode: a workflow step runs headless or rpc, not ${s.mode}`);
  }
  const runDir = opts.runDir ?? "<runDir>";
  const areas = opts.parent?.resolved?.areas ?? {};
  const owner = opts.parent?.kind === "agent" ? `agent ${opts.parent.spec.agent}` : "the run (a workflow run has only its parent agent's areas)";
  const c = { areas, owner, agentDir: parentAgentDir(opts.parent), agentics: opts.agentics, cwd: opts.cwd };
  const { workspace, cwd } = resolveWorkspace(specWorkspace(spec, opts.parent), runDir, c);
  const d = spec.input?.dispatch !== undefined ? loadDispatch(spec.input.dispatch, c) : null;
  const repos = resolveRepos(spec.input?.repos, c);
  const ceiling = opts.parent?.ceiling ?? null;
  return {
    workflow: { id: spec.workflow! },
    mode: "headless",
    cwd,
    workspace,
    tools: ceiling ?? toolsOf(opts.config.limit),
    resources: [],
    argv: [],
    env: {},
    areas,
    mayStart: [],
    ...(d?.source ? { dispatch: d.source } : {}),
    ...(repos ? { repos } : {}),
  };
}

const PI_FLAGS = ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes"];

/** The most recently written pi session file in a directory, or null. */
export function newestSession(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      /* gone meanwhile */
    }
  }
  return best?.path ?? null;
}

const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * How a durable run resumes its agent's session (state/sessions). pi's --continue finds only a session started in the
 * same directory, and a durable run's cwd is often new (its own folder or workspace), so the newest session is named:
 * `--session <file>` when it was started in this run's cwd (pi opens it in place), else `--fork <file>`, which carries
 * its whole history into a new session in this cwd. None when there is no session yet.
 */
export function resumeFlags(sessionsDir: string, cwd: string): string[] {
  const newest = newestSession(sessionsDir);
  if (!newest) return [];
  let started: unknown;
  try {
    const first = readFileSync(newest, "utf8").split("\n", 1)[0];
    started = (JSON.parse(first) as { cwd?: unknown }).cwd;
  } catch {
    started = undefined;
  }
  const here = realOrNull(cwd);
  const same = typeof started === "string" && here !== null && realOrNull(started) === here;
  return [same ? "--session" : "--fork", newest];
}

function resolveAgent(spec: RunSpec, opts: ResolveOptions): Resolved {
  const agentics = opts.agentics ?? AGENTICS_DIR;
  const a = loadAgent(spec.agent!, agentics);
  const y = a.yml;
  const runDir = opts.runDir ?? "<runDir>";
  const mode: Mode = spec.mode ?? y.mode ?? "headless";
  if (!MODES.includes(mode)) throw new Error(`mode ${mode}: one of ${MODES.join(", ")}`);
  const areas = resolveAreas(y.areas, a.dir);
  const c = { areas, owner: `agent ${a.id}`, agentDir: a.dir, agentics, cwd: opts.cwd };

  // Tools: what the agent asks for, within the machine limit and the parent's tools.
  const allowed = toolsOf(opts.config.limit);
  const ceiling = opts.parent?.ceiling ?? null;
  const tools = toolsOf(y.tools).filter((t) => allowed.includes(t) && (ceiling === null || ceiling.includes(t)));

  // Resources, each an explicit path with its hash.
  const resources: Resource[] = [];
  const add = (kind: Resource["kind"], ref: string, path: string) => {
    if (!resources.some((r) => r.kind === kind && r.path === path)) resources.push({ kind, ref, path, sha256: contentHash(path) });
  };
  const refs = (list: string[] | undefined, kind: RefKind, as: Resource["kind"]) => {
    for (const ref of list ?? []) for (const p of resolveRef(ref, kind, c)) add(as, ref, p);
  };
  let systemFlag: { flag: string; path: string } | null = null;
  let template: string | null = null;
  if (y.prompt) {
    const [p] = resolveRef(y.prompt, "prompt", c);
    const name = basename(p);
    if (name === "SYSTEM.md" || name === "APPEND_SYSTEM.md") {
      systemFlag = { flag: name === "SYSTEM.md" ? "--system-prompt" : "--append-system-prompt", path: p };
      add("system", y.prompt, p);
    } else {
      template = name.replace(/\.md$/, "");
      add("prompt", y.prompt, p);
    }
  }
  // pi finds SYSTEM.md and APPEND_SYSTEM.md in the agent's directory itself (PI_CODING_AGENT_DIR) unless a flag names one.
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    const p = join(a.dir, name);
    const overridden = systemFlag?.flag === (name === "SYSTEM.md" ? "--system-prompt" : "--append-system-prompt");
    if (existsSync(p) && !overridden) add("system", `own:${name}`, p);
  }
  refs(y.uses?.skills, "skill", "skill");
  refs(y.uses?.extensions, "extension", "extension");
  refs(y.uses?.prompts, "prompt", "prompt");
  refs(y.gates, "gate", "gate");

  // The workspace, the dispatch and the job variables.
  const { workspace, cwd } = resolveWorkspace(specWorkspace(spec, opts.parent), runDir, c);
  const input = spec.input ?? {};
  const d = input.dispatch !== undefined ? loadDispatch(input.dispatch, c) : null;
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: a.dir,
    PI_NO_UPDATE_CHECK: "1",
    BUILDER_RUN_DIR: runDir,
    BUILDER_DONE_FILE: join(runDir, "done.json"),
    BUILDER_HALT_FILE: join(runDir, "halt.json"),
    ...(d ? dispatchEnv(d.dispatch, { jobId: input.jobId, runId: basename(runDir), base: input.base }) : input.base ? { BUILDER_BASE: input.base } : {}),
  };

  // The first message.
  const args = (input.args ?? []).map(String);
  let message: string | undefined = typeof input.message === "string" ? input.message : undefined;
  if (message === undefined && template && mode !== "interactive") message = [`/${template}`, ...args.map(quoteArg)].join(" ");
  if (mode === "headless" && message === undefined) throw new Error(`a headless run of ${a.id} needs input.message: its prompt (${y.prompt ?? "none"}) is not a prompt template`);

  const live = piSettings(a.dir);
  const settings = { provider: spec.settings?.provider ?? live.provider, model: spec.settings?.model ?? live.model, thinking: spec.settings?.thinking ?? live.thinking };
  const argv = [...PI_FLAGS];
  for (const r of resources) {
    if (r.kind === "skill") argv.push("--skill", r.path);
    else if (r.kind === "extension") argv.push("-e", r.path);
    else if (r.kind === "prompt") argv.push("--prompt-template", r.path);
  }
  if (systemFlag) argv.push(systemFlag.flag, systemFlag.path);
  argv.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
  if (mode === "durable") {
    const sessions = join(a.dir, "state", "sessions");
    argv.push("--session-dir", sessions, ...resumeFlags(sessions, cwd));
  } else argv.push("--session-dir", join(runDir, "sessions"));
  argv.push("--provider", settings.provider, "--model", settings.model, ...(settings.thinking ? ["--thinking", settings.thinking] : []));
  if (mode === "headless") argv.push("-p", "--", message!);
  else if (mode === "interactive") argv.push(...(message !== undefined ? ["--", message] : []));
  else argv.push("--mode", "rpc");

  return {
    agent: { id: a.id, dir: a.dir, ymlHash: a.ymlHash, defaults: a.defaults },
    mode,
    cwd,
    workspace,
    tools,
    resources,
    argv,
    env,
    areas,
    ...(y.writes ? { writes: resolveWrites(y.writes, a.dir) } : {}),
    mayStart: y.runs?.may_start ?? [],
    ...(message !== undefined ? { message } : {}),
    settings,
    ...(d?.source ? { dispatch: d.source } : {}),
    ...(y.api ? { api: apiSettings(y.api) } : {}),
    ...(y.definitions?.changes === "propose" ? { changes: "propose" as const } : {}),
    ...(mode === "durable" && y.triggers ? { triggers: parseTriggers(y.triggers) } : {}),
  };
}

// ---- gates ----

/** An agent.yml's writes: globs relative to the workspace stay so; own:<glob> is in the agent's directory, ~ expands. */
export function resolveWrites(writes: string[], dir: string): string[] {
  return writes.map((w) => {
    if (w.startsWith("own:")) return join(dir, w.slice(4));
    if (/^(shared|builder|data|area):/.test(w)) throw new Error(`${join(dir, "agent.yml")}: writes ${w}: a writes entry is a glob relative to the workspace, own:<glob>, ~/... or absolute`);
    const abs = expandHome(w);
    return isAbsolute(abs) ? abs : w;
  });
}

/** The gate host pi extension. */
export const GATE_HOST = join(BUILDER_ROOT, "runtime", "gate-host.ts");

/** A JSON list of the machine config files given with --config: run processes carry it, so the tree protects them too. */
export { CONFIG_FILES_ENV };

/** What no agent may change: the packaged config, ~/.gaffer/ (machine-wide config), $GAFFER_CONFIG and --config files. */
export function protectedConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [PACKAGED_CONFIG, join(homedir(), ".gaffer")];
  if (env.GAFFER_CONFIG) out.push(resolvePath(expandHome(env.GAFFER_CONFIG)));
  try {
    const files: unknown = JSON.parse(env[CONFIG_FILES_ENV] || "[]");
    if (Array.isArray(files)) for (const f of files) if (typeof f === "string" && f) out.push(resolvePath(expandHome(f)));
  } catch {
    /* not a list: the other paths are still protected */
  }
  return [...new Set(out)];
}

/**
 * How the runner loads a run's gates: null when the run has none (a workflow run, an agent with no `gates`). Otherwise
 * pi's extra arguments (the gate host, to load after the agent's own extensions), its environment ($BUILDER_GATES)
 * and the file to write in the run's folder before pi starts: the gates in the agent.yml's order and their context.
 * `ctx.base` is empty unless the spec gave one: the host then uses $BUILDER_BASE, which the runner sets at start.
 */
export function gateHostFor(resolved: Resolved, env: NodeJS.ProcessEnv = process.env): { args: string[]; env: Record<string, string>; file: { path: string; json: GateHostFile } } | null {
  const gates = resolved.resources.filter((r) => r.kind === "gate");
  if (!resolved.agent || !gates.length) return null;
  const path = join(resolved.env.BUILDER_RUN_DIR ?? resolved.cwd, "gates.json");
  const json: GateHostFile = {
    gates: gates.map((g) => ({ ref: g.ref, path: g.path })),
    ctx: {
      cwd: resolved.cwd,
      base: resolved.env.BUILDER_BASE ?? "",
      writes: resolved.writes ?? [],
      areas: resolved.areas,
      protectedPaths: protectedConfigPaths(env),
      dispatch: Boolean(resolved.env.BUILDER_JOB_ID),
    },
  };
  return { args: ["-e", GATE_HOST], env: { BUILDER_GATES: path }, file: { path, json } };
}

/** The ceiling a run's children get: an agent run's own tools, a workflow run's parent's ceiling. */
export function ceilingOf(kind: "agent" | "workflow", resolved: Resolved, parent: RunRecord | null | undefined): string[] | null {
  return kind === "agent" ? resolved.tools : (parent?.ceiling ?? null);
}
