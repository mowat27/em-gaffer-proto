#!/usr/bin/env node
/**
 * Run the verifier non-interactively on every job workspace record-dispatches.ts kept, as the dev loop's verifier
 * would have judged the build.
 *
 *   av node builder/test/baseline/verify-workspaces.ts [options]
 *
 *   --results <dir>    record-dispatches.ts output (default: tmp/build-refactor/baseline/dispatches)
 *   --out <dir>        verdicts (default: <results>/../verifier)
 *   --builder <dir>    the builder tree whose agentics/agents/verifier/run.ts judges (default: the builder/ this file is in)
 *   --examples <dir>   the dispatches, for each slice (default: examples/dispatch at the repository root)
 *   --only <a,b>       these dispatches only
 *
 * For each result whose workspace changed files since base, it writes the job file the verifier's run.ts expects
 * (<out>/jobs/<name>.json: { jobId, name, slice, workDir, before }, `before` = the content hash of every file of
 * the tree at base, by the verifier's manifest()), runs `node <builder>/agentics/agents/verifier/run.ts <job file>` and saves the
 * verdict it prints as <out>/<name>.json. <out>/summary.json lists every dispatch, verified or skipped and why.
 * Reads TYPESAFE_API_KEY (run under `av`).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { diff, manifest } from "../../agentics/agents/verifier/changes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const { values: opt } = parseArgs({
  options: {
    results: { type: "string", default: join(REPO_ROOT, "tmp", "build-refactor", "baseline", "dispatches") },
    out: { type: "string" },
    builder: { type: "string", default: resolve(HERE, "..", "..") },
    examples: { type: "string", default: join(REPO_ROOT, "examples", "dispatch") },
    only: { type: "string" },
  },
});
const resultsDir = resolve(opt.results!);
const outDir = resolve(opt.out ?? join(resultsDir, "..", "verifier"));
const builderDir = resolve(opt.builder!);
const only = opt.only ? opt.only.split(",").map((s) => s.trim()) : null;

interface Result {
  dispatch: string;
  jobId: string;
  base: string;
  outcome: string;
  workspace: string | null;
}

/** The content hashes of the tree at `base`, as the verifier's `begin` would have recorded them before the build. */
function manifestAtBase(ws: string, base: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "verify-base-"));
  try {
    execSync(`git -C '${ws}' archive ${base} | tar -x -C '${dir}'`, { stdio: ["ignore", "ignore", "pipe"] });
    return Object.fromEntries(manifest(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(join(outDir, "jobs"), { recursive: true });
const summary: Record<string, unknown>[] = [];
const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "summary.json" && f !== "builder-config.json").sort();
for (const file of files) {
  const r = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as Result;
  if (!r.dispatch || (only && !only.includes(r.dispatch))) continue;
  const row: Record<string, unknown> = { dispatch: r.dispatch, outcome: r.outcome };
  if (!r.workspace || !existsSync(r.workspace)) {
    summary.push({ ...row, skipped: "no workspace" });
    continue;
  }
  const before = manifestAtBase(r.workspace, r.base);
  const { changed, deleted } = diff(new Map(Object.entries(before)), manifest(r.workspace));
  row.changed = changed.length;
  row.deleted = deleted.length;
  if (!changed.length && !deleted.length) {
    summary.push({ ...row, skipped: "the workspace has no changes since base" });
    continue;
  }
  const d = JSON.parse(readFileSync(join(opt.examples!, `${r.dispatch}.json`), "utf8")) as { slice: unknown };
  const jobFile = join(outDir, "jobs", `${r.dispatch}.json`);
  writeFileSync(jobFile, JSON.stringify({ jobId: r.jobId, name: r.dispatch, slice: d.slice, workDir: r.workspace, before }));
  const started = Date.now();
  try {
    const out = execFileSync(process.execPath, [join(builderDir, "agentics", "agents", "verifier", "run.ts"), jobFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
    const verdict = JSON.parse(out) as { verdict: string; summary: string; findings: { id: string; status: string }[] };
    writeFileSync(join(outDir, `${r.dispatch}.json`), JSON.stringify(verdict, null, 2) + "\n");
    const failing = verdict.findings.filter((f) => f.status === "fail" || f.status === "check").map((f) => `${f.status}:${f.id}`);
    summary.push({ ...row, verdict: verdict.verdict, summary: verdict.summary, failing, seconds: Math.round((Date.now() - started) / 1000) });
    console.log(`[verify] ${r.dispatch}: ${verdict.verdict.toUpperCase()} ${verdict.summary}`);
  } catch (err) {
    summary.push({ ...row, error: (err as Error).message.slice(0, 800) });
    console.log(`[verify] ${r.dispatch}: error ${(err as Error).message.slice(0, 200)}`);
  }
}
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ builderTree: builderDir, verifiedAt: new Date().toISOString(), rows: summary }, null, 2) + "\n");
console.log(`[verify] done: ${join(outDir, "summary.json")}`);
