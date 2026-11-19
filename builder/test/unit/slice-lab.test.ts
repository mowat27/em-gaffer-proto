/**
 * agents/dev/slice-lab, the example dev agent, as it resolves from the real tree: interactive with SYSTEM.md and the
 * build skills, its areas, what it may start (E8), and the tools it holds for the runs it starts: the verified
 * workflow's supabase-api build and the verifier get exactly the tools they get when started directly (D19).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { needsCoreTools } from "../../runtime/pi.ts";
import { ceilingOf, checkMayStart, resolve } from "../../runtime/resolve.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "../../runtime/root.ts";
import type { Resolved, RunRecord } from "../../runtime/types.ts";

const NO_LIMIT = { limit: { enable: ["*"], disable: [] } };
const LAB = join(AGENTICS_DIR, "agents", "dev", "slice-lab");

/** A run record for `resolved`, as the runtime would write it. */
function record(id: string, kind: "agent" | "workflow", spec: RunRecord["spec"], resolved: Resolved, parent: RunRecord | null): RunRecord {
  return { id, parent: parent?.id ?? null, kind, spec, state: "running", pid: 1, startedAt: new Date().toISOString(), resolved, ceiling: ceilingOf(kind, resolved, parent) };
}

describe("dev/slice-lab", () => {
  const lab = resolve({ agent: "dev/slice-lab" }, { config: NO_LIMIT, runDir: "/runs/lab" });

  it("is interactive with SYSTEM.md, the build skills and the write-scope gate; its own tools include runs, observe and verify, not bash", () => {
    assert.equal(lab.agent?.id, "dev/slice-lab");
    assert.equal(lab.mode, "interactive");
    assert.deepEqual(
      lab.resources.filter((r) => r.kind === "system").map((r) => r.path),
      [join(LAB, "SYSTEM.md")],
    );
    assert.ok(lab.resources.some((r) => r.kind === "skill" && r.path.endsWith(join("skills", "build", "build-state-change"))));
    assert.deepEqual(lab.resources.filter((r) => r.kind === "gate").map((r) => r.ref), ["shared:write-scope"]);
    for (const t of ["run_start", "run_wait", "context_get", "journal_query", "metrics", "verify", "read", "write", "edit", "server_start"]) assert.ok(lab.tools.includes(t), t);
    assert.ok(!lab.tools.includes("bash"));
    assert.ok(!lab.tools.includes("git_push"), "the git group is not its");
    assert.ok(needsCoreTools(lab.tools), "the runner loads the pi adapter for its core tools");
  });

  it("areas: its data/ and work/ writable, apps (the folder holding the gaffer checkout) read only; work/ is gitignored", () => {
    assert.deepEqual(lab.areas.data, { path: join(LAB, "data"), write: true });
    assert.deepEqual(lab.areas.work, { path: join(LAB, "work"), write: true });
    assert.deepEqual(lab.areas.apps, { path: dirname(dirname(BUILDER_ROOT)), write: false });
    assert.match(readFileSync(join(LAB, ".gitignore"), "utf8"), /^\/work\/$/m);
    assert.ok(existsSync(join(LAB, "data", "README.md")));
    assert.ok(existsSync(join(LAB, "settings.json")) && existsSync(join(LAB, "models.json")));
  });

  it("may start the supabase-api workflows and the verifier, nothing else (E8)", () => {
    const parent = record("20261118-140000-00000a", "agent", { agent: "dev/slice-lab" }, lab, null);
    assert.doesNotThrow(() => checkMayStart(parent, { workflow: "supabase-api-verified" }));
    assert.doesNotThrow(() => checkMayStart(parent, { workflow: "supabase-api" }));
    assert.doesNotThrow(() => checkMayStart(parent, { agent: "verifier" }));
    assert.throws(() => checkMayStart(parent, { agent: "supabase-api" }), /may not start agent:supabase-api/);
    assert.throws(() => checkMayStart(parent, { workflow: "other" }), /may not start workflow:other/);
  });

  it("the runs it starts get their full tools: its tools are the ceiling of the verified workflow's build and of the verifier", () => {
    const parent = record("20261118-140000-00000b", "agent", { agent: "dev/slice-lab" }, lab, null);
    const wfSpec = { workflow: "supabase-api-verified", input: { dispatch: "data:dispatches/createclient-new.json", repos: { app: "area:apps/gaffer" } } };
    const wf = resolve(wfSpec, { config: NO_LIMIT, parent, runDir: "/runs/wf" });
    assert.equal(wf.repos?.app.path, join(dirname(dirname(BUILDER_ROOT)), "gaffer"));
    const wfRec = record("20261118-140000-00000c", "workflow", wfSpec, wf, parent);
    const implement = resolve({ agent: "supabase-api", input: { args: [".slice.json"] } }, { config: NO_LIMIT, parent: wfRec, runDir: "/runs/impl" });
    const direct = resolve({ agent: "supabase-api", input: { args: [".slice.json"] } }, { config: NO_LIMIT, runDir: "/runs/impl" });
    assert.deepEqual(implement.tools, direct.tools);
    const verifier = resolve({ agent: "verifier", mode: "headless", input: { message: "/verify /w" } }, { config: NO_LIMIT, parent, runDir: "/runs/v" });
    assert.deepEqual(verifier.tools, resolve({ agent: "verifier", mode: "headless", input: { message: "/verify /w" } }, { config: NO_LIMIT, runDir: "/runs/v" }).tools);
  });
});
