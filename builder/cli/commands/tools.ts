/** builder tools [--all] [--group <g>]: the tools this machine's limit allows (all of them with --all), by group. */
import { listTools } from "../../ops/core/tool.ts";
import { cliTools, oneLine, out, parse, table, type Command } from "../common.ts";

const tools: Command = async (argv, g) => {
  if (g.help) {
    console.log("usage: builder tools [--all] [--group <group>]   --all includes tools outside the machine limit");
    return 0;
  }
  const { values: o } = parse(argv, { all: { type: "boolean" }, group: { type: "string" } });
  const ctx = cliTools(g);
  const list = listTools(o.all ? undefined : ctx)
    .filter((t) => !o.group || t.group === o.group)
    .map((t) => ({ ...t, allowed: ctx.caller.allowed.has(t.name) }));
  out(g, list, (l: typeof list) =>
    l.length
      ? table([["tool", "group", "description"], ...l.map((t) => [t.name, t.group, `${t.available ? "" : "(not available yet) "}${o.all && !t.allowed ? "(outside the limit) " : ""}${oneLine(t.description, 110)}`])])
      : "no tools: the machine limit allows none",
  );
  return 0;
};

export default tools;
