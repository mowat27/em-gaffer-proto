/**
 * builder server start|stop|restart: the process tools (server_start, server_stop, server_restart). stop and restart
 * drain first (the running job finishes) unless --force (the job is cancelled: cancelled by operator), E19.
 *
 * builder server run: the build server in the foreground, registered as a run of kind server (server/run.ts). This is
 * what systemd's builder-server unit runs, and what server_start detaches on a machine without the unit. It is the
 * one command that is not a tool call: it is the server process. Exit codes: 3 when another server already runs on
 * the runs directory, 1 when it cannot listen; a signal ends it with 0.
 */
import { callTool } from "../../ops/core/tool.ts";
import { execWithRunId, runServer, RUN_ID_FLAG } from "../../server/run.ts";
import { cliConfig, cliTools, out, parse, usage, type Command } from "../common.ts";

const USAGE = `usage: builder server start [--timeout <s>]          start it (systemd's builder-server unit, else a detached run)
       builder server stop [--force] [--timeout <s>]   drain, then stop (--force cancels the running job)
       builder server restart [--force] [--timeout <s>] drain, then restart
       builder server run                               the server in the foreground (for systemd)

--timeout: start, how long to wait for it to listen (default 30 s); stop and restart, how long to wait for the
running job (default the job time limit + 2 min).`;

interface Info {
  via?: string;
  runId?: string;
  pid?: number | null;
  url?: string;
  already?: boolean;
  log?: string;
}

const where = (i: Info) => `${i.url} (${i.via === "systemd" ? "systemd builder-server" : "detached run"}, run ${i.runId}, pid ${i.pid})${i.log ? `\nlog: ${i.log}` : ""}`;

const humanStart = (i: Info) => `${i.already ? "already running" : "started"}: ${where(i)}`;

function humanDrained(d: { answered?: boolean; jobId?: string; cancelled?: boolean } | undefined): string {
  if (!d) return "";
  if (!d.answered) return " (the server did not answer the drain)";
  if (!d.jobId) return "";
  return d.cancelled ? ` (job ${d.jobId} cancelled)` : ` (after job ${d.jobId} finished)`;
}

const server: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  const [sub, ...rest] = argv;
  if (sub === "run") {
    const { values, positionals } = parse(rest, { "run-id": { type: "string" } });
    if (positionals.length) usage(USAGE);
    // No id yet (systemd's ExecStart): take one and put it on the command line, keeping the pid.
    if (!values["run-id"]) execWithRunId();
    if (!/^[\w.-]+$/.test(values["run-id"]!)) usage(`${RUN_ID_FLAG}: not a run id`);
    const cfg = cliConfig(g);
    return runServer({
      runId: values["run-id"]!,
      runsDir: cfg.server.runsDir,
      ...(cfg.loadOptions.configPath ? { configPath: cfg.loadOptions.configPath } : {}),
      ...(cfg.instance ? { instance: cfg.instance } : {}),
    });
  }
  if (sub !== "start" && sub !== "stop" && sub !== "restart") return usage(USAGE);
  const { values, positionals } = parse(rest, { force: { type: "boolean" }, timeout: { type: "string" } });
  if (positionals.length) usage(USAGE);
  if (sub === "start" && values.force) usage("builder server start has no --force");
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 0)) usage(`--timeout ${values.timeout}: whole seconds`);
  const ctx = cliTools(g);
  const args = { ...(values.force ? { force: true } : {}), ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}) };
  if (sub === "start") {
    out(g, await callTool("server_start", args, ctx), humanStart);
    return 0;
  }
  if (sub === "stop") {
    const r = (await callTool("server_stop", args, ctx)) as { stopped: string[]; wasRunning: boolean; drained?: Parameters<typeof humanDrained>[0] };
    out(g, r, (x: typeof r) => (x.wasRunning ? `stopped${humanDrained(x.drained)}: server run ${x.stopped.join(", ")}` : "the build server was not running"));
    return 0;
  }
  const r = (await callTool("server_restart", args, ctx)) as Info & { restarted: boolean; drained?: Parameters<typeof humanDrained>[0] };
  out(g, r, (x: typeof r) => (x.restarted ? `restarted${humanDrained(x.drained)}: ${where(x)}` : `was not running, started: ${where(x)}`));
  return 0;
};

export default server;
