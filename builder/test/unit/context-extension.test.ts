/** shared:context without pi: the slice file a directly launched agent gets, and context_get's lookup through parent runs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ensureSliceFile, jobSection, sliceSection, sliceSummary, stepOutput } from "../../agentics/shared/extensions/context.ts";
import { GIT_ENV, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-context-ext");
after(() => tmp.remove());

describe("shared:context", () => {
  it("writes .slice.json when absent, replaces another slice's, keeps an equal one, and excludes it from git (app in a subdirectory too)", () => {
    const repo = join(tmp.dir, "repo");
    mkdirSync(join(repo, "app"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    const app = join(repo, "app");
    assert.equal(ensureSliceFile(app, { title: "A" }), "written");
    assert.equal(readFileSync(join(app, ".slice.json"), "utf8"), JSON.stringify({ title: "A" }, null, 2));
    assert.equal(ensureSliceFile(app, { title: "A" }), "kept");
    assert.equal(ensureSliceFile(app, { title: "B" }), "replaced");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((l) => l === "app/.slice.json").length, 1, "excluded once");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
  });

  it("context_get finds a step's output in this run, then in the runs above it", () => {
    const runs = writeTree(join(tmp.dir, "runs"), {
      "wf/run.json": JSON.stringify({ id: "wf", parent: null }),
      "wf/context/outputs/prepare.json": JSON.stringify({ appDir: "/w/app" }),
      "agent/run.json": JSON.stringify({ id: "agent", parent: "wf" }),
      "agent/context/outputs/own.json": JSON.stringify({ mine: true }),
    });
    const me = join(runs, "agent");
    assert.deepEqual(stepOutput("own", me), { found: true, value: { mine: true }, run: me });
    assert.deepEqual(stepOutput("prepare", me), { found: true, value: { appDir: "/w/app" }, run: join(runs, "wf") });
    assert.deepEqual(stepOutput("scaffold", me), { found: false });
    assert.deepEqual(stepOutput("../x", me), { found: false });
  });

  it("the job section lists the run's BUILDER_* job variables, and nothing without a dispatch", () => {
    assert.equal(jobSection({}), null);
    const s = jobSection({ BUILDER_JOB_ID: "j1", BUILDER_SLICE_TITLE: "CreateThing", BUILDER_BASE: "abc" })!;
    assert.match(s, /^You are running in a builder job that builds exactly one slice\./);
    assert.match(s, /\| `BUILDER_SLICE_TITLE` \| `CreateThing` \|\n\| `BUILDER_BASE` \| `abc` \|\n\| `BUILDER_JOB_ID` \| `j1` \|$/);
  });

  it("the slice section: the slice, then the scaffold the workflow above rendered, read through the parent run", () => {
    const dispatch = {
      task: { title: "CreateClient", context: "Invoicing" },
      slice: { sliceType: "STATE_CHANGE", commands: [{ title: "CreateClient" }], events: [{ title: "ClientCreated" }], readmodels: [], specifications: [{}, {}, {}] },
      changes: { verdict: "NEW" },
    };
    const report = {
      kind: "state-change",
      verdict: "NEW",
      files: [
        { path: "src/slices/Invoicing/CreateClient/CreateClientCommand.ts", action: "created" },
        { path: "src/slices/Invoicing/InvoicingEvents.ts", action: "kept" },
      ],
      injections: [{ target: "src/slices/Invoicing/InvoicingEvents.ts", key: "ClientCreated", action: "inserted" }],
      tasks: ["src/common/x.ts: the file does not exist. Add this where it belongs:\nconst a = 1;"],
      markers: [
        { path: "src/slices/Invoicing/CreateClient/CreateClientCommand.ts", line: 3, text: "// BUILD: decide" },
        { path: "src/slices/Invoicing/CreateClient/CreateClientCommand.ts", line: 9, text: "// BUILD: evolve" },
      ],
    };
    const runs = writeTree(join(tmp.dir, "runs-slice"), {
      "wf/run.json": JSON.stringify({ id: "wf", parent: null }),
      "wf/context/outputs/classify.json": JSON.stringify({ kind: "state-change", verdict: "NEW" }),
      "wf/context/outputs/scaffold.json": JSON.stringify(report),
      "agent/run.json": JSON.stringify({ id: "agent", parent: "wf" }),
      "agent/context/job.json": JSON.stringify({ jobId: "j", dispatch }),
    });
    assert.equal(
      sliceSection(join(runs, "agent")),
      [
        "Slice Invoicing/CreateClient: a state-change slice, verdict NEW (build the whole slice).",
        "Commands: CreateClient. Events: ClientCreated. Read models: none. Specifications: 3.",
        "",
        'Scaffold (the full report: context_get with step "scaffold"):',
        "- created: src/slices/Invoicing/CreateClient/CreateClientCommand.ts",
        "- kept (they existed; not overwritten): src/slices/Invoicing/InvoicingEvents.ts",
        "- injections: src/slices/Invoicing/InvoicingEvents.ts inserted",
        "- BUILD: markers to fill: 2 (src/slices/Invoicing/CreateClient/CreateClientCommand.ts 2)",
        "- tasks: 1; src/common/x.ts: the file does not exist. Add this where it belongs:",
      ].join("\n"),
    );
    assert.equal(sliceSection(join(runs, "nowhere")), null, "no job, no section");
  });

  it("the slice section says when the scaffold was skipped, lists what changed for CHANGED, and works without a workflow", () => {
    const dispatch = {
      task: { title: "Clients", context: "Invoicing" },
      slice: { sliceType: "STATE_VIEW", readmodels: [{ title: "Clients" }], specifications: [] },
      sourceEvents: [{ event: { title: "ClientCreated" } }],
      changes: { verdict: "CHANGED", elements: { changed: [{ kind: "readmodels", title: "Clients" }], added: [], removed: [] }, sourceEvents: { changed: [], added: [{ kind: "events", title: "ClientRenamed" }], removed: [] } },
    };
    const skipped = sliceSummary(dispatch, { kind: "state-view", verdict: "CHANGED" }, { kind: "state-view", skipped: { reason: "no template set for state-view" } })!;
    assert.equal(
      skipped,
      [
        "Slice Invoicing/Clients: a state-view slice, verdict CHANGED (rework what changed).",
        "Commands: none. Events: none. Read models: Clients. Source events: ClientCreated. Specifications: 0.",
        "Changes since the last build: changed: readmodels Clients; added: none; removed: none; source events: events ClientRenamed (added). The details (and `before`) are in the job: context_get with no step.",
        "",
        "Scaffold: skipped (no template set for state-view). Build the slice from the build skill for its kind.",
      ].join("\n"),
    );
    // A directly launched agent: no classify or scaffold output, the verdict from the dispatch.
    assert.match(sliceSummary(dispatch)!, /^Slice Invoicing\/Clients: sliceType STATE_VIEW, verdict CHANGED/);
    assert.equal(sliceSummary(undefined), null);
  });
});
