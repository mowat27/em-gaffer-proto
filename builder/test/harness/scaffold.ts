/**
 * The scaffold's golden and compile harness: render a sample dispatch's template set the way the supabase-api
 * builder's classify and scaffold steps do (classifyDispatch, templatesDir, viewModelInput + modelFor, renderSet), into
 * a temp dir or a snapshot workspace, then compare with test/golden/<case>/ or compile.
 *
 * A golden case is a folder test/golden/<case>/:
 *   case.json     optional: { "dispatch": "<name>" }; default the case's own name (agentics/shared/data/dispatches/<name>.json)
 *   before/       optional: files laid over the workspace before rendering (an earlier build, for a CHANGED dispatch)
 *   files/        expected: every file the scaffold created or changed (created files, and targets it injected into)
 *   report.json   expected: the scaffold report
 * test/golden/_base/ (optional) holds files every golden case starts from, before its before/: the parts of the app
 * at the dispatches' base that injections target (src/common/loadPostgresEventstore.ts, ...). Folders starting with
 * `_` are not cases.
 *
 * UPDATE_GOLDEN=1 writes files/ and report.json from what the scaffold renders instead of comparing: review the diff.
 *
 * The compile check renders into a snapshot workspace of the dev repository (invoice-lite) at the dispatch's base,
 * through the runtime's snapshot cache (<runsDir>/.snapshots), lays the case's before/ (not _base/) over it, and runs
 * `npx tsc --noEmit` there.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TEMPLATES, templatesDir } from "../../agentics/builders/supabase-api/builder.ts";
import { modelFor, viewModelInput } from "../../agentics/builders/supabase-api/view-model.ts";
import { classifyDispatch, type Classification } from "../../engine/steps/classify.ts";
import { hasTemplates, renderSet, type ScaffoldReport } from "../../engine/templates.ts";
import type { Dispatch } from "../../engine/types.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "../../runtime/root.ts";
import { prepareWorkspace } from "../../runtime/workspace.ts";
import { tempDir } from "./util.ts";

export const DISPATCHES = join(AGENTICS_DIR, "shared", "data", "dispatches");
export const GOLDEN = join(BUILDER_ROOT, "test", "golden");
export const BASE_LAYER = "_base";

export interface CaseOptions {
  /** The golden root (default test/golden). */
  golden?: string;
  /** The template sets' root (default the builder's templates/). */
  templates?: string;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The sample dispatches' names (agentics/shared/data/dispatches/*.json without board.json), sorted. */
export function dispatchNames(): string[] {
  return readdirSync(DISPATCHES)
    .filter((f) => f.endsWith(".json") && f !== "board.json")
    .map((f) => f.slice(0, -".json".length))
    .sort(byCodeUnit);
}

export function loadDispatch(name: string): Dispatch {
  return JSON.parse(readFileSync(join(DISPATCHES, `${name}.json`), "utf8")) as Dispatch;
}

/** The golden cases under the root, sorted. */
export function goldenCases(o: CaseOptions = {}): string[] {
  const root = o.golden ?? GOLDEN;
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort(byCodeUnit);
}

/** The dispatch a case renders. */
export function caseDispatch(name: string, o: CaseOptions = {}): string {
  const file = join(o.golden ?? GOLDEN, name, "case.json");
  if (!existsSync(file)) return name;
  const c = JSON.parse(readFileSync(file, "utf8")) as { dispatch?: unknown };
  return typeof c.dispatch === "string" && c.dispatch ? c.dispatch : name;
}

/** The template set for a dispatch's kind, and whether it has templates. */
export function setFor(dispatch: Dispatch, o: CaseOptions = {}): { classification: Classification; set: string; ready: boolean } {
  const classification = classifyDispatch(dispatch);
  const set = templatesDir(classification.kind, o.templates ?? TEMPLATES);
  return { classification, set, ready: hasTemplates(set) };
}

/** Every file under `dir`, relative posix path -> content. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => byCodeUnit(a, b)));
}

export interface RenderedCase {
  dispatch: string;
  classification: Classification;
  report: ScaffoldReport;
  /** What the scaffold created or changed: path -> content, sorted. */
  outputs: Record<string, string>;
}

/**
 * Render a case into `dir`: lay _base/ (when `base`) and the case's before/ over it, then classify, build the view
 * model from `dir` and render the kind's set there, as the builder's steps do.
 */
export function renderCase(name: string, dir: string, o: CaseOptions & { base?: boolean } = {}): RenderedCase {
  const root = o.golden ?? GOLDEN;
  const dispatchName = caseDispatch(name, o);
  const dispatch = loadDispatch(dispatchName);
  mkdirSync(dir, { recursive: true });
  for (const layer of [...(o.base ? [join(root, BASE_LAYER)] : []), join(root, name, "before")]) {
    if (existsSync(layer)) cpSync(layer, dir, { recursive: true });
  }
  const { classification, set, ready } = setFor(dispatch, o);
  const data = ready ? modelFor(classification, viewModelInput(classification, dispatch, dir)) : undefined;
  const report = renderSet(set, data, { dir, verdict: classification.verdict });
  const changed = [...report.files.filter((f) => f.action === "created").map((f) => f.path), ...report.injections.filter((i) => i.action === "inserted").map((i) => i.target)];
  const outputs = Object.fromEntries([...new Set(changed)].sort(byCodeUnit).map((p) => [p, readFileSync(join(dir, p), "utf8")]));
  return { dispatch: dispatchName, classification, report, outputs };
}

const reportText = (r: ScaffoldReport) => JSON.stringify(r, null, 2) + "\n";

/** The first line where two texts differ, for a readable failure. */
function firstDifference(want: string, got: string): string {
  const a = want.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: expected ${JSON.stringify(a[i] ?? "(end of file)")}, got ${JSON.stringify(b[i] ?? "(end of file)")}`;
  }
  return "same text";
}

/**
 * Render a golden case into a temp dir (starting from _base/) and compare with its files/ and report.json. Returns the
 * differences (none = pass). With `update` (default $UPDATE_GOLDEN=1) it writes files/ and report.json instead.
 */
export function checkGolden(name: string, o: CaseOptions & { update?: boolean } = {}): { diffs: string[]; rendered: RenderedCase } {
  const root = o.golden ?? GOLDEN;
  const tmp = tempDir(`builder-golden-${name}`);
  try {
    const rendered = renderCase(name, tmp.dir, { ...o, base: true });
    const caseDir = join(root, name);
    const filesDir = join(caseDir, "files");
    if (o.update ?? process.env.UPDATE_GOLDEN === "1") {
      rmSync(filesDir, { recursive: true, force: true });
      for (const [p, content] of Object.entries(rendered.outputs)) {
        mkdirSync(join(filesDir, p, ".."), { recursive: true });
        writeFileSync(join(filesDir, p), content);
      }
      writeFileSync(join(caseDir, "report.json"), reportText(rendered.report));
      return { diffs: [], rendered };
    }
    const diffs: string[] = [];
    const want = readTree(filesDir);
    for (const p of Object.keys(want)) if (!(p in rendered.outputs)) diffs.push(`${p}: expected, but the scaffold did not create or change it`);
    for (const [p, got] of Object.entries(rendered.outputs)) {
      if (!(p in want)) diffs.push(`${p}: created or changed by the scaffold, but not in files/`);
      else if (want[p] !== got) diffs.push(`${p}: differs at ${firstDifference(want[p], got)}`);
    }
    const reportFile = join(caseDir, "report.json");
    const wantReport = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : null;
    if (wantReport === null) diffs.push("report.json: missing");
    else if (wantReport !== reportText(rendered.report)) diffs.push(`report.json: differs at ${firstDifference(wantReport, reportText(rendered.report))}`);
    if (diffs.length) diffs.push(`(rerun with UPDATE_GOLDEN=1 to accept what the scaffold renders, then review the diff of test/golden/${name}/)`);
    return { diffs, rendered };
  } finally {
    tmp.remove();
  }
}

// ---- compiling against the dev repository ----

/** The dev repository: $BUILDER_DEV_REPO, else invoice-lite beside the gaffer repository. */
export function devRepo(): string {
  return resolve(process.env.BUILDER_DEV_REPO ?? join(BUILDER_ROOT, "..", "..", "invoice-lite"));
}

/** The runtime's snapshot cache: <runsDir>/.snapshots ($BUILDER_RUNS_DIR, else builder/runs). */
export function snapshotsDir(): string {
  return join(process.env.BUILDER_RUNS_DIR ?? join(BUILDER_ROOT, "runs"), ".snapshots");
}

/** True when `repo` is a git repository that has `commit`. */
export function hasCommit(repo: string, commit: string): boolean {
  return existsSync(repo) && statSync(repo).isDirectory() && spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo, stdio: "ignore" }).status === 0;
}

/**
 * A snapshot workspace of `repo` at the dispatch's base (cached), with the case's before/ laid over it and the
 * dispatch's set rendered into it. Returns the workspace and what was rendered.
 */
export function renderIntoSnapshot(name: string, parent: string, o: CaseOptions & { repo?: string } = {}): { dir: string; rendered: RenderedCase } {
  const repo = o.repo ?? devRepo();
  const base = loadDispatch(caseDispatch(name, o)).repo.base;
  const dir = join(parent, name);
  prepareWorkspace(join(parent, `${name}.run`), { snapshot: { from: repo, ref: base, into: dir } }, { snapshotsDir: snapshotsDir() });
  return { dir, rendered: renderCase(name, dir, { ...o, base: false }) };
}

/** `npx tsc --noEmit` in `dir`: the exit code and the output's first lines. */
export function typecheck(dir: string, timeoutMs = 180_000): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    let output = "";
    const child = spawn("npx", ["--no-install", "tsc", "--noEmit"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output: output.split("\n").slice(0, 60).join("\n") });
    });
  });
}
