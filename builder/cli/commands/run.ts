/**
 * builder run <target> [options]: start a run and wait for it (run_start, run_wait). An interactive run is pi's TUI in
 * this terminal; rpc and durable runs print their control socket (builder attach). Exits 0 when the run is done, 1 when
 * it fails, 2 on a usage or start error. Ctrl+C stops the run, except in an interactive one, where it belongs to pi.
 */
import { callTool } from "../../ops/core/tool.ts";
import type { RunResult } from "../../runtime/types.ts";
import { cliTools, fail, parse, usage, type Command } from "../common.ts";
import { SPEC_OPTIONS, SPEC_USAGE, specOf } from "../spec.ts";

const run: Command = async (argv, g) => {
  if (g.help) {
    console.log(`usage: builder run ${SPEC_USAGE}`);
    return 0;
  }
  const { values: o, positionals } = parse(argv, SPEC_OPTIONS);
  if (positionals.length !== 1) usage(`usage: builder run ${SPEC_USAGE.split("\n")[0]}`);
  const ctx = cliTools(g);
  const spec = specOf(positionals[0], o);
  let started: { runId: string; dir: string; mode: string; cwd: string | null };
  try {
    started = (await callTool("run_start", spec, ctx)) as typeof started;
  } catch (err) {
    fail(g, err);
    return 2;
  }
  const { runId, dir, mode } = started;
  if (!g.json) console.error(`[builder] run ${runId}: ${spec.agent ? `agent ${spec.agent}` : `workflow ${spec.workflow}`}, ${mode}, in ${started.cwd ?? "?"} (runs/${runId})`);
  if (spec.detach) {
    console.log(g.json ? JSON.stringify({ runId, dir }) : runId);
    return 0;
  }
  // Ctrl+C in an interactive run belongs to pi's TUI; elsewhere it stops the run.
  process.on("SIGINT", () => {
    if (mode !== "interactive") void callTool("run_stop", { run: runId, reason: "stopped from the terminal" }, ctx).catch(() => {});
  });
  if (mode === "rpc" || mode === "durable") {
    const until = Date.now() + 30_000;
    const announce = setInterval(() => {
      const socket = ctx.runtime.get(runId)?.socket;
      if (socket || Date.now() > until) {
        clearInterval(announce);
        if (socket && !g.json) console.error(`[builder] control socket: ${socket} (builder attach ${runId})`);
      }
    }, 200);
  }
  // A run whose agent.yml has api: says where its API listens (runtime/api.ts), not in an interactive run's terminal.
  if (mode !== "interactive" && !g.json) {
    const until = Date.now() + 30_000;
    const announce = setInterval(() => {
      const rec = ctx.runtime.get(runId);
      if (!rec?.resolved?.api || rec.api || Date.now() > until) {
        clearInterval(announce);
        if (rec?.api) console.error(`[builder] api: ${rec.api}`);
      }
    }, 200);
  }
  const { result } = (await callTool("run_wait", { run: runId, timeoutSeconds: 0 }, ctx)) as { result: RunResult };
  if (g.json) console.log(JSON.stringify({ runId, dir, result }, null, 2));
  else if (result.outcome === "done") {
    const output = (result.data as { output?: unknown } | undefined)?.output;
    if (typeof output === "string" && output) console.log(output);
    console.error(`[builder] run ${runId} done`);
  } else console.error(`[builder] run ${runId} failed: ${result.reason}`);
  return result.outcome === "done" ? 0 : 1;
};

export default run;
