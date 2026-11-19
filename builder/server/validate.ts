/** The contract's dispatch: validation (400), and the `requires` check (422) against what the active builder provides. */
import { spawnSync } from "node:child_process";
import { repoKey } from "../engine/steps/clone.ts";
import type { Dispatch } from "../engine/types.ts";

export { repoKey };
export type { Dispatch };

export function validate(body: unknown): { ok: true; d: Dispatch } | { ok: false; error: string } {
  const b = body as Partial<Dispatch> | null;
  if (!b || typeof b !== "object") return { ok: false, error: "body must be a JSON object" };
  if (!Array.isArray(b.requires) || !b.requires.every((r) => typeof r === "string")) return { ok: false, error: "requires must be a string array" };
  if (!b.repo || typeof b.repo.url !== "string" || typeof b.repo.base !== "string" || !/^[0-9a-f]{7,40}$/.test(b.repo.base)) {
    return { ok: false, error: "repo.url and repo.base (a commit sha) are required" };
  }
  const t = b.task;
  if (!t || typeof t.sliceId !== "string" || typeof t.title !== "string" || typeof t.context !== "string") {
    return { ok: false, error: "task.sliceId, task.title and task.context are required" };
  }
  if (typeof b.callback !== "string" || !/^https?:\/\/.+\/jobs\/[^/]+$/.test(b.callback)) return { ok: false, error: "callback must be an http(s) URL ending in /jobs/<jobId>" };
  return {
    ok: true,
    d: {
      requires: b.requires,
      repo: { url: b.repo.url, base: b.repo.base },
      task: { sliceId: t.sliceId, title: t.title, context: t.context, handover: !!t.handover, attempt: Number(t.attempt ?? 1) || 1 },
      slice: b.slice ?? null,
      // Passed through for the workflow (classify, the scaffold's view model, the agent); never validated.
      ...(b.changes && typeof b.changes === "object" && !Array.isArray(b.changes) ? { changes: b.changes } : {}),
      ...(Array.isArray(b.sourceEvents) ? { sourceEvents: b.sourceEvents } : {}),
      callback: b.callback,
    },
  };
}

/**
 * The `requires` entries this builder cannot meet, in `requires` order. `repo:` entries must name the dispatch's
 * repository, which must be reachable; the others must be in `provides`. `provides` null (the builder definition does
 * not load, E2) skips the capability check: the job is then accepted and fails with the definition's error.
 */
export function missingRequirements(d: Dispatch, provides: string[] | null): string[] {
  const missing: string[] = [];
  const key = repoKey(d.repo.url);
  for (const r of d.requires) {
    if (r.startsWith("repo:")) {
      if (r.slice(5).replace(/\.git$/, "") !== key) missing.push(r);
    } else if (provides && !provides.includes(r)) missing.push(r);
  }
  const probe = spawnSync("git", ["ls-remote", "--exit-code", "--heads", d.repo.url], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) missing.push(`repo:${key} (cannot reach ${d.repo.url}: ${(probe.stderr || "").trim().slice(0, 200)})`);
  return missing;
}
