/**
 * The builder's contract (docs/contract.md), black box: dispatches over HTTP, results at the callback. No model and no
 * network: the target repository is a local fixture, the agent is the pi stub doing a scripted scenario, and the
 * gaffer is a local listener. Every detail of how the builder is configured and started is in ./harness/builder.ts.
 *
 * The expected reasons are byte-for-byte today's: a builder that keeps its contract keeps them.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { startBuilder, type RunningBuilder, type StartBuilderOptions } from "./harness/builder.ts";
import { applyPatch, dispatch, newJobId, SLICE } from "./harness/dispatch.ts";
import { createFixtureRepo, type FixtureRepo } from "./harness/fixture-repo.ts";
import { failTimes, startGaffer, type FakeGaffer } from "./harness/gaffer.ts";
import { scenario, type Scenario } from "./harness/scenario.ts";
import { http, sleep, tempDir, waitFor } from "./harness/util.ts";

const SLICE_DIR = `src/slices/${SLICE.contextName}/${SLICE.title}`;
const A_CHANGE = scenario({ op: "write", path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" }, { op: "done" });

let tmp: ReturnType<typeof tempDir>;
let repo: FixtureRepo;
let gaffer: FakeGaffer;

/** Run `fn` against a fresh builder, stopping it afterwards and adding its output to any failure. */
async function withBuilder<T>(opts: StartBuilderOptions, fn: (b: RunningBuilder) => Promise<T>): Promise<T> {
  const b = await startBuilder(opts);
  try {
    return await fn(b);
  } catch (err) {
    if (err instanceof Error) err.message += `\n--- builder output ---\n${b.output()}`;
    throw err;
  } finally {
    await b.stop();
  }
}

/** Dispatch one job to a fresh builder with the stub doing `s`, and return the callback body. */
async function outcome(
  s: Scenario,
  o: { builder?: StartBuilderOptions; repo?: FixtureRepo; overrides?: Record<string, unknown>; timeoutMs?: number; check?: (b: RunningBuilder, jobId: string) => void } = {},
): Promise<unknown> {
  return withBuilder(o.builder ?? {}, async (b) => {
    const jobId = newJobId();
    b.setScenario(jobId, s);
    const res = await http("POST", `${b.url}/slices`, dispatch(o.repo ?? repo, gaffer, jobId, o.overrides));
    assert.equal(res.status, 202, res.text);
    const body = await gaffer.result(jobId, o.timeoutMs ?? 30_000);
    o.check?.(b, jobId);
    return body;
  });
}

const failed = (reason: string) => ({ outcome: "failed", reason });

/** The builder's slice version: sha256 of the slice's canonical JSON without its volatile fields, first 12 hex digits. */
function sliceVersion(slice: Record<string, unknown>): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  const def = Object.fromEntries(Object.entries(slice).filter(([k]) => !["status", "comments", "assignee", "ticketNumber"].includes(k)));
  return createHash("sha256").update(canonical(def)).digest("hex").slice(0, 12);
}

describe("builder contract", { concurrency: true }, () => {
  before(async () => {
    tmp = tempDir("builder-contract-repos");
    repo = createFixtureRepo(tmp.dir);
    gaffer = await startGaffer();
  });
  after(async () => {
    await gaffer?.stop();
    tmp?.remove();
  });

  describe("routes", { concurrency: true }, () => {
    let b: RunningBuilder;
    before(async () => (b = await startBuilder()));
    after(async () => b?.stop());

    it("GET /health answers 200 { ok: true }", async () => {
      const res = await http("GET", `${b.url}/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
    });

    for (const [method, path] of [
      ["GET", "/nope"],
      ["GET", "/slices"],
      ["DELETE", "/slices"],
      ["POST", "/health"],
    ] as const) {
      it(`${method} ${path} answers 404 { error: "not found" }`, async () => {
        const res = await http(method, `${b.url}${path}`);
        assert.equal(res.status, 404);
        assert.deepEqual(res.json, { error: "not found" });
      });
    }
  });

  describe("POST /slices: malformed dispatches (400)", { concurrency: true }, () => {
    let b: RunningBuilder;
    before(async () => (b = await startBuilder()));
    after(async () => b?.stop());

    const valid = () => dispatch(repo, gaffer, newJobId());
    const without = (key: string) => {
      const d = valid();
      delete d[key];
      return d;
    };
    const REPO = "repo.url and repo.base (a commit sha) are required";
    const TASK = "task.sliceId, task.title and task.context are required";
    const CALLBACK = "callback must be an http(s) URL ending in /jobs/<jobId>";
    const task = (t: Record<string, unknown>) => ({ ...valid(), task: t });
    const cases: [string, () => string | object, string][] = [
      ["invalid JSON", () => "{not json", "invalid JSON"],
      ["an empty body", () => "", "invalid JSON"],
      ["null", () => "null", "body must be a JSON object"],
      ["a number", () => "42", "body must be a JSON object"],
      ["a string", () => '"dispatch"', "body must be a JSON object"],
      ["an empty object (the first problem wins)", () => ({}), "requires must be a string array"],
      ["an array", () => "[]", "requires must be a string array"],
      ["requires missing", () => without("requires"), "requires must be a string array"],
      ["requires not an array", () => ({ ...valid(), requires: "stack:stub" }), "requires must be a string array"],
      ["requires with a non-string entry", () => ({ ...valid(), requires: ["stack:stub", 7] }), "requires must be a string array"],
      ["repo missing", () => without("repo"), REPO],
      ["repo.url not a string", () => ({ ...valid(), repo: { url: 1, base: repo.base } }), REPO],
      ["repo.base missing", () => ({ ...valid(), repo: { url: repo.url } }), REPO],
      ["repo.base a branch name", () => ({ ...valid(), repo: { url: repo.url, base: "main" } }), REPO],
      ["repo.base shorter than 7", () => ({ ...valid(), repo: { url: repo.url, base: "a4ed0f" } }), REPO],
      ["repo.base in upper case", () => ({ ...valid(), repo: { url: repo.url, base: repo.base.toUpperCase() } }), REPO],
      ["task missing", () => without("task"), TASK],
      ["task.sliceId missing", () => task({ title: "T", context: "C" }), TASK],
      ["task.title not a string", () => task({ sliceId: "s", title: 3, context: "C" }), TASK],
      ["task.context missing", () => task({ sliceId: "s", title: "T" }), TASK],
      ["callback missing", () => without("callback"), CALLBACK],
      ["callback not http(s)", () => ({ ...valid(), callback: "ftp://127.0.0.1/jobs/x" }), CALLBACK],
      ["callback without /jobs/<jobId>", () => ({ ...valid(), callback: "http://127.0.0.1:9/results/x" }), CALLBACK],
      ["callback ending in /jobs/", () => ({ ...valid(), callback: "http://127.0.0.1:9/jobs/" }), CALLBACK],
      ["callback with a segment after the job id", () => ({ ...valid(), callback: "http://127.0.0.1:9/jobs/x/y" }), CALLBACK],
    ];
    for (const [name, body, error] of cases) {
      it(`${name}: 400 { error: "${error}" }`, async () => {
        const res = await http("POST", `${b.url}/slices`, body());
        assert.equal(res.status, 400, res.text);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
        assert.deepEqual(res.json, { error });
      });
    }
  });

  describe("POST /slices: requirements not met (422)", { concurrency: true }, () => {
    let b: RunningBuilder;
    before(async () => (b = await startBuilder({ capabilities: ["stack:stub"] })));
    after(async () => b?.stop());

    const post = (requires: string[], repoOverride?: { url: string; base: string }) =>
      http("POST", `${b.url}/slices`, dispatch(repo, gaffer, newJobId(), { requires, ...(repoOverride ? { repo: repoOverride } : {}) }));

    it("an unmet capability is listed in missing", async () => {
      const res = await post([repo.requirement, "stack:cobol"]);
      assert.equal(res.status, 422, res.text);
      assert.deepEqual(res.json, { missing: ["stack:cobol"] });
    });

    it("a repo: requirement that names another repository is listed in missing", async () => {
      const res = await post(["repo:github.com/someone/else", "stack:stub"]);
      assert.equal(res.status, 422, res.text);
      assert.deepEqual(res.json, { missing: ["repo:github.com/someone/else"] });
    });

    it("an unreachable repository is listed in missing, with why", async () => {
      const url = "/nonexistent/contract-test/missing-repo";
      const res = await post([`repo:${url}`, "stack:stub"], { url, base: repo.base });
      assert.equal(res.status, 422, res.text);
      const missing = (res.json as { missing: string[] }).missing;
      assert.equal(missing.length, 1, res.text);
      assert.ok(missing[0].startsWith(`repo:${url} (cannot reach ${url}: `), missing[0]);
      assert.ok(missing[0].endsWith(")"), missing[0]);
    });

    it("everything that cannot be met is listed, in requires order", async () => {
      const res = await post(["repo:github.com/someone/else", "stack:cobol", "stack:stub"]);
      assert.equal(res.status, 422, res.text);
      assert.deepEqual(res.json, { missing: ["repo:github.com/someone/else", "stack:cobol"] });
    });
  });

  describe("POST /slices: accepting jobs", { concurrency: true }, () => {
    it("202 { jobId } where jobId is the callback's last path segment", async () => {
      await withBuilder({}, async (b) => {
        const jobId = newJobId();
        b.setScenario(jobId, A_CHANGE);
        const res = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, jobId));
        assert.equal(res.status, 202, res.text);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
        assert.deepEqual(res.json, { jobId });
        await gaffer.result(jobId, 30_000);
      });
    });

    it("a rejected dispatch starts no job: nothing is called back and the next dispatch is accepted", async () => {
      await withBuilder({}, async (b) => {
        const rejected = newJobId();
        const res = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, rejected, { requires: [repo.requirement, "stack:cobol"] }));
        assert.equal(res.status, 422, res.text);
        const next = newJobId();
        b.setScenario(next, A_CHANGE);
        assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, next))).status, 202);
        await gaffer.result(next, 30_000);
        assert.equal(gaffer.calls(rejected).length, 0);
        assert.equal(b.stubRecord(rejected), null);
      });
    });

    it("one job at a time: 503 + Retry-After: 15 + { error: busy, jobId } while a job runs, then the next job is accepted", async () => {
      await withBuilder({}, async (b) => {
        const first = newJobId();
        b.setScenario(first, scenario({ op: "sleep", ms: 4000 }, ...A_CHANGE.steps));
        assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, first))).status, 202);

        const second = newJobId();
        const busy = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, second));
        assert.equal(busy.status, 503, busy.text);
        assert.equal(busy.headers.get("retry-after"), "15");
        assert.deepEqual(busy.json, { error: "busy", jobId: first });

        // While busy, a malformed dispatch is still a 400, and one with unmet requirements is a 503, not a 422.
        const malformed = await http("POST", `${b.url}/slices`, "{not json");
        assert.equal(malformed.status, 400);
        const unmet = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, newJobId(), { requires: [repo.requirement, "stack:cobol"] }));
        assert.equal(unmet.status, 503);

        assert.equal((await gaffer.result(first, 30_000) as { outcome: string }).outcome, "done");
        b.setScenario(second, A_CHANGE);
        const accepted = await waitFor(
          "the builder to accept the next job",
          async () => {
            const res = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, second));
            return res.status === 503 ? undefined : res;
          },
          10_000,
          200,
        );
        assert.equal(accepted.status, 202, accepted.text);
        assert.deepEqual(accepted.json, { jobId: second });
        assert.equal((await gaffer.result(second, 30_000) as { outcome: string }).outcome, "done");
      });
    });
  });

  describe("callback: done", { concurrency: true }, () => {
    it("sends { outcome: done, patch }: one commit on base holding the agent's changes, with the slice subject and trailers", async () => {
      let jobId = "";
      const body = await outcome(
        scenario(
          { op: "write", path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" },
          { op: "write", path: `${SLICE_DIR}/notes.md`, content: "# CreateThing\n" },
          { op: "write", path: "LEARNINGS.md", content: "# Learnings\n\n- the fixture has no dependencies\n" },
          // Never in the patch: the agent's scratch scripts and installed dependencies.
          { op: "write", path: ".scratch/probe.mjs", content: "console.log(1);\n" },
          { op: "write", path: "node_modules/leftover/index.js", content: "module.exports = 1;\n" },
          { op: "done" },
        ),
        { check: (_b, id) => (jobId = id) },
      );
      const { outcome: kind, patch } = body as { outcome: string; patch: string };
      assert.deepEqual(Object.keys(body as object).sort(), ["outcome", "patch"]);
      assert.equal(kind, "done");
      assert.equal(patch.match(/^From [0-9a-f]{40} /gm)?.length, 1, "exactly one commit");
      assert.match(patch, /^Subject: \[PATCH\] Build slice Billing\/CreateThing$/m);

      const applied = applyPatch(repo, patch);
      try {
        assert.equal(applied.subject, `Build slice ${SLICE.contextName}/${SLICE.title}`);
        assert.deepEqual(applied.files, ["LEARNINGS.md", `${SLICE_DIR}/notes.md`, `${SLICE_DIR}/thing.ts`]);
        assert.equal(applied.read(`${SLICE_DIR}/thing.ts`), "export const thing = 1;\n");
        const t = applied.trailers;
        assert.equal(t["Slice"], SLICE.title);
        assert.equal(t["Slice-Id"], SLICE.id);
        assert.equal(t["Slice-Version"], sliceVersion(SLICE));
        assert.equal(t["Slice-Type"], SLICE.sliceType);
        assert.equal(t["Context"], SLICE.contextName);
        assert.equal(t["Chapter"], SLICE.chapterTitle);
        assert.equal(t["Attempt"], "2");
        assert.equal(t["Handover"], "on");
        assert.equal(t["Job-Id"], jobId);
        assert.match(t["Job-Name"] ?? "", /^[a-z]+-[a-z]+$/);
        assert.equal(t["Base"], repo.base);
        assert.equal(t["Repository"], repo.url);
        assert.match(t["Agent"] ?? "", /^pi \S+\/\S+$/);
        assert.match(t["Job-Duration"] ?? "", /^\d+(s|m \d\ds|h \d\dm)$/);
        assert.ok(!Number.isNaN(Date.parse(t["Built-At"] ?? "")), `Built-At: ${t["Built-At"]}`);
      } finally {
        applied.remove();
      }
    });
  });

  describe("callback: failed, with the reason", { concurrency: true }, () => {
    const HALT = "The slice has no fields to build CreateThing from. Question: Which fields should the CreateThing command take?";

    it("the agent halts: its reason verbatim, and the builder stops the agent without waiting for it", async () => {
      const started = Date.now();
      const body = await outcome(scenario({ op: "write", path: `${SLICE_DIR}/half.ts`, content: "export {};\n" }, { op: "halt", reason: HALT }, { op: "sleep", ms: 60_000 }));
      assert.deepEqual(body, failed(HALT));
      assert.ok(Date.now() - started < 30_000, "the builder waited for the agent to finish");
    });

    it("a halt wins over the agent's exit code", async () => {
      assert.deepEqual(await outcome(scenario({ op: "halt", reason: HALT }, { op: "exit", code: 3 })), failed(HALT));
    });

    it("the agent finishes without calling done", async () => {
      const body = await outcome(scenario({ op: "write", path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" }));
      assert.deepEqual(body, failed("the agent finished without calling done"));
    });

    it("the agent calls done with no changes", async () => {
      assert.deepEqual(await outcome(scenario({ op: "done" })), failed("the agent produced no changes"));
    });

    it("the slice commit-scope checks fail when the builder reruns them after done", async () => {
      const body = await outcome(
        scenario(
          { op: "write", path: "package.json", content: '{ "name": "fixture-app", "version": "2.0.0" }\n' },
          { op: "write", path: `${SLICE_DIR}/thing.ts`, content: "export const thing = 1;\n" },
          { op: "done" },
        ),
      );
      assert.deepEqual(
        body,
        failed("slice commit-scope checks failed after done:\n  - package.json — [blocked-paths] dependency/package manifest changes are not allowed from a slice commit"),
      );
    });

    it("pi exits non-zero: the exit code and the end of its output", async () => {
      const body = await outcome(scenario({ op: "stderr", text: "stub failure: boom\n" }, { op: "exit", code: 7 }));
      assert.deepEqual(body, failed("pi exited 7: stub failure: boom"));
    });

    it("not set up: a file setup needs is missing at base, and the agent never starts", async () => {
      const bare = createFixtureRepo(tmp.dir, { name: "fixture-no-tsconfig", omit: ["tsconfig.json"] });
      const body = await outcome(A_CHANGE, {
        repo: bare,
        overrides: { requires: [bare.requirement, "stack:stub"] },
        check: (b, jobId) => assert.equal(b.stubRecord(jobId), null, "the agent started"),
      });
      assert.deepEqual(body, failed(`target repository is not set up: tsconfig.json missing at base ${bare.base.slice(0, 12)}`));
    });

    it("not set up: a setup command fails, and the agent never starts", async () => {
      const command = "echo setup-broke >&2; exit 3";
      const body = await outcome(A_CHANGE, {
        builder: { setupCommands: [command] },
        check: (b, jobId) => assert.equal(b.stubRecord(jobId), null, "the agent started"),
      });
      assert.deepEqual(body, failed(`target repository is not set up: \`${command}\` failed at base ${repo.base.slice(0, 12)}: setup-broke`));
    });

    it("not set up: the base fails a base check, and the agent never starts", async () => {
      const command = "echo base-broke >&2; exit 2";
      const body = await outcome(A_CHANGE, {
        builder: { baseCheckCommands: [command] },
        check: (b, jobId) => assert.equal(b.stubRecord(jobId), null, "the agent started"),
      });
      assert.deepEqual(body, failed(`target repository is not set up: \`${command}\` failed at base ${repo.base.slice(0, 12)}: base-broke`));
    });

    it("the base is not in the repository, and the agent never starts", async () => {
      const base = "0123456789abcdef0123456789abcdef01234567";
      const body = (await outcome(A_CHANGE, {
        overrides: { repo: { url: repo.url, base } },
        check: (b, jobId) => assert.equal(b.stubRecord(jobId), null, "the agent started"),
      })) as { outcome: string; reason: string };
      assert.deepEqual(Object.keys(body).sort(), ["outcome", "reason"]);
      assert.equal(body.outcome, "failed");
      assert.ok(body.reason.startsWith(`base ${base} is not in the repository: git checkout -q ${base} failed: `), body.reason);
    });

    it("pi times out (the shortest timeout is 1 minute)", { timeout: 150_000 }, async () => {
      const body = await outcome(scenario({ op: "sleep", ms: 120_000 }, ...A_CHANGE.steps), { builder: { piTimeoutMinutes: 1 }, timeoutMs: 120_000 });
      assert.deepEqual(body, failed("pi timed out after 1 min"));
    });
  });

  describe("callback delivery", { concurrency: true }, () => {
    it("retries until the gaffer answers 204, with the same body each time, then stops", async () => {
      const g = await startGaffer(failTimes(2, 204));
      try {
        await withBuilder({}, async (b) => {
          const jobId = newJobId();
          b.setScenario(jobId, A_CHANGE);
          assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, g, jobId))).status, 202);
          const calls = await g.waitForCalls(jobId, 3, 30_000);
          assert.deepEqual(calls.map((c) => c.status), [500, 500, 204]);
          assert.equal(calls[1].raw, calls[0].raw);
          assert.equal(calls[2].raw, calls[0].raw);
          assert.equal((calls[0].body as { outcome: string }).outcome, "done");
          await sleep(2500);
          assert.equal(g.calls(jobId).length, 3, "the builder called back again after 204");
        });
      } finally {
        await g.stop();
      }
    });

    it("stops at 410 Gone", async () => {
      const g = await startGaffer(() => 410);
      try {
        await withBuilder({}, async (b) => {
          const jobId = newJobId();
          b.setScenario(jobId, A_CHANGE);
          assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, g, jobId))).status, 202);
          await g.waitForCalls(jobId, 1, 30_000);
          await sleep(2500);
          assert.deepEqual(g.calls(jobId).map((c) => c.status), [410]);
        });
      } finally {
        await g.stop();
      }
    });

    it("gives up after callbackRetries + 1 tries, and is then free for the next job", async () => {
      const g = await startGaffer(() => 500);
      try {
        await withBuilder({ callbackRetries: 1 }, async (b) => {
          const jobId = newJobId();
          b.setScenario(jobId, A_CHANGE);
          assert.equal((await http("POST", `${b.url}/slices`, dispatch(repo, g, jobId))).status, 202);
          await g.waitForCalls(jobId, 2, 30_000);
          const next = newJobId();
          b.setScenario(next, A_CHANGE);
          const accepted = await waitFor(
            "the builder to accept the next job",
            async () => {
              const res = await http("POST", `${b.url}/slices`, dispatch(repo, gaffer, next));
              return res.status === 503 ? undefined : res;
            },
            15_000,
            200,
          );
          assert.equal(accepted.status, 202, accepted.text);
          assert.equal(g.calls(jobId).length, 2);
          await gaffer.result(next, 30_000);
        });
      } finally {
        await g.stop();
      }
    });
  });
});
