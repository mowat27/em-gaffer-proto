/** builder resolve <target> [options]: what a run would load, without starting it (config_resolve). */
import { callTool } from "../../ops/core/tool.ts";
import type { Resolved } from "../../runtime/types.ts";
import { cliTools, out, parse, usage, type Command } from "../common.ts";
import { printResolved, SPEC_OPTIONS, SPEC_USAGE, specOf } from "../spec.ts";

const resolve: Command = async (argv, g) => {
  if (g.help) {
    console.log(`usage: builder resolve ${SPEC_USAGE}`);
    return 0;
  }
  const { values: o, positionals } = parse(argv, SPEC_OPTIONS);
  if (positionals.length !== 1) usage(`usage: builder resolve ${SPEC_USAGE.split("\n")[0]}`);
  const ctx = cliTools(g);
  const r = (await callTool("config_resolve", specOf(positionals[0], o), ctx)) as Resolved;
  out(g, r, printResolved);
  return 0;
};

export default resolve;
