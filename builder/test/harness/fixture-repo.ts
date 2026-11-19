/**
 * A target repository for the contract tests: a tiny Node app in a temp dir, reachable by path, so the builder's
 * `git ls-remote` and clone work without the network.
 *
 * It has what the builder's setup needs at base (package.json, package-lock.json, tsconfig.json) and what the
 * slice commit-scope checks need: `src/slices/`, and a stand-in TypeScript compiler (`tools/fake-tsc`) that
 * FIXTURE_SETUP_COMMANDS installs as node_modules/.bin/tsc, so `npx tsc --noEmit` runs offline. It has no dependencies.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./util.ts";

export interface FixtureRepo {
  /** What a dispatch puts in `repo.url`: the repository's path. */
  url: string;
  /** The commit to build on (`repo.base`). */
  base: string;
  /** The `repo:` requirement that names this repository (`repo:<key>`). */
  requirement: string;
}

/** Stands in for `npm ci` (the fixture has no dependencies): installs the fixture's fake tsc. */
export const FIXTURE_SETUP_COMMANDS = ["mkdir -p node_modules/.bin && cp tools/fake-tsc node_modules/.bin/tsc"];

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture-app", version: "1.0.0", private: true, type: "module", scripts: { build: "tsc" } }, null, 2) + "\n",
  "package-lock.json":
    JSON.stringify({ name: "fixture-app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-app", version: "1.0.0" } } }, null, 2) + "\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "nodenext" }, include: ["src"] }, null, 2) + "\n",
  "src/index.ts": 'export const app = "fixture";\n',
  "src/slices/.gitkeep": "",
  "tools/fake-tsc": "#!/bin/sh\n# Stand-in for the TypeScript compiler: the fixture always typechecks.\nexit 0\n",
  "README.md": "# fixture-app\n\nThe builder contract tests' target repository.\n",
};

/** Create the fixture repository under `parent`, leaving out the files named in `omit`. */
export function createFixtureRepo(parent: string, opts: { omit?: string[]; name?: string } = {}): FixtureRepo {
  const dir = join(parent, opts.name ?? "fixture-app");
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(FILES)) {
    if (opts.omit?.includes(path)) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  if (!opts.omit?.includes("tools/fake-tsc")) chmodSync(join(dir, "tools/fake-tsc"), 0o755);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Scaffold the fixture app"]);
  return { url: dir, base: git(dir, ["rev-parse", "HEAD"]), requirement: `repo:${dir}` };
}
