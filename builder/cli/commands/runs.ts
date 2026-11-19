/** builder runs: runs, newest first (run_list). */
import type { RunSummary } from "../../ops/core/common.ts";
import { callTool } from "../../ops/core/tool.ts";
import { clock, cliTools, oneLine, out, parse, table, type Command } from "../common.ts";

const USAGE = "usage: builder runs [--state starting|running|done|failed|stopped|live|ended] [--kind agent|workflow] [--target agent:<id>|workflow:<id>] [--parent <run>] [--job <job>] [--limit n]";

const runs: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  const { values: o } = parse(argv, { state: { type: "string" }, kind: { type: "string" }, target: { type: "string" }, parent: { type: "string" }, job: { type: "string" }, limit: { type: "string" } });
  const args = { ...(o.state ? { state: o.state } : {}), ...(o.kind ? { kind: o.kind } : {}), ...(o.target ? { target: o.target } : {}), ...(o.parent ? { parent: o.parent } : {}), ...(o.job ? { job: o.job } : {}), ...(o.limit ? { limit: Number(o.limit) } : {}) };
  const res = (await callTool("run_list", args, cliTools(g))) as { runsDir: string; total: number; runs: RunSummary[] };
  out(g, res, (r: typeof res) =>
    r.runs.length
      ? table([
          ["run", "target", "state", "step", "started", "job", ""],
          ...r.runs.map((x) => [x.id, x.target, x.state, x.step ?? "", `${x.startedAt.slice(0, 10)} ${clock(x.startedAt)}`, x.job ?? "", x.reason ? oneLine(x.reason, 80) : ""]),
        ]) + (r.total > r.runs.length ? `\n(${r.runs.length} of ${r.total}: --limit for more)` : "")
      : `no runs in ${r.runsDir}`,
  );
  return 0;
};

export default runs;
