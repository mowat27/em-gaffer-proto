// `done` tool: the builder's replacement for the Supabase build kit's pre-commit hook
// (@eventmodelers/cli 2.0.57, stacks/supabase/templates/build-kit/lib/check-commit-scope.cjs and lib/checks/*.cjs,
// ported in ./checks.ts).
//
// In the kit the agent commits, and the pre-commit hook rejects a slice commit that breaks a check. In the builder
// the agent never commits: builder/server.ts commits everything left in the clone after pi exits. So the checks run
// when the agent says it is finished. `done` runs all eight checks on the clone's changes since the job's base
// commit. On a violation it returns the list and the agent fixes it and calls `done` again. When every check passes
// it writes `{ "ok": true }` to $BUILDER_DONE_FILE (outside the workspace) and ends the turn. The builder sends a
// `done` callback only when that file exists, after running the same checks again. `halt` is the other way out and
// becomes a `failed` callback.
//
// tool_call hooks apply the checks that depend only on a path when the agent writes, instead of after the fact:
// - blocked-paths: write or edit of package.json, a lockfile or server.ts.
// - append-only-migrations: write or edit of a supabase/migrations/V{n}__*.sql that exists at base.
// - slice-scope: write or edit of a file outside the slice being built and the kit's exceptions. The slice being
//   built is the one already changed in the clone, so the first slice file written sets it.
// - bash commands that write (sed -i, tee, >, >>, mv, cp, patch, truncate, rm) and name a blocked path or an
//   existing migration. A path built at runtime is not seen: the check in `done` and the builder's rerun are the
//   boundary.
// The hooks are on only inside a builder job ($BUILDER_DONE_FILE is set), so `just pi` in another repo is unaffected.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  APPEND_ONLY_REASON,
  BLOCKED,
  MIGRATION_PATTERN,
  allChanges,
  builderExceptions,
  formatViolations,
  primarySliceOf,
  runChecks,
  sliceScopeReason,
} from "./checks.ts";

// Shell commands that write a file: in-place sed, tee, redirection, mv, cp, patch, truncate, rm.
const SHELL_WRITE = /\bsed\b[^|;&]*\s-i|\btee\b|\bmv\b|\bcp\b|\bpatch\b|\btruncate\b|\brm\b|>>?/;

function writeDone(file: string, body: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), "utf-8");
  renameSync(tmp, file);
}

/** The job's base commit: what the builder checked out, and what the patch is cut from. */
const base = () => process.env.BUILDER_BASE || "HEAD";

/** True when `rel` exists in the base commit. */
function existsAtBase(cwd: string, rel: string): boolean {
  try {
    // `./` makes the path relative to cwd (the app directory), not to the repository root.
    execFileSync("git", ["cat-file", "-e", `${base()}:./${rel}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Why a direct write to `rel` is refused, or null when it is allowed. `scope` adds the slice-scope check. */
function writeRefusal(cwd: string, rel: string, scope: boolean): string | null {
  const hit = BLOCKED.find((b) => b.pattern.test(rel));
  if (hit) return hit.reason;
  if (MIGRATION_PATTERN.test(rel) && existsAtBase(cwd, rel)) return APPEND_ONLY_REASON;
  if (!scope) return null;
  let changed: string[] = [];
  try {
    changed = allChanges(cwd, base()).map((c) => c.path);
  } catch {
    return null; // not a git clone: nothing to scope against
  }
  return sliceScopeReason(rel, primarySliceOf(changed), builderExceptions());
}

export default function (pi: ExtensionAPI) {
  const blocked = (rel: string, via: string, reason: string) => ({
    block: true,
    reason: `${rel}: ${reason}. Do not change it with ${via}. Every file left in the clone goes into the patch, and done refuses a job that breaks this rule. Keep slice work inside src/slices/{context}/{slice}/ and the documented exceptions.`,
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!process.env.BUILDER_DONE_FILE) return;
    const relOf = (p: string): string | null => {
      const rel = relative(ctx.cwd, resolve(ctx.cwd, String(p).replace(/^@/, "")));
      return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel; // outside the clone: not in the patch
    };

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const rel = relOf(event.input.path);
      if (!rel) return;
      const reason = writeRefusal(ctx.cwd, rel, true);
      if (reason) return blocked(rel, event.toolName, reason);
    }
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (!SHELL_WRITE.test(cmd)) return;
      for (const word of cmd.split(/[\s'"`;|&<>()]+/)) {
        if (!word || word.startsWith("-")) continue;
        const rel = relOf(word);
        if (!rel) continue;
        const reason = writeRefusal(ctx.cwd, rel, false);
        if (reason) return blocked(rel, "bash", reason);
      }
    }
  });

  pi.registerTool({
    name: "done",
    label: "Done",
    description:
      "Finish the job: run the slice commit-scope checks on everything changed in the clone and, when they pass, hand the work to the builder, which commits it and returns the patch. On a failed check, fix what it lists and call done again.",
    promptSnippet: "Finish the job: check the slice's changes and hand them to the builder",
    promptGuidelines: [
      "Call done once the slice is built, verified against the slice spec and its tests pass. The job only produces a patch through done; finishing without it fails the job.",
      "done runs the checks the build kit's pre-commit hook runs: no package.json, lockfile or server.ts changes, nothing outside src/slices/{context}/{slice}/ except the documented exceptions, existing migrations unchanged, a *.test.ts beside each command, projection or processor, no field missing from the slice spec, at least one it(...) per specification, an @openapi block above every route, and a clean `tsc --noEmit`.",
      "When done lists problems, fix each one and call done again. Never work around a check.",
      "When done succeeds, make no other tool call and stop work.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const reply = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text }],
        details: {},
        terminate: !isError,
        ...(isError ? { isError: true } : {}),
      });
      let violations;
      let changes;
      try {
        changes = allChanges(ctx.cwd, base());
        violations = runChecks(ctx.cwd, changes);
      } catch (err) {
        return reply(`❌ could not read the changes: ${(err as Error).message}`, true);
      }
      if (violations.length > 0) {
        return reply(
          `❌ done refused — slice commit-scope guard found issues:\n\n${formatViolations(violations)}\n\nFix each issue, then call done again.`,
          true,
        );
      }
      const file = process.env.BUILDER_DONE_FILE;
      if (!file) return reply(`Checks passed (${changes.length} changed file(s)). Not running in a builder job, so nothing was sent. Stop work now.`);
      try {
        writeDone(file, { ok: true, changes: changes.length });
      } catch (err) {
        return reply(`❌ could not hand the work to the builder: ${(err as Error).message}`, true);
      }
      return reply(`Checks passed (${changes.length} changed file(s)). The builder commits the changes and returns the patch. Stop work now.`);
    },
  });
}
