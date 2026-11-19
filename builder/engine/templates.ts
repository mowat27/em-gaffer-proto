/**
 * Template sets: the deterministic scaffold rendered before the agent starts (design section 4).
 *
 * A set is a directory whose tree mirrors the output paths. Every `*.hbs` file is a template; anything else (a
 * .gitkeep, a README) is ignored. Two folders at the set's root are special:
 *   partials/     partials for this set, used as `{{> name}}` (name = the path below partials/ without .hbs). They
 *                 override the shared ones in agentics/shared/templates/partials/.
 *   injections/   snippets inserted into files that already exist (see below).
 *
 * Paths: each segment of a template's path (without .hbs) is rendered, so `src/slices/{{context}}/{{pascal
 * slice}}/{{pascal slice}}Command.ts.hbs` names its output. A segment that renders empty leaves the file out (its
 * content is not rendered), which is how a file is made conditional: the view model computes the name, or "". A
 * segment never renders to `.`, `..` or a name holding a slash, and nothing is written outside the target directory.
 *
 * Files: a file that does not exist is created; a file that exists is kept and never overwritten, whatever the verdict
 * (NEW or CHANGED). So shared files (a context's event union) can be templates too: created by the first slice that
 * needs them, kept after that, and extended through injections.
 *
 * Injections: `injections/*.hbs`, YAML front matter then a body:
 *   ---
 *   target: 'src/common/loadPostgresEventstore.ts'     where (rendered)
 *   anchor: '/^\s*projections: projections\.inline\(\[/'  a literal line (compared trimmed) or a /regex/ (rendered)
 *   position: after                                     after (default) or before the anchor line
 *   key: '{{pascal slice}}Projection,'                  idempotency key (rendered): present in the target = no insert
 *   each: events                                        optional: once per item of this view-model array
 *   ---
 *   body (rendered; it must contain the key)
 * With `each`, the item is the context (`this`), and `@root`, `@index`, `@first`, `@last` are set. A missing target or
 * anchor is not an error: it becomes a task in the report, with the body, for the agent to place by hand. Injections
 * run after the files, in file-name order, and see the files the set just created. Repeated insertions at one anchor
 * keep their order.
 *
 * Rendering: a private Handlebars instance, `noEscape` (code, not HTML) and `strict` (a missing field fails), with the
 * helpers below. All or nothing: everything is rendered in memory first, then written. Any error (a missing field or
 * partial, bad front matter, a path that escapes) skips the scaffold: renderSet returns a report with `skipped` and
 * writes nothing (E11). It never throws.
 *
 * Determinism: no clock and no randomness; files and injections in sorted order. The same set and view model on the
 * same files give the same bytes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import Handlebars from "handlebars";
import { parse as parseYaml } from "yaml";
import { AGENTICS_DIR } from "../runtime/root.ts";
import { markersIn } from "./markers.ts";
import { verdictOf, type Verdict } from "./steps/classify.ts";
import type { Step, StepContext } from "./types.ts";

export const SHARED_PARTIALS = join(AGENTICS_DIR, "shared", "templates", "partials");
const EXT = ".hbs";
const INJECTIONS = "injections";
const PARTIALS = "partials";

export interface ScaffoldReport {
  /** The set's directory name: the slice kind for the supabase-api builder. */
  kind: string;
  verdict: Verdict;
  /** Set when nothing was rendered: no set for the kind, or a render error. The agent builds from the skills. */
  skipped?: { reason: string };
  /** Every file the set names, sorted: created, or kept because it existed. */
  files: { path: string; action: "created" | "kept" }[];
  /** Every injection, in the order applied. */
  injections: { target: string; key: string; action: "inserted" | "present" | "task"; reason?: string }[];
  /** What the agent must do by hand: injections that found no target or anchor. */
  tasks: string[];
  /** Every BUILD: marker in the files the scaffold created or changed, by path and line. */
  markers: { path: string; line: number; text: string }[];
}

export interface RenderOptions {
  /** The directory the set renders into (the app directory). */
  dir: string;
  verdict: Verdict;
  /** Partial directories, lowest priority first. Default: the shared partials, then the set's own partials/. */
  partials?: string[];
}

// ---- helpers ----

const missing = (helper: string) => new Error(`${helper}: no value (a field the view model does not have?)`);

function words(v: unknown, helper: string): string[] {
  if (v === undefined || v === null) throw missing(helper);
  return String(v).match(/\p{Lu}+(?!\p{Ll})\p{N}*|\p{Lu}?\p{Ll}+\p{N}*|\p{N}+/gu) ?? [];
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** `create client`, `create-client`, `createClient` -> `CreateClient`. */
export const pascal = (v: unknown): string => words(v, "pascal").map(cap).join("");
/** -> `createClient`. */
export const camel = (v: unknown): string => words(v, "camel").map((w, i) => (i ? cap(w) : w.toLowerCase())).join("");
/** -> `create-client`. */
export const kebab = (v: unknown): string => words(v, "kebab").map((w) => w.toLowerCase()).join("-");
/** -> `create_client`. */
export const snake = (v: unknown): string => words(v, "snake").map((w) => w.toLowerCase()).join("_");

/** A field (`{ type, cardinality }`), or a type and an optional cardinality. */
function fieldType(a: unknown, b: unknown, helper: string): { type: string; list: boolean } {
  const f = a && typeof a === "object" ? (a as { type?: unknown; cardinality?: unknown }) : { type: a, cardinality: b };
  if (f.type === undefined || f.type === null || f.type === "") throw missing(helper);
  return { type: String(f.type).toLowerCase(), list: String(f.cardinality ?? "").toLowerCase() === "list" };
}

/** The event-modeling field types (String, UUID, Boolean, Int, Long, Double, Decimal, Date, DateTime, Custom). */
const TS_TYPES: Record<string, string> = {
  string: "string",
  uuid: "string",
  boolean: "boolean",
  int: "number",
  long: "number",
  double: "number",
  decimal: "number",
  date: "string",
  datetime: "string",
  custom: "Record<string, unknown>",
};
const SQL_TYPES: Record<string, string> = {
  string: "TEXT",
  uuid: "TEXT",
  boolean: "BOOLEAN",
  int: "INTEGER",
  long: "BIGINT",
  double: "DOUBLE PRECISION",
  decimal: "NUMERIC",
  date: "DATE",
  datetime: "TIMESTAMP",
  custom: "JSONB",
};

/** The TypeScript type of a field type: `{{tsType this}}` on a field, or `{{tsType type cardinality}}`. List -> `T[]`. Unknown -> `unknown`. */
export function tsType(type: unknown, cardinality?: unknown): string {
  const f = fieldType(type, cardinality, "tsType");
  const base = TS_TYPES[f.type] ?? "unknown";
  return f.list ? (/^\w+$/.test(base) ? `${base}[]` : `Array<${base}>`) : base;
}

/** The PostgreSQL column type (the build-state-view table). List -> JSONB. Unknown -> TEXT. */
export function sqlType(type: unknown, cardinality?: unknown): string {
  const f = fieldType(type, cardinality, "sqlType");
  return f.list ? "JSONB" : (SQL_TYPES[f.type] ?? "TEXT");
}

/** JSON text: `{{json value}}` compact, `{{json value 2}}` indented. */
export function json(v: unknown, indent?: unknown): string {
  if (v === undefined) throw missing("json");
  return JSON.stringify(v, null, typeof indent === "number" ? indent : undefined);
}

export const helpers = { pascal, camel, kebab, snake, tsType, sqlType, json };

// ---- the Handlebars instance ----

type Hb = ReturnType<typeof Handlebars.create>;
const COMPILE = { noEscape: true, strict: true } as const;

const isHelperOptions = (x: unknown) => !!x && typeof x === "object" && "hash" in x && "data" in x;

/** Files under `dir`, as posix paths relative to it, sorted by code unit (no locale). */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function instance(partialDirs: string[]): Hb {
  const hb = Handlebars.create();
  for (const [name, fn] of Object.entries(helpers) as [string, (...a: unknown[]) => unknown][]) {
    hb.registerHelper(name, (...args: unknown[]) => fn(...(args.length && isHelperOptions(args[args.length - 1]) ? args.slice(0, -1) : args)));
  }
  for (const dir of partialDirs) {
    for (const rel of walk(dir)) if (rel.endsWith(EXT)) hb.registerPartial(rel.slice(0, -EXT.length), readFileSync(join(dir, rel), "utf8"));
  }
  return hb;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- the set ----

interface SetFiles {
  templates: string[];
  injections: string[];
}

function setFiles(setDir: string): SetFiles {
  const all = walk(setDir).filter((f) => f.endsWith(EXT));
  const top = (f: string) => f.split("/")[0];
  return { templates: all.filter((f) => top(f) !== INJECTIONS && top(f) !== PARTIALS), injections: all.filter((f) => top(f) === INJECTIONS) };
}

/** True when `setDir` holds at least one template or injection. */
export function hasTemplates(setDir: string): boolean {
  const s = setFiles(setDir);
  return s.templates.length + s.injections.length > 0;
}

export function skippedReport(kind: string, verdict: Verdict, reason: string): ScaffoldReport {
  return { kind, verdict, skipped: { reason }, files: [], injections: [], tasks: [], markers: [] };
}

interface InjectionMeta {
  target: string;
  anchor: string;
  position: "after" | "before";
  key: string;
  each?: string;
}

const META_KEYS = new Set(["target", "anchor", "position", "key", "each"]);

function frontMatter(src: string, what: string): { meta: InjectionMeta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(src);
  if (!m) throw new Error(`${what}: no front matter (a --- block with target, anchor, position and key)`);
  let y: unknown;
  try {
    y = parseYaml(m[1], { logLevel: "error" });
  } catch (err) {
    throw new Error(`${what}: front matter is not YAML (quote values that hold {{ or ": "): ${messageOf(err).split("\n")[0]}`);
  }
  if (!y || typeof y !== "object" || Array.isArray(y)) throw new Error(`${what}: front matter must be a map`);
  const f = y as Record<string, unknown>;
  for (const k of Object.keys(f)) if (!META_KEYS.has(k)) throw new Error(`${what}: unknown front matter key ${k}`);
  for (const k of ["target", "anchor", "key"]) {
    if (f[k] === undefined) throw new Error(`${what}: front matter needs ${k}`);
    if (typeof f[k] !== "string" || !(f[k] as string).trim()) throw new Error(`${what}: front matter ${k} must be a non-empty string (quote values that hold {{ }})`);
  }
  const position = f.position ?? "after";
  if (position !== "after" && position !== "before") throw new Error(`${what}: position must be after or before`);
  if (f.each !== undefined && (typeof f.each !== "string" || !f.each.trim())) throw new Error(`${what}: each must name a view-model array`);
  return {
    meta: { target: f.target as string, anchor: f.anchor as string, position, key: f.key as string, ...(f.each ? { each: (f.each as string).trim() } : {}) },
    body: m[2] ?? "",
  };
}

/** A view-model value by dotted path (`events`, `model.events`). */
function lookupPath(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

function anchorMatcher(anchor: string, what: string): (line: string) => boolean {
  const re = /^\/([\s\S]+)\/([a-z]*)$/.exec(anchor.trim());
  if (re) {
    let rx: RegExp;
    try {
      rx = new RegExp(re[1], re[2].replace(/[gy]/g, ""));
    } catch (err) {
      throw new Error(`${what}: anchor ${anchor} is not a regular expression: ${messageOf(err)}`);
    }
    return (line) => rx.test(line);
  }
  const want = anchor.trim();
  return (line) => line.trim() === want;
}

/** A workspace-relative posix path, or throws when it is absolute, escapes, or enters .git or node_modules. */
function safeRel(p: string, what: string): string {
  const n = posix.normalize(p.trim().replace(/\\/g, "/"));
  if (!n || n === "." || n.startsWith("/") || n === ".." || n.startsWith("../") || /^[A-Za-z]:/.test(n)) throw new Error(`${what}: ${JSON.stringify(p)} is not a path inside the app`);
  const first = n.split("/")[0];
  if (first === ".git" || first === "node_modules") throw new Error(`${what}: ${n} is inside ${first}/`);
  return n;
}

/** Throws when `rel` resolves (through symlinks of existing folders) outside `root`. */
function assertInside(root: string, rel: string, what: string): void {
  const realRoot = realpathSync(root);
  let probe = resolve(root, rel);
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const r = relative(realRoot, real);
  if (r === ".." || r.startsWith(`..${sep}`) || resolve(realRoot, r) !== real) throw new Error(`${what}: ${rel} resolves outside the app (${real})`);
}

/** A target file during planning: its lines and which of them were there before this render's injections. */
interface Target {
  lines: string[];
  original: boolean[];
}

/**
 * Render a set into `o.dir`. Returns the report; on any error, a report with `skipped` and nothing written.
 * `data` is the view model every template renders from.
 */
export function renderSet(setDir: string, data: unknown, o: RenderOptions): ScaffoldReport {
  const kind = basename(setDir);
  const { templates, injections } = setFiles(setDir);
  if (!templates.length && !injections.length) return skippedReport(kind, o.verdict, `no template set for ${kind}`);
  try {
    if (!existsSync(o.dir) || !statSync(o.dir).isDirectory()) throw new Error(`the target directory ${o.dir} does not exist`);
    const hb = instance(o.partials ?? [SHARED_PARTIALS, join(setDir, PARTIALS)]);
    const render = (src: string, ctx: unknown, what: string, runtime?: { data: Record<string, unknown> }): string => {
      try {
        return hb.compile(src, COMPILE)(ctx, runtime);
      } catch (err) {
        throw new Error(`${what}: ${messageOf(err).split("\n")[0]}`);
      }
    };
    const onDisk = (rel: string) => {
      const abs = join(o.dir, rel);
      return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null;
    };

    // Files.
    const created = new Map<string, string>();
    const files: ScaffoldReport["files"] = [];
    for (const t of templates) {
      const segments: string[] = [];
      for (const seg of t.slice(0, -EXT.length).split("/")) {
        const r = render(seg, data, `${t} (path)`);
        if (!r.trim()) break;
        if (r === "." || r === ".." || /[/\\\0]/.test(r)) throw new Error(`${t}: path segment ${JSON.stringify(seg)} renders to ${JSON.stringify(r)}, which is not a file name`);
        segments.push(r);
      }
      if (segments.length < t.split("/").length) continue;
      // Rendered even when the file is kept, so a broken template fails the same way whatever the workspace holds.
      const content = render(readFileSync(join(setDir, t), "utf8"), data, t);
      const path = safeRel(segments.join("/"), t);
      if (files.some((f) => f.path === path)) throw new Error(`${t}: another template renders to ${path} too`);
      assertInside(o.dir, path, t);
      if (existsSync(join(o.dir, path))) files.push({ path, action: "kept" });
      else {
        created.set(path, content);
        files.push({ path, action: "created" });
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // Injections.
    const targets = new Map<string, Target>();
    const target = (rel: string): Target | null => {
      const known = targets.get(rel);
      if (known) return known;
      const text = created.get(rel) ?? onDisk(rel);
      if (text === null) return null;
      const lines = text.split("\n");
      const t = { lines, original: lines.map(() => true) };
      targets.set(rel, t);
      return t;
    };
    const report: ScaffoldReport["injections"] = [];
    const tasks: string[] = [];
    for (const inj of injections) {
      const { meta, body } = frontMatter(readFileSync(join(setDir, inj), "utf8"), inj);
      let items: unknown[] = [undefined];
      if (meta.each) {
        const v = lookupPath(data, meta.each);
        if (!Array.isArray(v)) throw new Error(`${inj}: each: ${meta.each} is not an array in the view model`);
        items = v;
      }
      items.forEach((item, i) => {
        const ctx = meta.each ? item : data;
        const runtime = meta.each ? { data: { root: data, index: i, first: i === 0, last: i === items.length - 1 } } : undefined;
        const r = (src: string, what: string) => render(src, ctx, `${inj} (${what})`, runtime);
        const rel = safeRel(r(meta.target, "target"), inj);
        const anchor = r(meta.anchor, "anchor");
        const key = r(meta.key, "key");
        const text = r(body, "body");
        if (!key.trim()) throw new Error(`${inj}: key renders empty`);
        if (!text.includes(key)) throw new Error(`${inj}: the body does not contain its key ${JSON.stringify(key)}, so the injection would repeat`);
        const matches = anchorMatcher(anchor, inj);
        const snippet = text.endsWith("\n") ? text.slice(0, -1) : text;
        const t = target(rel);
        const task = (reason: string) => {
          report.push({ target: rel, key, action: "task", reason });
          tasks.push(`${rel}: ${reason}. Add this where it belongs:\n${snippet}`);
        };
        if (!t) return task("the file does not exist");
        if (t.lines.join("\n").includes(key)) return void report.push({ target: rel, key, action: "present" });
        const at = t.lines.findIndex((line, n) => t.original[n] && matches(line));
        if (at < 0) return task(`no line matches the anchor ${anchor.trim()}`);
        assertInside(o.dir, rel, inj);
        let pos = at;
        if (meta.position === "after") for (pos = at + 1; pos < t.lines.length && !t.original[pos]; pos++);
        const add = snippet.split("\n");
        t.lines.splice(pos, 0, ...add);
        t.original.splice(pos, 0, ...add.map(() => false));
        report.push({ target: rel, key, action: "inserted" });
      });
    }

    // Everything to write: created files, with the injections into them, and changed existing files.
    const writes = new Map(created);
    for (const [rel, t] of targets) if (t.original.some((x) => !x)) writes.set(rel, t.lines.join("\n"));
    const paths = [...writes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const markers = paths.flatMap((path) => markersIn(writes.get(path)!).map((m) => ({ path, ...m })));

    writeAll(o.dir, paths.map((p) => [p, writes.get(p)!]));
    return { kind, verdict: o.verdict, files, injections: report, tasks, markers };
  } catch (err) {
    return skippedReport(kind, o.verdict, `render error: ${messageOf(err)}`);
  }
}

/** Write every file, or none: a failed write restores what was written before it. */
function writeAll(dir: string, entries: [string, string][]): void {
  const done: { abs: string; before: string | null }[] = [];
  try {
    for (const [rel, content] of entries) {
      const abs = join(dir, rel);
      const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      done.push({ abs, before });
    }
  } catch (err) {
    for (const w of done.reverse()) {
      try {
        if (w.before === null) rmSync(w.abs, { force: true });
        else writeFileSync(w.abs, w.before);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
}

// ---- the step ----

type TemplateStep = Extract<Step, { kind: "template" }>;

/**
 * The engine's template step: render the step's set into its directory and journal what happened: `scaffold.file` per
 * file and per injection, `scaffold.skipped` with the reason when nothing was rendered. It never fails the job (E11):
 * a set function, view model or directory that throws skips the scaffold like a render error does. The view model is
 * computed only when the set has templates. Returns the report, the step's output.
 */
export function runTemplateStep(step: TemplateStep, ctx: StepContext): ScaffoldReport {
  const verdict = verdictOf(ctx.job.dispatch);
  let setDir = "";
  let report: ScaffoldReport;
  // The run's pinned copies of the agent tree's templates (E1), when it made them.
  const pin = ctx.pinned ?? ((p: string) => p);
  try {
    setDir = pin(step.set(ctx));
    const kind = basename(setDir);
    if (!hasTemplates(setDir)) report = skippedReport(kind, verdict, `no template set for ${kind}`);
    else {
      let data: unknown;
      try {
        data = step.data(ctx);
      } catch (err) {
        throw new Error(`the view model failed: ${messageOf(err)}`);
      }
      report = renderSet(setDir, data, { dir: step.dir?.(ctx) ?? ctx.dir, verdict, partials: [pin(SHARED_PARTIALS), join(setDir, PARTIALS)] });
    }
  } catch (err) {
    report = skippedReport(setDir ? basename(setDir) : "unknown", verdict, messageOf(err));
  }
  if (report.skipped) ctx.emit("scaffold.skipped", `scaffold skipped: ${report.skipped.reason}`, { kind: report.kind, verdict, reason: report.skipped.reason, ...(setDir ? { set: setDir } : {}) });
  for (const f of report.files) ctx.emit("scaffold.file", `${f.action} ${f.path}`, { path: f.path, action: f.action });
  for (const i of report.injections) {
    ctx.emit("scaffold.file", `${i.action} ${i.key.trim()} in ${i.target}`, { path: i.target, action: i.action, injection: i.key, ...(i.reason ? { reason: i.reason } : {}) });
  }
  return report;
}
