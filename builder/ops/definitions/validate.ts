/**
 * Validating definitions before a change is written (design section 9): the change is applied to a staged copy of the
 * agent tree, and the copy is checked.
 *
 *   - schema       agent.yml and defaults.yml (runtime/resolve.ts checkAgentYml), a builder's default export
 *                  (engine/load.ts validateBuilder), a gate, a listener, active.yml, skill and prompt front matter,
 *                  settings.json and models.json as JSON
 *   - references   every agent resolves (its skills, extensions, prompts and gates exist), every builder's agent and
 *                  workflow steps and its sidecars name agents and builders that exist
 *   - TypeScript   a changed (or new) .ts module type-checks, with the builder's own compiler options
 *   - templates    a template set renders against every sample dispatch of its kind (agentics/shared/data/dispatches)
 *
 * A change is refused when the definition it changes fails, or when it breaks another definition that was valid before
 * it (a skill that agents load cannot be deleted). Definitions that were already broken are warnings.
 *
 * The staged copy: a temp folder `builder/` whose entries are links to the real builder's code (engine/, runtime/, ops/,
 * node_modules/, ...) beside a copy of the agent tree without history/, changesets/, data/local/ and what is not part
 * of any agent's definition. So a staged module's relative imports (`../../../engine/workflow.ts`) resolve exactly as
 * they will once it is written. Builder, gate and listener modules are loaded in a process of their own
 * (ops/definitions/inspect.ts), never in the caller's.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { toolsOf } from "../groups.ts";
import { agentDir, listAgents } from "../../runtime/paths.ts";
import { loadAgent, resolve, type AgentYml } from "../../runtime/resolve.ts";
import { BUILDER_ROOT } from "../../runtime/root.ts";
import { NO_LIMIT } from "../../runtime/run.ts";
import { inTree, listIds, overlaps, readFileSet, type Def, type FileSet, type Kind } from "./kinds.ts";
import { writeFileSet } from "./store.ts";

export interface Tree {
  /** The builder root the tree's modules import from (the real one, or a staged mirror of it). */
  builderRoot: string;
  agentics: string;
}

export interface Staged extends Tree {
  remove(): void;
}

export interface Report {
  errors: string[];
  warnings: string[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a staged copy of the builder links rather than copies, and what it leaves out. */
const NOT_MIRRORED = new Set(["agentics", "runs", "control", "jobs", "tsf", "test"]);
/** Not copied into a staged tree: no definition reads them, and some are large. */
const AGENT_LEVEL_SKIPPED = new Set(["data", "state", "work", "sessions", "bin"]);

/** A staged copy of the agent tree `agentics`, beside links to the builder's code. */
export function stage(agentics: string): Staged {
  const dir = mkdtempSync(join(tmpdir(), "builder-stage-"));
  const root = join(dir, "builder");
  mkdirSync(root);
  for (const name of readdirSync(BUILDER_ROOT)) if (!NOT_MIRRORED.has(name)) symlinkSync(join(BUILDER_ROOT, name), join(root, name));
  const staged = join(root, "agentics");
  const src = resolvePath(agentics);
  cpSync(src, staged, {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p);
      if (!rel) return true;
      const segs = rel.split(sep);
      if (segs.length === 1 && (segs[0] === "history" || segs[0] === "changesets")) return false;
      if (segs.includes("node_modules") || segs.includes(".git")) return false;
      if (segs[0] === "builders" && segs.length === 2 && segs[1].startsWith(".")) return false;
      const name = segs[segs.length - 1];
      if (name === "local" && segs[segs.length - 2] === "data") return false;
      if (AGENT_LEVEL_SKIPPED.has(name) && existsSync(join(dirname(p), "agent.yml"))) return false;
      return true;
    },
  });
  return { builderRoot: root, agentics: staged, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export const realTree = (agentics: string): Tree => ({ builderRoot: BUILDER_ROOT, agentics });

// ---- running things ----

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], o: { cwd: string; timeoutMs: number }): Promise<Exit> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, o.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
  });
}

const INSPECT = join(BUILDER_ROOT, "ops", "definitions", "inspect.ts");

/** Run ops/definitions/inspect.ts on a request. */
export async function inspect(request: Record<string, unknown>, timeoutMs = 60_000): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const r = await run(process.execPath, [INSPECT, JSON.stringify(request)], { cwd: BUILDER_ROOT, timeoutMs });
  if (r.timedOut) return { ok: false, error: `loading it took longer than ${Math.round(timeoutMs / 1000)} s` };
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: `it could not be loaded: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`}` };
  }
}

export interface TsError {
  file: string;
  line: number;
  message: string;
}

const TSC = join(BUILDER_ROOT, "node_modules", "typescript", "bin", "tsc");

/** Type-check `files` (absolute) with the builder's compiler options. Throws when tsc cannot run. */
export async function typeCheck(files: string[], tree: Tree): Promise<TsError[]> {
  if (!files.length) return [];
  if (!existsSync(TSC)) throw new Error(`cannot type-check: TypeScript is not installed in ${BUILDER_ROOT} (npm ci there)`);
  const base = JSON.parse(readFileSync(join(BUILDER_ROOT, "tsconfig.json"), "utf8")) as { compilerOptions?: Record<string, unknown> };
  const dir = mkdtempSync(join(tmpdir(), "builder-tsc-"));
  try {
    const config = join(dir, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { ...base.compilerOptions, noEmit: true, typeRoots: [join(BUILDER_ROOT, "node_modules", "@types")] }, files }, null, 2));
    const r = await run(process.execPath, [TSC, "-p", config, "--pretty", "false"], { cwd: tree.builderRoot, timeoutMs: 180_000 });
    if (r.timedOut) throw new Error("cannot type-check: tsc took longer than 3 minutes");
    const errors: TsError[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/.exec(line);
      if (m) errors.push({ file: resolvePath(tree.builderRoot, m[1]), line: Number(m[2]), message: m[3] });
      else if (line.startsWith("  ") && errors.length) errors[errors.length - 1].message += ` ${line.trim()}`;
    }
    if (r.code !== 0 && !errors.length) throw new Error(`cannot type-check: tsc exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-400)}`);
    return errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- inspecting a whole tree ----

export interface AgentInfo {
  id: string;
  ok: boolean;
  error?: string;
  /** Every path the agent loads: its agent.yml, defaults.yml files, resources, and the agents it extends. */
  paths: string[];
  extends: string[];
}

export interface BuilderInfo {
  id: string;
  ok: boolean;
  error?: string;
  name?: string;
  provides?: string[];
  steps: { kind: string; name: string; agent?: string; builder?: string }[];
  /** The agents its sidecars start (engine/sidecars.ts). */
  sidecars?: { name: string; agent: string }[];
}

export interface TreeInfo {
  agents: Map<string, AgentInfo>;
  builders: Map<string, BuilderInfo>;
}

/** An agent resolved as a run would (references included), without the machine limit. */
export function checkAgent(id: string, agentics: string): AgentInfo {
  try {
    const a = loadAgent(id, agentics);
    const chain: string[] = [];
    for (let y: AgentYml = a.yml, seen = 0; y.extends && seen < 16; seen++) {
      chain.push(y.extends);
      y = loadAgent(y.extends, agentics).yml;
    }
    const r = resolve({ agent: id, mode: "rpc", workspace: "none" }, { config: { limit: NO_LIMIT }, agentics, runDir: join(tmpdir(), "builder-validate-run") });
    for (const name of ["settings.json", "models.json"]) {
      const f = join(a.dir, name);
      if (!existsSync(f)) continue;
      try {
        JSON.parse(readFileSync(f, "utf8"));
      } catch (err) {
        throw new Error(`${name} is not JSON: ${messageOf(err)}`);
      }
    }
    return { id, ok: true, paths: [join(a.dir, "agent.yml"), ...a.defaults.map((d) => d.path), ...r.resources.map((x) => x.path), ...chain.map((c) => agentDir(c, agentics))], extends: chain };
  } catch (err) {
    return { id, ok: false, error: messageOf(err), paths: [], extends: [] };
  }
}

/** A builder module loaded in its own process, and its steps' references checked in the tree. */
export async function checkBuilder(id: string, tree: Tree): Promise<BuilderInfo> {
  const file = join(tree.agentics, "builders", id, "builder.ts");
  if (!existsSync(file)) return { id, ok: false, error: "it has no builder.ts", steps: [] };
  const r = await inspect({ op: "builder", file });
  if (!r.ok) return { id, ok: false, error: r.error, steps: [] };
  const steps = (r.steps as BuilderInfo["steps"]) ?? [];
  const sidecars = (r.sidecars as BuilderInfo["sidecars"]) ?? [];
  const problems: string[] = [];
  for (const s of sidecars) if (!existsSync(join(tree.agentics, "agents", s.agent, "agent.yml"))) problems.push(`sidecar ${s.name} names agent ${s.agent}, which does not exist`);
  for (const s of steps) {
    if (s.kind === "agent" && s.agent && !existsSync(join(tree.agentics, "agents", s.agent, "agent.yml"))) problems.push(`step ${s.name} names agent ${s.agent}, which does not exist`);
    if (s.kind === "workflow" && s.builder) {
      const target = isAbsolute(s.builder) || /\.(m?ts|m?js)$/.test(s.builder) ? s.builder : join(tree.agentics, "builders", s.builder, "builder.ts");
      if (!existsSync(target)) problems.push(`step ${s.name} names builder ${s.builder}, which does not exist`);
    }
  }
  return { id, ok: !problems.length, ...(problems.length ? { error: problems.join("; ") } : {}), name: r.name as string, provides: r.provides as string[], steps, ...(sidecars.length ? { sidecars } : {}) };
}

/** Every agent and builder in the tree, checked. */
export async function inspectTree(tree: Tree): Promise<TreeInfo> {
  const agents = new Map(listAgents(tree.agentics).map((id) => [id, checkAgent(id, tree.agentics)]));
  const builders = new Map((await Promise.all(listIds("builder", tree.agentics).map((id) => checkBuilder(id, tree)))).map((b) => [b.id, b]));
  return { agents, builders };
}

/** The agents and builders that load a definition (in the tree `info` describes, where `def` is located too). */
export function affectsOf(def: Def, info: TreeInfo): { agents: string[]; builders: string[] } {
  const agents = new Set<string>();
  for (const a of info.agents.values()) {
    if (!a.ok) continue;
    if (def.kind === "agent" ? a.id === def.id || a.extends.includes(def.id) : a.paths.some((p) => overlaps(p, def.path))) agents.add(a.id);
  }
  const builders = new Set<string>();
  const sharedTemplates = def.kind === "template" && def.id.startsWith("shared/");
  for (const b of info.builders.values()) {
    const dir = join(def.agentics, "builders", b.id);
    if ((def.kind === "builder" && b.id === def.id) || def.path.startsWith(dir + sep) || def.kind === "listener" || (sharedTemplates && existsSync(join(dir, "templates")))) builders.add(b.id);
    if (b.steps.some((s) => s.kind === "agent" && s.agent && agents.has(s.agent)) || b.sidecars?.some((s) => agents.has(s.agent))) builders.add(b.id);
  }
  // A builder that runs an affected builder as a step is affected too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of info.builders.values()) {
      if (!builders.has(b.id) && b.steps.some((s) => s.kind === "workflow" && s.builder && builders.has(s.builder))) {
        builders.add(b.id);
        changed = true;
      }
    }
  }
  return { agents: [...agents].sort(), builders: [...builders].sort() };
}

// ---- one definition ----

/** YAML front matter of a markdown file, or null when it has none. Throws when it does not parse. */
function frontMatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const y = parseYaml(m[1]) as unknown;
  if (y !== null && (typeof y !== "object" || Array.isArray(y))) throw new Error("front matter must be a map");
  return (y ?? {}) as Record<string, unknown>;
}

/** The sample dispatches templates render against: shared/data/dispatches (data/local/ first, by name). */
export function sampleDispatches(agentics: string): string[] {
  const byName = new Map<string, string>();
  for (const dir of [join(agentics, "shared", "data", "dispatches"), join(agentics, "shared", "data", "local", "dispatches")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) byName.set(f, join(dir, f));
  }
  return [...byName.keys()].sort().map((k) => byName.get(k)!);
}

/** Render one template set (a directory) against the sample dispatches. */
async function checkTemplateSet(set: string, builderDir: string | null, tree: Tree): Promise<Report> {
  const r = await inspect({ op: "render", set, builderDir, partials: [join(tree.agentics, "shared", "templates", "partials"), join(set, "partials")], dispatches: sampleDispatches(tree.agentics) });
  const name = relative(tree.agentics, set).split(sep).join("/");
  if (!r.ok) return { errors: [`template set ${name}: ${r.error}`], warnings: [] };
  const rendered = (r.rendered as unknown[] | undefined) ?? [];
  return { errors: [], warnings: r.note ? [`template set ${name}: ${r.note as string}`] : rendered.length ? [] : [`template set ${name}: no sample dispatch of its kind, so it was not rendered`] };
}

/** The template sets a definition holds or feeds: a set, a builder's sets, every set for the shared partials. */
function templateSets(def: Def, tree: Tree): { set: string; builderDir: string | null }[] {
  const setsOf = (builder: string) => {
    const root = join(tree.agentics, "builders", builder, "templates");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "partials")
      .map((e) => ({ set: join(root, e.name), builderDir: join(tree.agentics, "builders", builder) }));
  };
  if (def.kind === "builder") return setsOf(def.id);
  if (def.kind !== "template") return [];
  const [owner, set] = def.id.split("/");
  if (owner === "shared") return listIds("builder", tree.agentics).flatMap(setsOf);
  return [{ set: join(tree.agentics, "builders", owner, "templates", set), builderDir: join(tree.agentics, "builders", owner) }];
}

/** The .ts files of a definition (absolute). */
export function tsFilesOf(def: Def, files: FileSet): string[] {
  return [...files.keys()].filter((f) => /\.m?ts$/.test(f) && !f.endsWith(".d.ts")).map((f) => (def.single ? def.path : join(def.path, ...f.split("/"))));
}

/**
 * Check one definition in a tree (the staged copy, or the real tree for definitions_validate). `tsFiles` are the
 * modules to type-check (absolute, in that tree); `tree` info is the tree's agents and builders, already checked.
 */
export async function checkDefinition(def: Def, tree: Tree, info: TreeInfo, tsErrors: TsError[]): Promise<Report> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files = readFileSet(def);
  if (!files) return { errors: [`${def.kind} ${def.id} does not exist`], warnings };
  const label = (file: string) => relative(tree.agentics, file).split(sep).join("/");
  for (const e of tsErrors) if (def.single ? e.file === def.path : e.file.startsWith(def.path + sep)) errors.push(`${label(e.file)}:${e.line}: ${e.message}`);
  switch (def.kind) {
    case "builder": {
      if (!files.has("builder.ts")) errors.push("a builder needs builder.ts");
      const b = info.builders.get(def.id);
      if (b && !b.ok) errors.push(`builder.ts: ${b.error}`);
      break;
    }
    case "agent": {
      if (!files.has("agent.yml")) errors.push("an agent needs agent.yml");
      const a = info.agents.get(def.id) ?? checkAgent(def.id, tree.agentics);
      if (!a.ok) errors.push(a.error ?? "it does not resolve");
      break;
    }
    case "skill": {
      const text = def.single ? [...files.values()][0]?.toString("utf8") : files.get("SKILL.md")?.toString("utf8");
      if (text === undefined) errors.push("a skill needs SKILL.md");
      else
        try {
          const fm = frontMatter(text);
          if (!fm || typeof fm.description !== "string" || !fm.description.trim()) errors.push("SKILL.md needs front matter with a description (--- name: ..., description: ... ---)");
        } catch (err) {
          errors.push(`SKILL.md front matter: ${messageOf(err)}`);
        }
      break;
    }
    case "prompt": {
      const text = [...files.values()][0]?.toString("utf8") ?? "";
      try {
        frontMatter(text);
      } catch (err) {
        errors.push(`front matter: ${messageOf(err)}`);
      }
      if (!text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim()) errors.push("the prompt template is empty");
      break;
    }
    case "gate":
    case "listener": {
      if (!errors.length) {
        const r = await inspect({ op: def.kind, file: def.path });
        if (!r.ok) errors.push(r.error ?? "it does not load");
      }
      break;
    }
    case "active": {
      try {
        const y = parseYaml([...files.values()][0]?.toString("utf8") ?? "") as unknown;
        const keys = y && typeof y === "object" && !Array.isArray(y) ? Object.keys(y) : [];
        const id = (y as { builder?: unknown } | null)?.builder;
        if (typeof id !== "string" || keys.some((k) => k !== "builder")) errors.push("active.yml holds one key, builder: <builder id>");
        else {
          const b = info.builders.get(id);
          if (!b) errors.push(`active.yml names builder ${id}, which does not exist`);
          else if (!b.ok) errors.push(`active.yml names builder ${id}, which is not valid: ${b.error}`);
        }
      } catch (err) {
        errors.push(`active.yml: ${messageOf(err)}`);
      }
      break;
    }
    case "template":
      break;
  }
  for (const s of templateSets(def, tree)) {
    const r = await checkTemplateSet(s.set, s.builderDir, tree);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { errors, warnings };
}

/**
 * Validate a change staged in `staged`: the definition itself, then every agent and builder of the tree, comparing with
 * the real tree so only what the change breaks is an error. Returns the report and the tree info (for affects).
 */
export async function validateStaged(def: Def, staged: Tree, real: Tree, tsFiles: string[], deleting: boolean): Promise<{ report: Report; info: TreeInfo }> {
  const info = await inspectTree(staged);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!deleting) {
    let tsErrors: TsError[] = [];
    try {
      tsErrors = await typeCheck(tsFiles, staged);
    } catch (err) {
      errors.push(messageOf(err));
    }
    const own = await checkDefinition(inTree(def, staged.agentics), staged, info, tsErrors);
    errors.push(...own.errors);
    warnings.push(...own.warnings);
  }
  // What else fails now: an error only when it was valid before the change (the definition's own errors are above).
  const self = (kind: Kind, id: string) => def.kind === kind && def.id === id;
  for (const a of info.agents.values()) {
    if (a.ok || self("agent", a.id)) continue;
    const was = existsSync(join(real.agentics, "agents", a.id, "agent.yml")) ? checkAgent(a.id, real.agentics) : null;
    (was?.ok ? errors : warnings).push(`agent ${a.id}: ${a.error}${was?.ok ? "" : " (already broken)"}`);
  }
  for (const b of info.builders.values()) {
    if (b.ok || self("builder", b.id)) continue;
    const was = existsSync(join(real.agentics, "builders", b.id, "builder.ts")) ? await checkBuilder(b.id, real) : null;
    (was?.ok ? errors : warnings).push(`builder ${b.id}: ${b.error}${was?.ok ? "" : " (already broken)"}`);
  }
  return { report: { errors: [...new Set(errors)], warnings: [...new Set(warnings)] }, info };
}

// ---- E25: a change never widens the calling agent or a run above it ----

interface Limits {
  tools: string[];
  mayStart: string[];
  writes: string[];
  writable: string[];
  propose: boolean;
  /** The gates it loads: one fewer is a limit gone. */
  gates: string[];
}

/**
 * An agent's limits as the same things before and after a change: read from `agentics` (the real tree or the staged
 * copy), with every path resolved as it would be in the real tree (`real`). So a relative area path is the same area
 * in both, and moving a writable area elsewhere reads as a new one.
 */
function limitsOf(id: string, agentics: string, real: string): Limits | null {
  let y: AgentYml;
  try {
    y = loadAgent(id, agentics).yml;
  } catch {
    return null;
  }
  let tools: string[] = [];
  try {
    tools = toolsOf(y.tools);
  } catch {
    tools = [];
  }
  const from = resolvePath(agentics);
  const to = resolvePath(real);
  // A path inside the tree read (an inherited own: reference is absolute there) as the same path in the real tree.
  const asReal = (p: string) => (p === from || p.startsWith(from + sep) ? to + p.slice(from.length) : p);
  const dir = join(to, "agents", id);
  const home = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  return {
    tools,
    mayStart: y.runs?.may_start ?? [],
    writes: (y.writes ?? []).map((w) => (w.startsWith("own:") ? join(dir, w.slice(4)) : asReal(home(w)))),
    writable: Object.entries(y.areas ?? {})
      .filter(([, a]) => a?.write === true)
      .map(([name, a]) => `${name}=${resolvePath(dir, home(a.path ?? "data"))}`),
    propose: y.definitions?.changes === "propose",
    gates: (y.gates ?? []).map((g) => (g.startsWith("own:") ? join(dir, g.slice(4)) : asReal(g))),
  };
}

/** How a change widens agent `id` (its next runs): what it would gain. Empty when it does not. */
export function widening(id: string, real: string, staged: string): string[] {
  const before = limitsOf(id, real, real);
  const after = limitsOf(id, staged, real);
  if (!before || !after) return [];
  const gained = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
  const out: string[] = [];
  const tools = gained(before.tools, after.tools);
  if (tools.length) out.push(`tools ${tools.join(", ")}`);
  const starts = gained(before.mayStart, after.mayStart);
  if (starts.length) out.push(`runs.may_start ${starts.join(", ")}`);
  const writes = gained(before.writes, after.writes);
  if (writes.length) out.push(`writes ${writes.join(", ")}`);
  const areas = gained(before.writable, after.writable);
  // A writable area that is new, or that now points somewhere else (moved), is a place it could not write before.
  if (areas.length) out.push(`writable areas ${areas.map((a) => a.replace("=", " at ")).join(", ")}`);
  if (before.propose && !after.propose) out.push("definitions.changes write (it proposes today)");
  const dropped = before.gates.filter((g) => !after.gates.includes(g));
  if (dropped.length) out.push(`fewer gates: ${dropped.join(", ")} no longer checks its tool calls`);
  return out;
}

/** The gate files agent `id` loads now (its resolved gates), for E25 on a gate change. */
export function gatesOf(id: string, agentics: string): string[] {
  try {
    return resolve({ agent: id, mode: "rpc", workspace: "none" }, { config: { limit: NO_LIMIT }, agentics, runDir: join(tmpdir(), "builder-validate-run") })
      .resources.filter((r) => r.kind === "gate")
      .map((r) => r.path);
  } catch {
    return [];
  }
}

/** Apply `next` to the staged copy of `def` (null: delete it there). */
export function stageChange(def: Def, next: FileSet | null, staged: Staged): Def {
  const d = inTree(def, staged.agentics);
  writeFileSet(d, next, readFileSet(d));
  return d;
}
