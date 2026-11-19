/**
 * What a build changed, found by content hash rather than git (formerly the dev bus's manifest and diff; the bus
 * itself is gone, and messaging between runs is P6), and the verdict types checks.ts returns.
 *
 * `manifest(dir)` hashes every file under a directory, `manifestAt(dir, base)` the same tree at a commit (git archive
 * of the directory's subtree), and `diff` gives the files added or modified and the files deleted between two.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export type Status = "pass" | "fail" | "check" | "info";
export interface Finding {
  id: string;
  kind: "code" | "jev";
  status: Status;
  detail: string;
}
export interface Verdict {
  verdict: "pass" | "fail";
  summary: string;
  findings: Finding[];
}

/** Never part of a build's changes: dependencies, git internals, the slice spec, the agent's scratch scripts. */
const SKIP = new Set(["node_modules", ".git", ".slice.json", ".scratch"]);

/** Content hash of every file under `dir`, keyed by relative path. */
export function manifest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(relative(dir, p), createHash("sha1").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The manifest of `dir` as it was at commit `base` (the directory may be a subdirectory of its repository). */
export function manifestAt(dir: string, base: string): Map<string, string> {
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sha = git(["rev-parse", "--verify", `${base}^{commit}`]);
  const prefix = git(["rev-parse", "--show-prefix"]).replace(/\/$/, "");
  const tmp = mkdtempSync(join(tmpdir(), "verifier-base-"));
  try {
    execSync(`git -C ${sh(dir)} archive ${prefix ? `${sha}:${prefix}` : sha} | tar -x -C ${sh(tmp)}`, { stdio: ["ignore", "ignore", "pipe"] });
    return manifest(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Files added or modified, and files deleted, between two manifests. */
export function diff(before: Map<string, string>, after: Map<string, string>): { changed: string[]; deleted: string[] } {
  const changed = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p).sort();
  const deleted = [...before.keys()].filter((p) => !after.has(p)).sort();
  return { changed, deleted };
}
