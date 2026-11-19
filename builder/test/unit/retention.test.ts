/**
 * Retention: the workspaces (clones) of all but the newest run trees are pruned after a job (keepWorkspaces), and
 * everything else under the runs directory is deleted once it is older than the retention period (runtime/retention.ts):
 * whole run trees, folders without a run record, snapshots and machine feed lines. A tree with a live run is never
 * touched, however old; a feed line keeps its number.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readFeed } from "../../runtime/feed.ts";
import { pruneExpired } from "../../runtime/retention.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { pruneWorkspaces } from "../../runtime/workspace.ts";
import { tempDir, waitFor } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-retention");
after(() => tmp.remove());

/** A run folder with its record and the given sub-folders (each with one file). */
function run(runsDir: string, id: string, o: { parent?: string; state?: RunRecord["state"]; pid?: number; startedAt: string; endedAt?: string; dirs: string[] }): void {
  const rec: RunRecord = { id, parent: o.parent ?? null, kind: o.parent ? "agent" : "workflow", spec: {}, state: o.state ?? "done", pid: o.pid ?? null, startedAt: o.startedAt, ...(o.endedAt ? { endedAt: o.endedAt } : {}) };
  writeTree(join(runsDir, id), {
    "run.json": JSON.stringify(rec),
    "journal.jsonl": "{}\n",
    "summary.json": "{}\n",
    "context/job.json": "{}\n",
    ...Object.fromEntries(o.dirs.map((d) => [`${d}/x`, "x"])),
  });
}

describe("pruneWorkspaces", () => {
  it("keeps the newest trees' workspaces, prunes the rest with their children's, keeps everything else, skips live trees", async () => {
    const runsDir = join(tmp.dir, "runs");
    run(runsDir, "a", { startedAt: "2026-11-17T10:00:00.000Z", dirs: ["workspace", "blobs", "pinned", "sessions"] });
    run(runsDir, "a-child", { parent: "a", startedAt: "2026-11-17T10:00:05.000Z", dirs: ["blobs", "sessions"] });
    run(runsDir, "b", { startedAt: "2026-11-17T11:00:00.000Z", dirs: ["workspace"] });
    run(runsDir, "c", { startedAt: "2026-11-17T09:00:00.000Z", state: "running", dirs: ["workspace"] });
    run(runsDir, "d", { startedAt: "2026-11-17T08:00:00.000Z", dirs: ["workspace"] });
    const warnings: string[] = [];
    pruneWorkspaces(runsDir, 1, null, (m) => warnings.push(m));
    const at = (id: string, d: string) => existsSync(join(runsDir, id, d));
    await waitFor("the old workspaces to be pruned", () => (!at("a", "workspace") && !at("d", "workspace") ? true : undefined), 5000, 20);
    assert.ok(at("b", "workspace"), "the newest tree keeps its workspace");
    assert.ok(at("c", "workspace"), "a live tree is never touched");
    for (const [id, f] of [["a", "blobs"], ["a", "pinned"], ["a", "sessions"], ["a-child", "blobs"], ["a-child", "sessions"], ["a", "journal.jsonl"], ["a", "run.json"], ["a", "context"]]) assert.ok(at(id, f), `${id}/${f} is kept`);
    assert.deepEqual(warnings, []);

    // The current job counts first, whatever its age.
    pruneWorkspaces(runsDir, 1, "c", () => {});
    await waitFor("b to be pruned", () => (!at("b", "workspace") ? true : undefined), 5000, 20);
    assert.ok(at("c", "workspace"));
  });
});

describe("pruneExpired", () => {
  // The live ops run's process: alive, with its run id on its command line (runtime/run.ts runProcessAlive).
  const OPS = "20261010-120000-0b5ops";
  const opsProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", OPS], { stdio: "ignore" });
  after(() => opsProcess.kill());
  const NOW = Date.parse("2026-11-19T12:00:00.000Z");
  const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

  function setup(name: string): string {
    const runsDir = join(tmp.dir, name);
    // An old job tree (ended 40 days ago), a recent one (10 days), an old tree with a live run (the interactive ops
    // run, started 40 days ago), an old tree whose child ended recently, and an old record a crash left running.
    run(runsDir, "old", { startedAt: daysAgo(41), endedAt: daysAgo(40), dirs: ["blobs", "sessions", "pinned", "artifacts"] });
    run(runsDir, "old-agent", { parent: "old", startedAt: daysAgo(41), endedAt: daysAgo(40), dirs: ["blobs", "sessions"] });
    run(runsDir, "recent", { startedAt: daysAgo(10), endedAt: daysAgo(10), dirs: ["blobs"] });
    run(runsDir, OPS, { startedAt: daysAgo(40), state: "running", pid: opsProcess.pid!, dirs: ["sessions"] });
    run(runsDir, "ops-child", { parent: OPS, startedAt: daysAgo(39), endedAt: daysAgo(39), dirs: [] });
    run(runsDir, "crashed", { startedAt: daysAgo(40), state: "running", pid: 999_999, dirs: ["sessions"] });
    run(runsDir, "mixed", { startedAt: daysAgo(45), endedAt: daysAgo(44), dirs: [] });
    run(runsDir, "mixed-late", { parent: "mixed", startedAt: daysAgo(45), endedAt: daysAgo(5), dirs: [] });
    // A folder with no run record, and two snapshots, one old.
    writeTree(runsDir, { "stray/x": "x", ".snapshots/scaffold-old/x": "x", ".snapshots/scaffold-new/x": "x" });
    const old = (NOW - 40 * 24 * 60 * 60 * 1000) / 1000;
    for (const p of ["stray", ".snapshots/scaffold-old"]) utimesSync(join(runsDir, p), old, old);
    // The feed: an old server.start (the newest one, kept), old lines of the deleted and the live tree, a recent line.
    const line = (ts: string, kind: string, runId?: string) => JSON.stringify({ ts, kind, ...(runId ? { runId } : {}), data: {} });
    writeFileSync(
      join(runsDir, "index.jsonl"),
      [
        line(daysAgo(50), "server.start"),
        line(daysAgo(41), "run.start", "old"),
        line(daysAgo(40), "run.end", "old"),
        line(daysAgo(40), "run.start", OPS),
        line(daysAgo(35), "server.state"),
        line(daysAgo(34), "server.start"),
        line(daysAgo(10), "run.end", "recent"),
      ].join("\n") + "\n",
    );
    return runsDir;
  }

  it("deletes trees that ended before the cut-off whole, old strays and snapshots; keeps live and recent trees; blanks old feed lines in place", async () => {
    const runsDir = setup("expire");
    const feedBefore = readFileSync(join(runsDir, "index.jsonl"));
    const r = await pruneExpired(runsDir, { days: 30, now: NOW });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.trees.map((t) => [t.root, t.runs.sort()]).sort(), [["crashed", ["crashed"]], ["old", ["old", "old-agent"]]]);
    assert.deepEqual(r.other.sort(), [".snapshots/scaffold-old", "stray"]);
    assert.deepEqual(r.live, [OPS]);
    for (const gone of ["old", "old-agent", "crashed", "stray", ".snapshots/scaffold-old"]) assert.ok(!existsSync(join(runsDir, gone)), `${gone} is deleted`);
    for (const kept of ["recent", OPS, "ops-child", "mixed", "mixed-late", ".snapshots/scaffold-new"]) assert.ok(existsSync(join(runsDir, kept)), `${kept} is kept`);

    // Feed: the same size, every line keeps its number; the expired ones are blank.
    const after = readFileSync(join(runsDir, "index.jsonl"));
    assert.equal(after.length, feedBefore.length);
    assert.equal(r.feedLines, 4);
    const events = readFeed(runsDir);
    assert.deepEqual(
      events.map((e) => [e.seq, e.kind, e.runId ?? null]),
      [
        [4, "run.start", OPS],
        [6, "server.start", null],
        [7, "run.end", "recent"],
      ],
    );
  });

  it("dryRun reports the same and deletes nothing; 0 days keeps everything", async () => {
    const runsDir = setup("dry");
    const feed = readFileSync(join(runsDir, "index.jsonl"), "utf8");
    const r = await pruneExpired(runsDir, { days: 30, now: NOW, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.trees.map((t) => t.root).sort(), ["crashed", "old"]);
    assert.equal(r.feedLines, 4);
    assert.ok(existsSync(join(runsDir, "old")) && existsSync(join(runsDir, "stray")));
    assert.equal(readFileSync(join(runsDir, "index.jsonl"), "utf8"), feed);
    const none = await pruneExpired(runsDir, { days: 0, now: NOW });
    assert.deepEqual([none.trees, none.other, none.feedLines], [[], [], 0]);
  });
});
