/**
 * A server job's journals, through the contract (the pi stub as the agent): the job run's journal opens with the
 * server's job.accepted and closes with job.result and the callback, one seq throughout; the agent run's journal links
 * to it; pi is started headless in JSON mode with shared:journal first and the gate host after the agent's own
 * extensions; the commit carries the Builder, Builder-Version and Step-Durations trailers.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readJournal, type JournalEvent } from "../../runtime/journal.ts";
import { JOURNAL_EXTENSION } from "../../runtime/pi.ts";
import { createRuntime } from "../../runtime/run.ts";
import { startBuilder } from "../harness/builder.ts";
import { applyPatch, dispatch, newJobId, SLICE } from "../harness/dispatch.ts";
import { createFixtureRepo, type FixtureRepo } from "../harness/fixture-repo.ts";
import { startGaffer, type FakeGaffer } from "../harness/gaffer.ts";
import { scenario } from "../harness/scenario.ts";
import { http, sleep, tempDir, waitFor } from "../harness/util.ts";

const SLICE_DIR = `src/slices/${SLICE.contextName}/${SLICE.title}`;

let tmp: ReturnType<typeof tempDir>;
let repo: FixtureRepo;
let gaffer: FakeGaffer;
before(async () => {
  tmp = tempDir("builder-server-journal");
  repo = createFixtureRepo(tmp.dir);
  gaffer = await startGaffer();
});
after(async () => {
  await gaffer?.stop();
  await sleep(300);
  tmp?.remove();
});

describe("a server job's journal", () => {
  it("job.accepted first, job.result and the callback last, one seq; the agent run links to the job run", { timeout: 60_000 }, async () => {
    const b = await startBuilder();
    try {
      const jobId = newJobId();
      b.setScenario(jobId, scenario({ op: "write", path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" }, { op: "stdout", text: "plain text, not JSON\n" }, { op: "done" }));
      const res = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, jobId));
      assert.equal(res.status, 202, res.text);
      const body = (await gaffer.result(jobId, 30_000)) as { outcome: string; patch: string };
      assert.equal(body.outcome, "done");

      const rt = createRuntime({ runsDir: b.runsDir, piCommand: "/bin/false" });
      const jobRun = rt.list().find((r) => r.job?.jobId === jobId)!;
      assert.equal(jobRun.journal, true);
      const agentRun = rt.list().find((r) => r.parent === jobRun.id)!;
      assert.equal(agentRun.journal, true, "a job's child runs inherit the journal");
      const kinds = (events: JournalEvent[]) => events.map((e) => e.kind);
      // The callback outcome lands after the run ended: wait for it.
      const jj = await waitFor("callback.ok in the job run's journal", () => {
        const ev = readJournal(rt.dir(jobRun.id));
        return ev.some((e) => e.kind === "callback.ok") ? ev : undefined;
      }, 10_000);
      assert.deepEqual(jj.map((e) => e.seq), jj.map((_, i) => i + 1), "one seq from job.accepted to the callback");
      assert.deepEqual(kinds(jj).slice(0, 3), ["job.accepted", "run.start", "job.start"]);
      assert.deepEqual(kinds(jj).slice(-4), ["run.end", "job.result", "callback.sent", "callback.ok"]);
      assert.equal(jj[0].data.jobId, jobId);
      assert.equal(jj[0].data.slice, `${SLICE.contextName}/${SLICE.title}`);
      assert.deepEqual(jj.find((e) => e.kind === "job.result")?.data, { outcome: "done", patchBytes: body.patch.length, commits: 1 });
      assert.deepEqual(
        jj.filter((e) => e.kind === "step.end").map((e) => e.step),
        ["clone", "prepare", "classify", "scaffold", "implement", "checks", "commit"],
      );
      assert.deepEqual(jj.find((e) => e.kind === "classify")?.data.kind, "state-change", "what classify decided is journaled");
      // The harness points the template sets at an empty folder: the scaffold skips and says why.
      assert.equal(jj.find((e) => e.kind === "scaffold.skipped" && e.step === "scaffold")?.data.reason, "no template set for state-change");
      assert.equal(jj.find((e) => e.kind === "step.end" && e.step === "implement")?.data.childRunId, agentRun.id);
      assert.ok(jj.some((e) => e.kind === "setup.ok" && e.step === "prepare"), "what code steps emit is journaled");
      assert.ok(existsSync(join(rt.dir(jobRun.id), "summary.json")));

      const aj = readJournal(rt.dir(agentRun.id));
      assert.equal(aj[0].kind, "run.start");
      assert.equal(aj[0].parent, jobRun.id);
      assert.equal(aj[0].step, "implement");
      assert.equal(aj[0].agent, "supabase-api");
      assert.ok(aj.some((e) => e.kind === "agent.start"));
      assert.equal(aj[aj.length - 1].kind, "run.end");

      // How pi was started.
      const argv = b.stubRecord(jobId)!.argv;
      assert.deepEqual(argv.slice(6, 8), ["-e", JOURNAL_EXTENSION], "shared:journal right after the discovery-off flags");
      assert.deepEqual(argv.slice(-5, -1), ["--mode", "json", "-p", "--"]);
      const exts = argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1]] : []));
      assert.ok(exts.length > 2 && exts[exts.length - 1].endsWith(join("runtime", "gate-host.ts")), `the gate host after the agent's extensions: ${exts.join(", ")}`);
      assert.ok(existsSync(join(rt.dir(agentRun.id), "gates.json")), "the gates file in the run's folder");
      const resources = aj.find((e) => e.kind === "agent.start")!.data.resources as { ref: string }[];
      assert.ok(["shared:journal", "runtime:gate-host", "shared:write-scope"].every((ref) => resources.some((r) => r.ref === ref)), "agent.start lists the journal, the gate host and the gates");
      const env = b.stubRecord(jobId)!.env;
      assert.equal(env.BUILDER_JOURNAL_FALLBACK, join(rt.dir(agentRun.id), "journal.fallback.jsonl"));
      assert.ok(env.BUILDER_JOURNAL_SOCK, "the socket the journal listens on");
      assert.match(readFileSync(join(rt.dir(jobRun.id), "log"), "utf8"), /plain text, not JSON/, "the job log keeps pi's output");

      const applied = applyPatch(repo, body.patch);
      try {
        assert.equal(applied.trailers["Builder"], "supabase-api");
        assert.match(applied.trailers["Builder-Version"] ?? "", /^[0-9a-f]{12}$/);
        assert.match(applied.trailers["Step-Durations"] ?? "", /^clone \d+s, prepare \d+s, classify \d+s, scaffold \d+s, implement \d+s, checks \d+s$/);
        assert.equal(applied.trailers["Agent-Turns"], "0", "the stub makes no model turns");
      } finally {
        applied.remove();
      }
    } catch (err) {
      if (err instanceof Error) err.message += `\n--- builder output ---\n${b.output()}`;
      throw err;
    } finally {
      await b.stop();
    }
  });
});
