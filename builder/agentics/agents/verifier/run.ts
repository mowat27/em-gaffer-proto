#!/usr/bin/env node
/**
 * Run the verifier's checks in a fresh process, so the latest checks.ts always applies.
 *
 *   node run.ts --workspace <dir> [--slice <file>] [--base <ref>]   verify a build: the files changed since `base`
 *                                                                   (default HEAD) in the workspace, against the
 *                                                                   slice in `file` (default <dir>/.slice.json; a
 *                                                                   dispatch file works too: its `slice` is used)
 *   node run.ts <job.json>                                          verify a build from a job file
 *   node run.ts --list                                              print the rules catalogue (RULES in checks.ts)
 *
 * Prints the verdict (or the rules) as JSON. A job file is { jobId, name, slice, workDir, before }, where `before`
 * maps each file to its content hash before the build (test/baseline/verify-workspaces.ts writes them). The changed
 * files are found by comparing content hashes, never git's index. Reads TYPESAFE_API_KEY.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { diff, manifest, manifestAt } from "./changes.ts";
import { RULES, verify } from "./checks.ts";

export interface JobFile {
  jobId: string;
  name: string;
  slice: { title?: string; context?: string };
  workDir: string;
  before: Record<string, string>;
}

/** The slice in a file holding a slice, or a dispatch (its `slice`). */
export function sliceFrom(file: string): unknown {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return doc && typeof doc === "object" && "slice" in doc && "task" in doc ? doc.slice : doc;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { workspace: { type: "string" }, slice: { type: "string" }, base: { type: "string" }, list: { type: "boolean" } },
  });
  const key = process.env.TYPESAFE_API_KEY ?? "";
  if (values.list) {
    console.log(JSON.stringify(RULES));
  } else if (values.workspace) {
    const dir = resolve(values.workspace);
    const slice = sliceFrom(resolve(values.slice ?? join(dir, ".slice.json")));
    const { changed, deleted } = diff(manifestAt(dir, values.base ?? "HEAD"), manifest(dir));
    console.log(JSON.stringify(await verify(dir, slice, changed, deleted, key)));
  } else if (positionals[0]) {
    const job = JSON.parse(readFileSync(positionals[0], "utf8")) as JobFile;
    const { changed, deleted } = diff(new Map(Object.entries(job.before)), manifest(job.workDir));
    console.log(JSON.stringify(await verify(job.workDir, job.slice, changed, deleted, key)));
  } else {
    console.error("usage: node run.ts --workspace <dir> [--slice <file>] [--base <ref>] | <job.json> | --list");
    process.exit(2);
  }
}
