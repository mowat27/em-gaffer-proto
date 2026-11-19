/**
 * builder agent new <path> [--template <t>] [--description <text>]: a new agent at agentics/agents/<path>/ from a
 * template in agentics/shared/agent-templates/ (agent_create): agent.yml, SYSTEM.md and prompts/, validated before
 * they are written. Then `builder run <path>` starts it.
 */
import { callTool } from "../../ops/core/tool.ts";
import { cliTools, out, parse, usage, type Command } from "../common.ts";

const USAGE = `usage: builder agent new <path> [--template <t>] [--description <text>]

  <path>             the agent's id: its path under agentics/agents/, e.g. dev/my-agent
  -t, --template     a folder in agentics/shared/agent-templates/ (default basic; builder tool agent_list lists them)
  -d, --description  the agent.yml description`;

interface Created {
  id: string;
  path: string;
  template: string;
  version: string;
  files: string[];
  proposed?: boolean;
  changeset?: string;
  warnings?: string[];
}

const agent: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  const { values, positionals } = parse(argv, { template: { type: "string", short: "t" }, description: { type: "string", short: "d" } });
  const [sub, path, ...extra] = positionals;
  if (sub !== "new" || !path || extra.length) usage(USAGE);
  const result = (await callTool("agent_create", { path, ...(values.template ? { template: values.template } : {}), ...(values.description ? { description: values.description } : {}) }, cliTools(g))) as Created;
  out(g, result, (r: Created) =>
    r.proposed
      ? `proposed agent ${r.id}: change set ${r.changeset} (builder tool changeset_apply '{"id":"${r.changeset}"}')`
      : [`created agent ${r.id} from template ${r.template} (version ${r.version.slice(0, 12)})`, `  ${r.path}`, ...r.files.map((f) => `    ${f}`), ...(r.warnings ?? []).map((w) => `  warning: ${w}`), `run it: builder run ${r.id}`].join("\n"),
  );
  return 0;
};

export default agent;
