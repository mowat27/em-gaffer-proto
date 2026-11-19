/**
 * builder attach <run>: follow an rpc or durable run in this terminal and send it input. It follows over the run's
 * control socket (a relay, not a tool: the assistant's text streams as it comes, with tool calls and settles marked;
 * --json prints pi's raw lines). A line you type is a message sent with run_send (journaled, and queued as a follow-up
 * while a turn runs); a line starting with { is sent to pi as an rpc command as it is. Ctrl+C or end of input detaches;
 * the run keeps going.
 */
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { callTool } from "../../ops/core/tool.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { cliTools, oneLine, usage, type Command } from "../common.ts";

const USAGE = "usage: builder attach <run>   (an rpc or durable run)";

type Rec = Record<string, unknown>;

/** What a line from pi shows in the terminal, or null to show nothing. */
function render(e: Rec): string | null {
  switch (e.type) {
    case "message_update": {
      const u = (e.assistantMessageEvent ?? {}) as Rec;
      return u.type === "text_delta" && typeof u.delta === "string" ? u.delta : null;
    }
    case "tool_execution_start":
      return `\n[tool ${String(e.toolName)}] ${oneLine(JSON.stringify(e.args ?? {}), 120)}\n`;
    case "tool_execution_end":
      return `[tool ${String(e.toolName)} ${e.isError ? "error" : "done"}]\n`;
    case "agent_settled":
      return "\n[settled]\n> ";
    case "response":
      return e.success === false ? `\n[error] ${String(e.command)}: ${String(e.error ?? "failed")}\n` : null;
    default:
      return null;
  }
}

const attach: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length !== 1) usage(USAGE);
  const ctx = cliTools(g);
  const rec = (await callTool("run_get", { run: argv[0] }, ctx)) as RunRecord & { alive: boolean };
  if (!rec.socket || !rec.alive) usage(`run ${rec.id} has no control socket to attach to: it is ${rec.state}, mode ${rec.resolved?.mode ?? "?"} (only live rpc and durable runs have one)`);
  const sock = connect(rec.socket);
  await new Promise<void>((ok, bad) => sock.once("connect", () => ok()).once("error", bad));
  if (!g.json) process.stderr.write(`[builder] attached to run ${rec.id} (${rec.resolved?.mode}); Ctrl+C detaches\n> `);
  let buf = "";
  sock.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (g.json) {
        console.log(line);
        continue;
      }
      try {
        const shown = render(JSON.parse(line) as Rec);
        if (shown) process.stdout.write(shown);
      } catch {
        /* not JSON: pi's stderr is in the run's log */
      }
    }
  });
  const input = createInterface({ input: process.stdin });
  // Messages one at a time, in the order typed.
  let sending: Promise<unknown> = Promise.resolve();
  input.on("line", (line) => {
    if (!line.trim()) return;
    if (line.trim().startsWith("{")) return void sock.write(`${line.trim()}\n`);
    sending = sending.then(() =>
      callTool("run_send", { target: rec.id, message: line }, ctx).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (g.json) console.log(JSON.stringify({ error: { code: (err as { code?: string }).code ?? "error", message } }));
        else process.stderr.write(`\n[builder] not sent: ${message}\n> `);
      }),
    );
  });
  await new Promise<void>((done) => {
    sock.once("close", () => done());
    input.once("close", () => done());
    process.once("SIGINT", () => done());
  });
  await sending;
  input.close();
  sock.destroy();
  if (!g.json) process.stderr.write(`\n[builder] detached from run ${rec.id}\n`);
  return 0;
};

export default attach;
