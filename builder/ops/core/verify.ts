/**
 * verify: the verifier's verdict on a slice build (design section 9, the verify group). One implementation for every
 * caller: the `verify` tool (any agent, the CLI, the API), the verified workflow's verify step
 * (engine/steps/verify.ts) and the verifier agent's try_rules.
 *
 * `verify(workspace, slice?, base?)` runs the verifier agent's run.ts (agentics/agents/verifier/run.ts) in a fresh
 * process, so its current checks.ts always applies: a rule change reaches the next verification at once. The verifier
 * compares the workspace with `base` by content hash (the files the build changed), runs its code checks and asks Jev
 * for the judgments; the verdict passes only when no finding fails and none is unsure. It reads TYPESAFE_API_KEY from
 * the environment the caller runs in. Nothing is recorded: the caller keeps the verdict (the workflow step stores it
 * as verify.json in the context store; an agent's call is in its journal).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { Verdict } from "../../agentics/agents/verifier/changes.ts";
import { agentDir, specPath } from "../../runtime/paths.ts";
import { AGENTICS_DIR } from "../../runtime/root.ts";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

/** The agent whose run.ts and checks.ts judge a build. */
export const VERIFIER = "verifier";

export interface VerifyOptions {
  /** The agent tree the verifier is in (default the builder's agentics/). */
  agentics?: string;
  /** Stops the verifier process. */
  signal?: AbortSignal;
  /** The verifier process is killed after this long (default 10 min). */
  timeoutMs?: number;
}

/** A verdict with the build it judged. */
export interface VerifyResult extends Verdict {
  /** The workspace (app directory) verified, absolute. */
  workspace: string;
  /** The slice or dispatch file the build was judged against, absolute. */
  slice: string;
  /** The commit the changes are measured from. */
  base: string;
  ms: number;
}

/** run.ts of the verifier agent. Throws when the tree has no verifier. */
export function verifierRun(agentics = AGENTICS_DIR): string {
  const run = join(agentDir(VERIFIER, agentics), "run.ts");
  if (!existsSync(run)) throw new Error(`the verifier agent has no run.ts (${run})`);
  return run;
}

/** Run the verifier's run.ts with `args` in a fresh process and parse the JSON it prints. */
function runVerifier<T>(args: string[], o: VerifyOptions): Promise<T> {
  const run = verifierRun(o.agentics);
  return new Promise((res, rej) => {
    execFile(
      process.execPath,
      [run, ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: o.timeoutMs ?? 600_000, ...(o.signal ? { signal: o.signal } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const why = (err as NodeJS.ErrnoException).code === "ABORT_ERR" ? "stopped" : (stderr || err.message).trim().slice(-800);
          return rej(new Error(`the verifier failed: ${why}`));
        }
        try {
          res(JSON.parse(stdout) as T);
        } catch {
          rej(new Error(`the verifier printed no JSON: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

/**
 * Verify the build in `workspace`: the files it changed since `base` (default HEAD, a build that is not committed),
 * against the slice in `slice` (a slice or dispatch file; default the workspace's .slice.json). Paths are absolute.
 */
export async function verify(workspace: string, slice?: string, base?: string, o: VerifyOptions = {}): Promise<VerifyResult> {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`workspace ${workspace} is not a directory`);
  const sliceFile = slice ?? join(workspace, ".slice.json");
  if (!existsSync(sliceFile)) throw new Error(`no slice to verify against: ${sliceFile} does not exist (name a slice or dispatch file)`);
  const b = base || "HEAD";
  const started = Date.now();
  const verdict = await runVerifier<Verdict>(["--workspace", workspace, "--slice", sliceFile, "--base", b], o);
  if (!verdict || (verdict.verdict !== "pass" && verdict.verdict !== "fail") || !Array.isArray(verdict.findings)) {
    throw new Error(`the verifier returned no verdict: ${JSON.stringify(verdict).slice(0, 200)}`);
  }
  return { workspace, slice: sliceFile, base: b, ...verdict, ms: Date.now() - started };
}

/** The rules the verifier applies (RULES in its checks.ts), read in a fresh process like a verification. */
export function verifierRules(o: VerifyOptions = {}): Promise<{ id: string; kind: string; rule: string }[]> {
  return runVerifier(["--list"], o);
}

/**
 * A path a caller names: `area:` (the calling run's areas), `data:` (its agent's data/ folders, then shared), `~`, or
 * relative to the calling run's working directory (the process's for the CLI).
 */
function callerPath(ctx: ToolContext, p: string): string {
  const rec = ctx.caller.runId ? ctx.runtime.get(ctx.caller.runId) : null;
  const r = rec?.resolved;
  try {
    return specPath(p, {
      areas: r?.areas ?? {},
      owner: rec?.spec.agent ? `agent ${rec.spec.agent}` : ctx.caller.kind === "cli" ? "the CLI" : "the caller",
      ...(r?.agent?.dir ? { agentDir: r.agent.dir } : {}),
      agentics: ctx.runtime.options.agenticsDir ?? AGENTICS_DIR,
      cwd: r?.cwd ?? process.cwd(),
    });
  } catch (err) {
    throw new ToolError("invalid", (err as Error).message);
  }
}

const verifyTool = defineTool({
  name: "verify",
  group: "verify",
  description:
    "Verify a slice build with the verifier's current rules: the files the workspace changed since its base commit, judged by code checks and Jev against the slice. Returns the verdict (pass only when no finding fails and none is unsure), its summary and every finding.",
  params: Type.Object(
    {
      workspace: Type.String({ description: "The workspace (app directory) the build changed: absolute, relative to your working directory, area: or data:" }),
      slice: Type.Optional(Type.String({ description: "The slice: a slice or dispatch JSON file, or a data: path. Default: the workspace's .slice.json" })),
      base: Type.Optional(Type.String({ description: "The commit the build started from. Default: HEAD (a build that is not committed)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { workspace: string; slice?: string; base?: string }, ctx: ToolContext) => {
    const workspace = callerPath(ctx, a.workspace);
    const slice = a.slice ? callerPath(ctx, a.slice) : undefined;
    return verify(workspace, slice, a.base, { agentics: ctx.runtime.options.agenticsDir ?? AGENTICS_DIR });
  },
});

export const tools: ToolDef[] = [verifyTool];
