#!/usr/bin/env node
/**
 * The builder CLI (design section 9, D21): a thin wrapper over the tool core. Every command is a call to an ops/core
 * tool (through callTool, with the machine limit as what it may call) except `attach` (a socket relay), `events` (it
 * reads the machine feed) and `server run` (the server process). It adds no behaviour of its own.
 *
 *   node builder/cli/builder.ts <command> [args] [--config <path>] [--instance <id>] [--json]
 *
 * One file per command in cli/commands/, loaded only when it runs. Global flags stand anywhere:
 *   --config <path>    a machine config layer on top of the others, for this command and every run it starts
 *   --instance <id>    the instance whose instances.<id> section applies (also $GAFFER_INSTANCE)
 *   --json             print JSON: one document, or one line per event for `events` and `logs -f`
 *
 * Exit codes (cli/common.ts): 0 ok, 1 failed, 2 usage or invalid, 3 refused, 4 not available yet.
 */
import { fail, splitGlobals, UsageError, type Command } from "./common.ts";

const COMMANDS: Record<string, string> = {
  tool: "tool <name> [json|-]           call any tool (builder tools lists them)",
  tools: "tools [--all] [--group g]      the tools this machine allows",
  run: "run <agent|workflow> [opts]    start a run and wait for it (run_start, run_wait)",
  resolve: "resolve <agent|workflow> [opts] what a run would load (config_resolve)",
  runs: "runs [--state s] [--limit n]   runs, newest first (run_list)",
  logs: "logs <run> [-f] [--limit n]    a run's journal, or its log (journal_tail)",
  attach: "attach <run>                   follow an rpc run and send it messages",
  events: "events [--since x] [-f]        the machine feed (runs/index.jsonl)",
  config: "config | config reload         the merged config and its layers (instance_get), reload (config_reload)",
  server: "server start|stop|restart|run  the build server",
  agent: "agent new <path> [--template t] a new agent (agent_create)",
};

const USAGE = `usage: builder <command> [args] [--config <path>] [--instance <id>] [--json]

${Object.values(COMMANDS)
  .map((c) => `  ${c}`)
  .join("\n")}

builder <command> --help shows a command's options.`;

const { globals, rest } = (() => {
  try {
    return splitGlobals(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return process.exit(2);
  }
})();
const [name, ...args] = rest;

if (!name) {
  console.log(USAGE);
  process.exit(globals.help ? 0 : 2);
}
if (!(name in COMMANDS)) {
  process.exit(fail(globals, new UsageError(`unknown command ${name}\n${USAGE}`)));
}

let code: number;
try {
  const command = ((await import(`./commands/${name}.ts`)) as { default: Command }).default;
  code = await command(args, globals);
} catch (err) {
  code = fail(globals, err);
}
// Writes to a pipe are asynchronous: exiting at once would cut a large answer (the TSF reads run_story through a pipe)
// at 64 KB. An empty write's callback runs once everything written before it is out.
await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((r) => (s.writable ? s.write("", () => r()) : r()))));
process.exit(code);
