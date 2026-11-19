/**
 * messaging (design section 9, D20): talking to a live run, the way the dev bus did and in production too. A target is
 * a run id or a run `name` (from its spec; at most one live run has a given name).
 *
 *   run_send       a user message to a live rpc or durable run, never one inside a server job (runtime/messaging.ts
 *                  has the rule and the wire). It starts a turn there, or is queued as a follow-up while one runs. The
 *                  sender's journal gets message.sent, the target's message.received.
 *   run_subscribe  a run's journal events after a cursor, filtered by kind prefixes, and the next cursor. Polling, so
 *                  it works the same through every adapter (pi, the CLI, the api); waitSeconds holds the call until
 *                  something comes or the run ends.
 */
import { Type } from "typebox";
import { readJournal, type JournalEvent } from "../../runtime/journal.ts";
import { journalSend } from "../../runtime/journal-client.ts";
import { MessageError, messageRefusal, newMessageId, sendMessage } from "../../runtime/messaging.ts";
import { isFinal, type RunRecord } from "../../runtime/types.ts";
import { findRun } from "./common.ts";
import { defineTool, ToolError, type ToolContext, type ToolDef } from "./tool.ts";

const Target = Type.String({ minLength: 1, description: "A run id or a run name (the name in its spec)" });

/**
 * A target: the live run with that name, else (unless `live`) the newest ended run with it, else a run by id, job,
 * latest or self (findRun).
 */
export function findTarget(ctx: ToolContext, target: string, o: { live: boolean }): RunRecord {
  const name = target.trim();
  const named = ctx.runtime.list().filter((r) => r.spec.name === name);
  const live = named.filter((r) => !isFinal(r.state));
  if (live.length > 1) throw new ToolError("invalid", `${live.length} live runs are named ${name}: ${live.map((r) => r.id).join(", ")} (use a run id)`);
  if (live.length === 1) return live[0];
  if (named.length && !o.live) return named[named.length - 1];
  try {
    return findRun(ctx, name);
  } catch (err) {
    if (named.length) throw new ToolError("failed", `the run named ${name} has ended (${named[named.length - 1].id})`);
    throw err;
  }
}

const runSend = defineTool({
  name: "run_send",
  group: "messaging",
  description:
    "Send a message to a live run (its id or its name): it starts a turn there, or is queued until the current turn ends. Only rpc and durable runs take messages; runs inside a server job never do. Returns pi's answer (disposition started or queued). Follow what the run does with run_subscribe.",
  params: Type.Object({ target: Target, message: Type.String({ minLength: 1, description: "The text, as a user would type it" }) }, { additionalProperties: false }),
  run: async (a: { target: string; message: string }, ctx: ToolContext) => {
    if (!a.message.trim()) throw new ToolError("invalid", "run_send: the message is empty");
    const rec = findTarget(ctx, a.target, { live: true });
    if (ctx.caller.runId === rec.id) throw new ToolError("refused", `run ${rec.id} is your own run: a run does not message itself`);
    const refusal = messageRefusal(rec, (id) => ctx.runtime.get(id));
    if (refusal) throw new ToolError("refused", refusal);
    if (!rec.socket) throw new ToolError("failed", `run ${rec.id} has no control socket yet (it is starting): send again in a moment`);
    const id = newMessageId("send");
    const from = { kind: ctx.caller.kind, ...(ctx.caller.runId ? { runId: ctx.caller.runId } : {}), ...(ctx.caller.agent ? { agent: ctx.caller.agent } : {}) };
    let d;
    try {
      d = await sendMessage(rec.socket, a.message, { id, via: "run_send", from });
    } catch (err) {
      const why = err instanceof MessageError ? err.message : String(err);
      journalSend({ kind: "message.sent", data: { id, to: rec.id, ...(rec.spec.name ? { name: rec.spec.name } : {}), message: a.message, accepted: null, error: why } });
      throw new ToolError("failed", `run ${rec.id}: ${why}`);
    }
    // In an agent's pi process this reaches its own journal; elsewhere (the CLI) there is none and it does nothing.
    journalSend({ kind: "message.sent", data: { id, to: rec.id, ...(rec.spec.name ? { name: rec.spec.name } : {}), message: a.message, accepted: d.accepted, ...(d.disposition ? { disposition: d.disposition } : {}), ...(d.error ? { error: d.error } : {}) } });
    if (d.accepted === false) throw new ToolError("failed", `pi in run ${rec.id} refused the message: ${d.error ?? "no reason given"}`);
    return { id, runId: rec.id, ...(rec.spec.name ? { name: rec.spec.name } : {}), mode: rec.resolved?.mode ?? null, disposition: d.disposition ?? null };
  },
});

/** Does a kind match one of the prefixes? `tool` matches tool.start; `tool.*` and `tool.` too; `*` matches all. */
export function kindMatches(kind: string, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes?.length) return true;
  return prefixes.some((p) => {
    const q = p.trim().replace(/\*$/, "").replace(/\.$/, "");
    return q === "" || kind === q || kind.startsWith(`${q}.`);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const runSubscribe = defineTool({
  name: "run_subscribe",
  group: "messaging",
  description:
    "A run's journal events after a cursor (its id or name; since: the cursor the last call returned, 0 from the start), filtered by kind prefixes such as tool, message, trigger, run.end. Returns the events and the next cursor. waitSeconds (up to 60) holds the call until an event comes or the run ends.",
  params: Type.Object(
    {
      target: Target,
      events: Type.Optional(Type.Array(Type.String(), { description: "Kind prefixes: tool, message.received, run.* (default all)" })),
      since: Type.Optional(Type.Integer({ minimum: 0, description: "The cursor: only events after this journal seq" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "At most this many events (default 100)" })),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60, description: "Wait up to this long for an event (default 0)" })),
    },
    { additionalProperties: false },
  ),
  run: async (a: { target: string; events?: string[]; since?: number; limit?: number; waitSeconds?: number }, ctx: ToolContext) => {
    const rec = findTarget(ctx, a.target, { live: false });
    if (!rec.journal) throw new ToolError("failed", `run ${rec.id} keeps no journal (durable and named runs always do; start another with journal: true)`);
    const dir = ctx.runtime.dir(rec.id);
    const since = a.since ?? 0;
    const limit = a.limit ?? 100;
    const until = Date.now() + (a.waitSeconds ?? 0) * 1000;
    for (;;) {
      const all = readJournal(dir, { after: since });
      const matched = all.filter((e) => kindMatches(e.kind, a.events));
      const now = ctx.runtime.get(rec.id) ?? rec;
      const ended = isFinal(now.state);
      if (matched.length || ended || Date.now() >= until) {
        const events: JournalEvent[] = matched.slice(0, limit);
        const more = matched.length > limit;
        const cursor = more ? events[events.length - 1].seq : (all[all.length - 1]?.seq ?? since);
        return { runId: rec.id, ...(rec.spec.name ? { name: rec.spec.name } : {}), state: now.state, events, cursor, more };
      }
      await sleep(250);
    }
  },
});

export const tools: ToolDef[] = [runSend, runSubscribe];
