import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { projectPaths, skillDir, type ProjectPaths } from "../../src/core/paths.ts";
import { tmpDir } from "./tmp.ts";

const run = promisify(execFile);

export const installScript = join(skillDir, "scripts", "install.sh");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command and return its exit code and output instead of throwing on a non-zero exit. */
export async function exec(
  file: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  try {
    const r = await run(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8" });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Run `scripts/install.sh` with `cwd` as the target. */
export function runInstall(cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  // The tsf/app copy needs its own npm install, so test projects run from the skill app unless a test asks for it.
  return exec("bash", [installScript], { cwd, env: { ...process.env, TSF_INSTALL_NO_APP: "1", ...env } });
}

/** A temp git repo with the factory installed by `scripts/install.sh`. `permissions` replaces `tsf/permissions.json`. */
export async function makeProject(opts: { permissions?: object } = {}): Promise<{ root: string; paths: ProjectPaths }> {
  const root = await tmpDir("tsf-project");
  await run("git", ["init", "-q"], { cwd: root });
  const r = await runInstall(root);
  if (r.code !== 0) throw new Error(`install.sh failed (${r.code}): ${r.stderr}`);
  const paths = projectPaths(root);
  if (opts.permissions) await writeFile(paths.permissionsFile, `${JSON.stringify(opts.permissions, null, 2)}\n`);
  return { root, paths };
}
