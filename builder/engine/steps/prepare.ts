/**
 * prepare: get the app directory ready for the agent. Branch `job` on base; keep `.slice.json`, `node_modules/` and
 * `.scratch/` (the agent's throwaway scripts) out of the patch through .git/info/exclude; check the app has the files a
 * Node app needs; run the setup commands (npm ci) and the base checks (npx tsc --noEmit); write `.slice.json`, the
 * full slice spec as the gaffer sent it, into the app directory.
 *
 * Fails with "target repository is not set up: ..." when the base cannot build, so the agent never starts on it.
 * Returns `{ appDir }`, the app directory's absolute path, for later steps (`ctx.get("prepare")`).
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLICE_FILE } from "../../agentics/builders/supabase-api/checks.ts";
import type { StepContext } from "../types.ts";
import { git } from "./clone.ts";

export interface PrepareOptions {
  /** The app inside the clone, where package.json, tsconfig.json and src/ are ("" or "." = the clone root). */
  appDir?: string;
  /** Run in the app directory, in order. A failure fails the job. */
  setup?: string[];
  /** Run in the app directory after setup: the base must pass them. A failure fails the job. */
  baseCheck?: string[];
  /** Per command. */
  setupTimeoutMinutes?: number;
}

export interface PrepareOutput {
  appDir: string;
}

/** Run a shell command; its output goes to the job log. Killed at the timeout or when the step's signal aborts. */
export function runShell(command: string, cwd: string, timeoutMs: number, ctx: StepContext): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
  return new Promise((resolveRun) => {
    let tail = "";
    let timedOut = false;
    ctx.log(`\n$ ${command}  (in ${cwd})\n`);
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-2000);
      ctx.log(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    ctx.signal.addEventListener("abort", kill, { once: true });
    const done = (r: { code: number | null; timedOut: boolean; tail: string }) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", kill);
      resolveRun(r);
    };
    child.on("error", (err) => done({ code: -1, timedOut, tail: `${tail}\nspawn error: ${err.message}` }));
    child.on("close", (code) => done({ code, timedOut, tail }));
  });
}

export function prepare(o: PrepareOptions = {}): (ctx: StepContext) => Promise<PrepareOutput> {
  const appDirOpt = o.appDir ?? ".";
  const setup = o.setup ?? [];
  const baseCheck = o.baseCheck ?? [];
  const setupTimeoutMinutes = o.setupTimeoutMinutes ?? 10;
  return async (ctx) => {
    const d = ctx.job.dispatch;
    git(ctx.dir, ["checkout", "-q", "-B", "job", d.repo.base]);
    git(ctx.dir, ["config", "user.name", "builder"]);
    git(ctx.dir, ["config", "user.email", "builder@gaffer.local"]);
    // Never in the patch: the slice spec written for the agent, installed dependencies, the agent's scratch scripts.
    appendFileSync(join(ctx.dir, ".git", "info", "exclude"), `\n${SLICE_FILE}\nnode_modules/\n.scratch/\n`);

    const appRoot = join(ctx.dir, appDirOpt);
    const short = d.repo.base.slice(0, 12);
    const where = appDirOpt && appDirOpt !== "." ? `${appDirOpt}/` : "";
    if (!existsSync(appRoot)) throw new Error(`target repository is not set up: ${where || "the app directory"} missing at base ${short}`);
    for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
      if (!existsSync(join(appRoot, file))) throw new Error(`target repository is not set up: ${where}${file} missing at base ${short}`);
    }
    ctx.emit("setup.start", `setting up ${where || "."}: ${[...setup, ...baseCheck].join(", ")}`);
    for (const command of [...setup, ...baseCheck]) {
      const res = await runShell(command, appRoot, Math.max(1, setupTimeoutMinutes) * 60_000, ctx);
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (res.code !== 0) {
        const why = res.timedOut ? `timed out after ${setupTimeoutMinutes} min` : `failed`;
        const reason = `target repository is not set up: \`${command}\` ${why} at base ${short}: ${res.tail.trim().slice(-400)}`;
        ctx.emit("setup.fail", reason, { command });
        throw new Error(reason);
      }
    }
    ctx.emit("setup.ok", "dependencies installed and the base builds");

    // The full slice spec (commands, events, readmodels, screens, specifications) as sent by the gaffer, where the
    // agent reads it with a plain relative path (pi's cwd is the app directory). Removed first so a tracked file or
    // symlink of that name is replaced, never written through.
    const sliceFile = join(appRoot, SLICE_FILE);
    rmSync(sliceFile, { force: true });
    writeFileSync(sliceFile, JSON.stringify(d.slice ?? null, null, 2));
    return { appDir: appRoot };
  };
}
