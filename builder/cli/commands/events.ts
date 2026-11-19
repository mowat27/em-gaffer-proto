/**
 * builder events [--since <seq|time|10m>] [-f] [--kind k] [--run id] [--job id] [--last n]: the machine feed
 * (runs/index.jsonl, runtime/feed.ts): every run, step, job, callback, server, control and config event on this
 * machine. -f keeps following until Ctrl+C. --json prints one event per line (the TSF reads it so).
 */
import { followFeed, parseSince, readFeed, type FeedEvent, type FeedFilter } from "../../runtime/feed.ts";
import { cliConfig, parse, untilInterrupted, usage, type Command } from "../common.ts";
import { eventLine } from "../format.ts";

const USAGE = "usage: builder events [--since <seq|time|10m|2h|1d>] [-f] [--kind <kind|prefix*>] [--run <id>] [--job <id>] [--last n] [--json]";

const events: Command = async (argv, g) => {
  if (g.help) {
    console.log(USAGE);
    return 0;
  }
  const { values: o, positionals } = parse(argv, { since: { type: "string" }, follow: { type: "boolean", short: "f" }, kind: { type: "string" }, run: { type: "string" }, job: { type: "string" }, last: { type: "string" } });
  if (positionals.length) usage(USAGE);
  const f: FeedFilter = {};
  try {
    if (o.since) f.since = parseSince(o.since);
  } catch (err) {
    usage((err as Error).message);
  }
  if (o.kind) f.kind = o.kind;
  if (o.run) f.runId = o.run;
  if (o.job) f.jobId = o.job;
  if (o.last) {
    const n = Number(o.last);
    if (!(n >= 0)) usage("--last is a number of events");
    f.last = n;
  }
  const runsDir = cliConfig(g).server.runsDir;
  const print = (e: FeedEvent) => console.log(g.json ? JSON.stringify(e) : eventLine(e, true));
  if (!o.follow) {
    readFeed(runsDir, f).forEach(print);
    return 0;
  }
  await followFeed(runsDir, f, print, untilInterrupted());
  return 0;
};

export default events;
