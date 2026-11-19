/**
 * process: the build server as a process (design section 10, D13, E19). The adapter (ops/process.ts) decides how:
 * systemctl on the builder-server unit when this machine has it, else a detached `builder server run`. The server is
 * found again through runs/ (server/run.ts), so these tools work the same from any agent, the CLI or the API.
 *
 *   server_start          start it, unless one already runs on this runs directory; wait until it listens
 *   server_stop           drain first: the running job finishes (the server refuses new ones meanwhile), then stop.
 *                         force: the job is cancelled (its callback says cancelled by operator), then stop
 *   server_restart        the same, then start. Not running: it starts
 *   server_settings_get   the merged server section of the machine config, and the layer of each value
 *
 * Draining goes through the server's control inbox (server/control.ts), and the end of the job is read from the
 * machine feed (server.state draining with no job). A job that does not finish in time is left running: the server
 * is resumed and the tool fails, so nothing is stopped half-way (G7). Stop drains as restart does (E19), so no tool
 * abandons a job; `systemctl stop builder-server` still can, and the next start fails such a job (E13).
 *
 * No tool writes any config layer: only the operator changes server settings (D13, G6).
 */
import { userInfo } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { readFeed } from "../../runtime/feed.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { controlDir, readOutbox, withdrawControl, writeControl, type ControlMessage, type ControlRecord } from "../../server/control.ts";
import { liveServerRuns } from "../../server/run.ts";
import { publicConfig } from "../config.ts";
import { startDetached, systemctl, UNIT, unitState, waitForServer, waitGone, type UnitState } from "../process.ts";
import { runsDirOf } from "./common.ts";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long a start waits for the server to listen. */
const START_WAIT_SECONDS = 30;

/** Who asked, as the control inbox, the outbox and the stop reason record it. */
function who(ctx: ToolContext, tool: string): string {
  const c = ctx.caller;
  if (c.kind === "agent") return `${tool} from agent ${c.agent ?? "?"} (run ${c.runId ?? "?"})`;
  if (c.kind === "api") return `${tool} from the api${c.runId ? ` of run ${c.runId}` : ""}`;
  let user = "";
  try {
    user = ` (${userInfo().username})`;
  } catch {
    /* no user name */
  }
  return `${tool} from the cli${user}`;
}

interface Status {
  runsDir: string;
  /** The builder-server unit, when this machine has it. */
  unit: UnitState | null;
  /** Live server runs on the runs directory, oldest first. */
  runs: RunRecord[];
}

function status(ctx: ToolContext): Status {
  const runsDir = runsDirOf(ctx);
  return { runsDir, unit: unitState(), runs: liveServerRuns(runsDir) };
}

const isRunning = (s: Status) => !!s.unit?.active || s.runs.length > 0;
const urlOf = (ctx: ToolContext) => `http://${ctx.config.server.host}:${ctx.config.server.port}`;

export interface ServerInfo {
  /** systemd: the builder-server unit; run: a detached server run. */
  via: "systemd" | "run";
  runId: string;
  pid: number | null;
  url: string;
  /** It was running already: nothing was started. */
  already?: boolean;
  /** A detached server's output. */
  log?: string;
}

function infoOf(ctx: ToolContext, s: Status, r: RunRecord, already: boolean): ServerInfo {
  const viaSystemd = !!s.unit && (s.unit.pid === r.pid || !r.spec.detach);
  return {
    via: viaSystemd ? "systemd" : "run",
    runId: r.id,
    pid: r.pid,
    url: urlOf(ctx),
    ...(already ? { already: true } : {}),
    ...(viaSystemd ? {} : { log: join(s.runsDir, r.id, "log") }),
  };
}

async function start(ctx: ToolContext, waitSeconds: number): Promise<ServerInfo> {
  const s = status(ctx);
  const up = s.runs.filter((r) => r.state === "running");
  if (up.length) return infoOf(ctx, s, up[up.length - 1], true);
  const ms = waitSeconds * 1000;
  if (s.unit) {
    if (!s.unit.active) {
      try {
        systemctl("start");
      } catch (err) {
        throw new ToolError("failed", (err as Error).message);
      }
    }
    try {
      return infoOf(ctx, { ...s, unit: unitState() }, await waitForServer(s.runsDir, ms), !!s.unit.active);
    } catch (err) {
      throw new ToolError("failed", `${(err as Error).message}: ${UNIT} is ${unitState()?.state ?? "gone"} (journalctl -u builder-server; is its machine config's server.runsDir ${s.runsDir}?)`);
    }
  }
  // A server run that is starting (another start a moment ago): wait for it rather than start a second one.
  const starting = s.runs[s.runs.length - 1];
  const rec = starting ?? startDetached({ runsDir: s.runsDir, ...(ctx.config.loadOptions.configPath ? { configPath: ctx.config.loadOptions.configPath } : {}), instance: ctx.config.instance });
  try {
    return infoOf(ctx, s, await waitForServer(s.runsDir, ms, { runId: rec.id }), !!starting);
  } catch (err) {
    throw new ToolError("failed", (err as Error).message);
  }
}

/** Send a control message and wait for the server's answer; null when no server took it (it is withdrawn). */
async function ask(runsDir: string, msg: ControlMessage, waitMs: number): Promise<ControlRecord | null> {
  const dir = controlDir(runsDir);
  const { id } = writeControl(dir, msg);
  const until = Date.now() + waitMs;
  for (;;) {
    const done = readOutbox(dir, id);
    if (done) return done;
    if (Date.now() >= until) break;
    await sleep(100);
  }
  if (withdrawControl(dir, id)) return null;
  // A server claimed it just now: its answer is on the way.
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const done = readOutbox(dir, id);
    if (done) return done;
    await sleep(100);
  }
  return null;
}

export interface Drained {
  /** The server answered the drain (false only with force, when it did not). */
  answered: boolean;
  /** The job that was running when the drain arrived. */
  jobId?: string;
  /** force: the job was cancelled (its callback says cancelled by operator). */
  cancelled?: boolean;
}

/**
 * E19: let the running job finish (or cancel it with force) before the server stops. Throws, with the server resumed,
 * when the job does not finish within `waitMs`.
 */
async function drain(ctx: ToolContext, s: Status, verb: "stop" | "restart", force: boolean, waitMs: number): Promise<Drained> {
  const by = who(ctx, `server_${verb}`);
  const from = readFeed(s.runsDir, { last: 1 })[0]?.seq ?? 0;
  const drained = await ask(s.runsDir, { action: "drain", by }, 5000);
  if (!drained) {
    if (force) return { answered: false };
    throw new ToolError("failed", `the build server did not answer a drain within 5 s, so it was not ${verb === "stop" ? "stopped" : "restarted"} (force does it anyway: a job it is running then fails at its next start, builder restarted during <step>)`);
  }
  const jobId = drained.result.jobId;
  if (!jobId) return { answered: true };
  let cancelled = false;
  if (force) cancelled = !!(await ask(s.runsDir, { action: "cancel", jobId, by }, 10_000))?.result.ok;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const idle = readFeed(s.runsDir, { kind: "server.state", since: { seq: from } }).some((e) => e.data.state === "draining" && !e.data.jobId);
    if (idle || !isRunning(status(ctx))) return { answered: true, jobId, ...(force ? { cancelled } : {}) };
    await sleep(500);
  }
  await ask(s.runsDir, { action: "resume", by }, 5000);
  throw new ToolError(
    "failed",
    `job ${jobId} did not finish within ${Math.round(waitMs / 1000)} s, so the build server was resumed and not ${verb === "stop" ? "stopped" : "restarted"} (force cancels the job: its callback says cancelled by operator)`,
  );
}

/** Stop the unit and every live server run. Returns the server runs that ended. */
async function stopAll(ctx: ToolContext, s: Status, reason: string): Promise<string[]> {
  const ids = s.runs.map((r) => r.id);
  if (s.unit?.active) {
    try {
      systemctl("stop");
    } catch (err) {
      throw new ToolError("failed", (err as Error).message);
    }
  }
  for (const r of liveServerRuns(s.runsDir)) {
    if (!ids.includes(r.id)) ids.push(r.id);
    await ctx.runtime.stop(r.id, reason);
  }
  if (!(await waitGone(s.runsDir, ids, 15_000))) throw new ToolError("failed", `the build server did not stop within 15 s (server runs ${ids.join(", ")})`);
  return ids;
}

const Wait = (what: string) => Type.Optional(Type.Integer({ minimum: 0, maximum: 7200, description: what }));
const jobWait = (ctx: ToolContext, a: { timeoutSeconds?: number }) => (a.timeoutSeconds ?? (ctx.config.server.jobTimeoutMinutes + 2) * 60) * 1000;

const serverStart = defineTool({
  name: "server_start",
  group: "process",
  description:
    "Start the build server: the builder-server systemd unit when this machine has it, else a detached `builder server run` that outlives the caller. It runs with the machine config's server settings (server_settings_get). Waits until it listens; a server already running is left as it is (already: true).",
  params: Type.Object({ timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: `How long to wait for it to listen (default ${START_WAIT_SECONDS})` })) }, { additionalProperties: false }),
  run: async (a: { timeoutSeconds?: number }, ctx: ToolContext) => start(ctx, a.timeoutSeconds ?? START_WAIT_SECONDS),
});

const serverStop = defineTool({
  name: "server_stop",
  group: "process",
  description:
    "Stop the build server. It drains first: a running job finishes (new dispatches get 503) and then the server stops. force: the running job is cancelled instead (the gaffer is told cancelled by operator). A job that does not finish within timeoutSeconds is left running and the server resumed.",
  params: Type.Object(
    { force: Type.Optional(Type.Boolean({ description: "Cancel the running job instead of waiting for it" })), timeoutSeconds: Wait("How long to wait for the running job (default: the job time limit + 2 min)") },
    { additionalProperties: false },
  ),
  run: async (a: { force?: boolean; timeoutSeconds?: number }, ctx: ToolContext) => {
    const s = status(ctx);
    if (!isRunning(s)) return { stopped: [], wasRunning: false, via: s.unit ? "systemd" : "run" };
    const drained = await drain(ctx, s, "stop", !!a.force, jobWait(ctx, a));
    const stopped = await stopAll(ctx, s, `stopped by ${who(ctx, "server_stop")}`);
    return { stopped, wasRunning: true, via: s.unit?.active ? "systemd" : "run", drained };
  },
});

const serverRestart = defineTool({
  name: "server_restart",
  group: "process",
  description:
    "Restart the build server (it reads the machine config again). It drains first: a running job finishes, then the server restarts. force: the running job is cancelled first (the gaffer is told cancelled by operator). A job that does not finish within timeoutSeconds is left running and the server resumed. A server that is not running is started.",
  params: Type.Object(
    { force: Type.Optional(Type.Boolean({ description: "Cancel the running job instead of waiting for it" })), timeoutSeconds: Wait("How long to wait for the running job (default: the job time limit + 2 min)") },
    { additionalProperties: false },
  ),
  run: async (a: { force?: boolean; timeoutSeconds?: number }, ctx: ToolContext) => {
    const s = status(ctx);
    if (!isRunning(s)) return { restarted: false, wasRunning: false, ...(await start(ctx, START_WAIT_SECONDS)) };
    const drained = await drain(ctx, s, "restart", !!a.force, jobWait(ctx, a));
    const stopped = await stopAll(ctx, s, `restarted by ${who(ctx, "server_restart")}`);
    return { restarted: true, wasRunning: true, stopped, drained, ...(await start(ctx, START_WAIT_SECONDS)) };
  },
});

const serverSettingsGet = defineTool({
  name: "server_settings_get",
  group: "process",
  description:
    "The build server's settings: the merged server section of the machine config (host, port, jobTimeoutMinutes, callbackRetries, keepWorkspaces, builder, runsDir), the layer each value came from, and whether systemd runs the server here. Read only: the operator changes them by editing a config layer.",
  params: Type.Object({}, { additionalProperties: false }),
  run: async (_a: Record<string, never>, ctx: ToolContext) => {
    const sources: Record<string, string> = {};
    for (const [k, layer] of Object.entries(ctx.config.sources)) if (k.startsWith("server.")) sources[k] = layer;
    return { server: publicConfig(ctx.config).server, sources, layers: ctx.config.layers, unit: unitState() ? UNIT : null };
  },
});

export const tools: ToolDef[] = [serverStart, serverStop, serverRestart, serverSettingsGet];
