/**
 * builder tool <name> [json|-]: call any tool with its arguments as JSON (or JSON on stdin with -). Prints the tool's
 * result as JSON. No gaps on day one: every tool is reachable before it has a short command.
 */
import { readFileSync } from "node:fs";
import { callTool } from "../../ops/core/tool.ts";
import { cliTools, usage, type Command } from "../common.ts";

const USAGE = "usage: builder tool <name> [json|-]   (the arguments as a JSON object, - reads them from stdin)";

const tool: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  const [name, raw, ...extra] = argv;
  if (!name || extra.length) usage(USAGE);
  let args: unknown = {};
  if (raw !== undefined) {
    const text = raw === "-" ? readFileSync(0, "utf8") : raw;
    try {
      args = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      usage(`the arguments are not JSON: ${(err as Error).message}`);
    }
  }
  const result = await callTool(name, args, cliTools(g));
  console.log(g.json ? JSON.stringify(result) : typeof result === "string" ? result : JSON.stringify(result, null, 2));
  return 0;
};

export default tool;
