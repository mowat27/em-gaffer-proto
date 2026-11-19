/**
 * builder logs <run> [-f] [--limit n]: the end of a run's journal (journal_tail), or of its log for a run without a
 * journal. -f follows it until the run has ended and nothing more arrives, or Ctrl+C. --json prints one event per line.
 */
import type { JournalEvent } from "../../runtime/journal.ts";
import { isFinal, type RunState } from "../../runtime/types.ts";
import { callTool } from "../../ops/core/tool.ts";
import { cliTools, parse, sleep, untilInterrupted, usage, type Command } from "../common.ts";
import { eventLine } from "../format.ts";

const USAGE = "usage: builder logs <run> [-f] [--limit n]   <run>: a run id, a job id or name, or latest";

interface Tail {
  runId: string;
  state: RunState;
  journal: boolean;
  events: JournalEvent[];
  lastSeq: number;
  log?: { text: string; next: number };
}

const logs: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  const { values: o, positionals } = parse(argv, { follow: { type: "boolean", short: "f" }, limit: { type: "string" } });
  if (positionals.length !== 1) usage(USAGE);
  const limit = o.limit ? Number(o.limit) : 20;
  if (!(limit >= 1)) usage("--limit is a number of events");
  const ctx = cliTools(g);
  const show = (t: Tail) => {
    for (const e of t.events) console.log(g.json ? JSON.stringify(e) : eventLine(e));
    if (t.log?.text) process.stdout.write(g.json ? JSON.stringify({ log: t.log.text }) + "\n" : t.log.text.endsWith("\n") ? t.log.text : `${t.log.text}\n`);
  };
  let tail = (await callTool("journal_tail", { run: positionals[0], limit }, ctx)) as Tail;
  if (!o.follow) {
    if (g.json) console.log(JSON.stringify(tail));
    else {
      if (!tail.journal) console.error(`[builder] run ${tail.runId} has no journal: its log follows`);
      show(tail);
    }
    return 0;
  }
  show(tail);
  const signal = untilInterrupted();
  while (!signal.aborted) {
    await sleep(500);
    const next = (await callTool("journal_tail", { run: tail.runId, after: tail.lastSeq, ...(tail.log ? { logFrom: tail.log.next } : {}) }, ctx)) as Tail;
    show(next);
    const quiet = !next.events.length && !next.log?.text;
    if (isFinal(next.state) && quiet && isFinal(tail.state)) break;
    tail = { ...next, lastSeq: next.lastSeq || tail.lastSeq };
  }
  return 0;
};

export default logs;
