/**
 * operate: steer the running builder without connecting to it (D9).
 *
 *   control_send   drain, resume or cancel through the server's control inbox (server/control.ts, E14), and wait a
 *                  few seconds for the server's answer in the outbox. With no answer the message is withdrawn, so a
 *                  server started later never applies a stale one.
 *   config_reload  read the machine config layers again (with the options this process loaded them with). A broken
 *                  layer changes nothing: everything keeps the config it has (E22) and the feed records the error.
 *                  Otherwise every live run is told: its runs/<id>/config.json gets the new limit, which its runtime
 *                  uses for the children it starts and ops/pi-extension.ts applies to its tools at the next turn.
 *                  A live run's tools only narrow: it keeps at most what it resolved at start (G6, D10).
 *   runs_prune     apply the retention period now (runtime/retention.ts): delete the run trees that ended more than
 *                  server.retentionDays ago, old folders without a run record and old snapshots, and blank the
 *                  expired feed lines. dryRun reports what would go. Live runs are never touched. The build server
 *                  does the same at start, after every job and every hour.
 */
import { userInfo } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { appendFeed } from "../../runtime/feed.ts";
import { pruneExpired } from "../../runtime/retention.ts";
import { RUN_CONFIG_FILE, writeAtomic, type RunConfig } from "../../runtime/run.ts";
import { isFinal } from "../../runtime/types.ts";
import { CONTROL_ACTIONS, controlDir, readOutbox, withdrawControl, writeControl, type ControlAction } from "../../server/control.ts";
import { loadConfig } from "../config.ts";
import { toolsOf } from "../groups.ts";
import { runsDirOf } from "./common.ts";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Who sent a control message, as the outbox and the feed record it. */
function sender(ctx: ToolContext): string {
  const c = ctx.caller;
  if (c.kind === "agent") return `agent ${c.agent ?? "?"} (run ${c.runId ?? "?"})`;
  if (c.kind === "api") return `api${c.runId ? ` (run ${c.runId})` : ""}`;
  try {
    return `cli (${userInfo().username})`;
  } catch {
    return "cli";
  }
}

const controlSend = defineTool({
  name: "control_send",
  group: "operate",
  description:
    "Tell the build server to drain (finish the running job, then refuse new ones with 503 until resumed), resume, or cancel the running job (it fails with cancelled by operator). Waits up to waitSeconds (default 5) for the server's answer; without one the message is withdrawn.",
  params: Type.Object(
    {
      action: Type.Union(CONTROL_ACTIONS.map((x) => Type.Literal(x))),
      jobId: Type.Optional(Type.String({ description: "cancel: the job (default: the running one)" })),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 120, description: "0: leave it in the inbox for the next poll and return at once" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { action: ControlAction; jobId?: string; waitSeconds?: number }, ctx: ToolContext) => {
    const dir = controlDir(runsDirOf(ctx));
    const { id, file } = writeControl(dir, { action: a.action, ...(a.jobId ? { jobId: a.jobId } : {}), by: sender(ctx) });
    const wait = a.waitSeconds ?? 5;
    if (wait === 0) return { id, queued: true, inbox: file };
    const until = Date.now() + wait * 1000;
    for (;;) {
      const done = readOutbox(dir, id);
      if (done) return done;
      if (Date.now() >= until) break;
      await sleep(100);
    }
    if (withdrawControl(dir, id)) throw new ToolError("failed", `no build server took the ${a.action} within ${wait} s (is one running on ${runsDirOf(ctx)}?): the message was withdrawn`);
    // A server claimed it just now: its answer is on the way.
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const done = readOutbox(dir, id);
      if (done) return done;
      await sleep(100);
    }
    throw new ToolError("failed", `the build server took the ${a.action} (${id}) but has not answered yet: see ${join(dir, "outbox")}`);
  },
});

const configReload = defineTool({
  name: "config_reload",
  group: "operate",
  description:
    "Read the machine config layers again after an operator edited one. A broken layer changes nothing (the previous config stays in force) and the error is returned. Otherwise every live run is told: running agents get their new tools at their next turn (only ever fewer than they started with).",
  params: Type.Object({}, { additionalProperties: false }),
  run: async (_a: Record<string, never>, ctx: ToolContext) => {
    const runsDir = runsDirOf(ctx);
    let next;
    try {
      next = loadConfig(ctx.config.loadOptions);
    } catch (err) {
      const error = (err as Error).message;
      appendFeed(runsDir, { kind: "config.loaded", data: { ok: false, error, kept: ctx.config.layers } });
      throw new ToolError("failed", `${error} (nothing changed: the previous config stays in force)`);
    }
    const told: string[] = [];
    const runConfig: RunConfig = { loadedAt: new Date().toISOString(), layers: next.layers, instance: next.instance, limit: next.limit };
    for (const r of ctx.runtime.list()) {
      if (isFinal(r.state)) continue;
      try {
        writeAtomic(join(ctx.runtime.dir(r.id), RUN_CONFIG_FILE), JSON.stringify(runConfig, null, 2) + "\n");
        told.push(r.id);
      } catch {
        /* its folder is gone: it has ended */
      }
    }
    // The process serving these tools uses the new config from now on (an api run, for one).
    Object.assign(ctx.config, next);
    appendFeed(runsDir, { kind: "config.loaded", data: { ok: true, layers: next.layers, instance: next.instance, limit: next.limit, runs: told } });
    return { loaded: true, layers: next.layers, instance: next.instance, limit: next.limit, tools: toolsOf(next.limit).length, runs: told };
  },
});

const runsPrune = defineTool({
  name: "runs_prune",
  group: "operate",
  description:
    "Apply the retention period now: delete run trees that ended more than server.retentionDays ago (default 30) with everything in their folders, old folders without a run record and old snapshots, and blank the machine feed's expired lines. Workspaces are kept for the newest jobs only (server.keepWorkspaces), after every job. Live runs are never touched. dryRun: only report what would go.",
  params: Type.Object(
    {
      dryRun: Type.Optional(Type.Boolean({ description: "Report only, delete nothing" })),
      days: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Days to keep instead of server.retentionDays" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { dryRun?: boolean; days?: number }, ctx: ToolContext) => {
    const days = a.days ?? ctx.config.server.retentionDays;
    if (!(days > 0)) return { days, kept: "server.retentionDays is 0: run data is kept for ever" };
    const r = await pruneExpired(runsDirOf(ctx), { days, ...(a.dryRun ? { dryRun: true } : {}) });
    return { days, ...r };
  },
});

export const tools: ToolDef[] = [controlSend, configReload, runsPrune];
