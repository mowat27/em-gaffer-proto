#!/usr/bin/env node
/**
 * pi stub: stands in for the `pi` executable in the builder's contract tests. It ignores its arguments, finds the
 * scenario for its job and performs it in its working directory (see ./scenario.ts), so a test decides exactly what
 * "the agent" does: change files, call done, halt, hang, crash.
 *
 * The harness starts it through a launcher that sets $PI_STUB_DIR (see ./builder.ts):
 *   $PI_STUB_DIR/scenarios/<key>.json   the scenario, keyed by job id (default.json when none matches)
 *   $PI_STUB_DIR/records/<key>.json     what the stub saw: argv, cwd, BUILDER_* and PI_* variables (secrets redacted)
 *
 * How the agent hands work over (the done and halt files) lives in signalDone and signalHalt only, and how the stub
 * finds its job lives in scenarioKeys only, so a builder that changes either mechanism changes one function here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Scenario, Step, StubRecord } from "./scenario.ts";

const STUB_DIR = process.env.PI_STUB_DIR ?? "";
const parentAtStart = process.ppid;

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** The agent's `done` tool after its checks pass (pi-agent/extensions/done/index.ts): `{ ok: true }` in $BUILDER_DONE_FILE. */
function signalDone(): void {
  const file = process.env.BUILDER_DONE_FILE;
  if (!file) throw new Error("BUILDER_DONE_FILE is not set");
  writeAtomic(file, JSON.stringify({ ok: true }));
}

/** The agent's `halt` tool (pi-agent/extensions/halt.ts): `{ reason }` in $BUILDER_HALT_FILE. */
function signalHalt(reason: string): void {
  const file = process.env.BUILDER_HALT_FILE;
  if (!file) throw new Error("BUILDER_HALT_FILE is not set");
  writeAtomic(file, JSON.stringify({ reason }));
}

/** Where to look for this run's scenario, best first: the job id, the slice id, then the working directory's path segments. */
function scenarioKeys(): string[] {
  const keys = [process.env.BUILDER_JOB_ID, process.env.BUILDER_SLICE_ID, ...process.cwd().split(sep).reverse()];
  return keys.filter((k): k is string => !!k && /^[\w.-]+$/.test(k) && k !== "." && k !== "..");
}

function findScenario(): { key: string; scenario: Scenario } {
  const dir = join(STUB_DIR, "scenarios");
  for (const key of [...scenarioKeys(), "default"]) {
    const file = join(dir, `${key}.json`);
    if (existsSync(file)) return { key, scenario: JSON.parse(readFileSync(file, "utf8")) as Scenario };
  }
  return { key: "none", scenario: { steps: [] } };
}

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i;

function record(key: string): void {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !/^(BUILDER_|PI_)/.test(k)) continue;
    env[k] = SECRET.test(k) ? "[redacted]" : v;
  }
  const rec: StubRecord = { key, argv: process.argv.slice(2), cwd: process.cwd(), env, startedAt: new Date().toISOString() };
  writeAtomic(join(STUB_DIR, "records", `${key}.json`), JSON.stringify(rec, null, 2));
}

/** Sleep, but give up as soon as the process that started the stub is gone, so a stopped builder leaves no stub behind. */
async function sleep(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (process.ppid !== parentAtStart) process.exit(0);
    await new Promise((r) => setTimeout(r, Math.min(200, until - Date.now())));
  }
}

async function perform(step: Step): Promise<void> {
  const at = (p: string) => resolve(process.cwd(), p);
  switch (step.op) {
    case "write":
      mkdirSync(dirname(at(step.path)), { recursive: true });
      writeFileSync(at(step.path), step.content);
      return;
    case "append":
      mkdirSync(dirname(at(step.path)), { recursive: true });
      appendFileSync(at(step.path), step.content);
      return;
    case "remove":
      rmSync(at(step.path), { force: true });
      return;
    case "done":
      return signalDone();
    case "halt":
      return signalHalt(step.reason);
    case "sleep":
      return sleep(step.ms);
    // Written synchronously: on macOS a pipe write is asynchronous, and an exit right after would drop it.
    case "stdout":
      writeSync(1, step.text);
      return;
    case "stderr":
      writeSync(2, step.text);
      return;
    case "exit":
      process.exit(step.code);
  }
}

if (!STUB_DIR) {
  writeSync(2, "pi-stub: PI_STUB_DIR is not set\n");
  process.exit(64);
}
const { key, scenario } = findScenario();
try {
  record(key);
  for (const step of scenario.steps) await perform(step);
} catch (err) {
  writeSync(2, `pi-stub: ${(err as Error).message}\n`);
  process.exit(70);
}
process.exit(0);
