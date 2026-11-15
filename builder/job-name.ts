/**
 * A friendly <adjective>-<noun> name for a build job, derived from its job id so the same job has the same name
 * everywhere (events, status, logs, the Sessions list) without storing it. The job id stays the identifier on the wire.
 */
import { createHash } from "node:crypto";

const ADJECTIVES = [
  "amber", "bold", "brisk", "calm", "clever", "cosmic", "crisp", "curious", "daring", "dusty", "eager", "elegant", "fancy", "fuzzy", "gentle", "glad",
  "golden", "happy", "hasty", "honest", "icy", "jolly", "keen", "kind", "lively", "lucky", "mellow", "merry", "mighty", "misty", "nimble", "noble",
  "odd", "patient", "plucky", "polite", "proud", "quick", "quiet", "rapid", "rosy", "rustic", "sandy", "shiny", "silent", "sleepy", "snappy", "solar",
  "spry", "steady", "sunny", "swift", "tidy", "tiny", "vivid", "warm", "wild", "wise", "witty", "zany", "zesty", "brave", "cheery", "dapper",
] as const;

const NOUNS = [
  "badger", "beaver", "bison", "cedar", "comet", "condor", "coral", "cricket", "dingo", "dolphin", "eagle", "falcon", "ferret", "finch", "fox", "gecko",
  "heron", "ibis", "jaguar", "kestrel", "koala", "lemur", "lynx", "magpie", "marmot", "meadow", "newt", "ocelot", "orchid", "osprey", "otter", "panda",
  "pebble", "pelican", "penguin", "puffin", "quokka", "raven", "river", "robin", "salmon", "sparrow", "squirrel", "stoat", "swan", "tapir", "thistle", "tiger",
  "toucan", "trout", "turtle", "walrus", "weasel", "willow", "wombat", "wren", "yak", "zebra", "acorn", "aspen", "breeze", "canyon", "harbor", "lagoon",
] as const;

export function jobName(jobId: string): string {
  const h = createHash("sha256").update(jobId).digest();
  return `${ADJECTIVES[h.readUInt16BE(0) % ADJECTIVES.length]}-${NOUNS[h.readUInt16BE(2) % NOUNS.length]}`;
}

/** `swift-otter (d6542947)`: the name with the short id, for messages. */
export function jobLabel(jobId: string): string {
  return `${jobName(jobId)} (${jobId.slice(0, 8)})`;
}
