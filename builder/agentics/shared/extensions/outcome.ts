// Outcome: how an agent run ends. `done` hands the work over, `halt` stops with a question for a human, and the
// settle nudge sends an agent back when it tries to stop with neither (E18).
//
// done: the builder's replacement for the Supabase build kit's pre-commit hook (@eventmodelers/cli 2.0.57,
// stacks/supabase/templates/build-kit/lib/check-commit-scope.cjs and lib/checks/*.cjs, ported in
// agentics/builders/supabase-api/checks.ts). In the kit the agent commits and the hook rejects a slice commit that
// breaks a check. Here the agent never commits: the workflow's commit step commits everything left in the clone. So
// the checks run when the agent says it is finished. `done` runs all eight checks on the clone's changes since the
// job's base commit ($BUILDER_BASE). On a violation it returns the list and the agent fixes it and calls `done` again.
// When every check passes it writes `{ "ok": true }` to $BUILDER_DONE_FILE (the run's folder, outside the workspace)
// and ends the turn. The run is done only when that file exists, and the workflow reruns the same checks.
//
// halt: the builder's replacement for the build kit's `/request-feedback` skill (@eventmodelers/cli 2.0.55,
// shared/skills/request-feedback/SKILL.md). The skill posts a question on the slice, marks it Blocked and stops work.
// The builder has no board access, so this tool writes `{ "reason": "<reason> Question: <question>" }` to
// $BUILDER_HALT_FILE instead. The runner stops pi when it appears and the run fails with that reason verbatim, which
// a server job reports to the gaffer as `{"outcome":"failed","reason":...}`. Dropped from the skill: the board, the
// node id lookup, the duplicate checks, the comment and the Blocked status. Kept: the "absolute exception" rule, the
// wording rules for the question, the one-sentence reason, and stopping work.
//
// settle nudge: when pi is about to settle (`agent_before_settle`) in a run with a dispatch (a job: $BUILDER_JOB_ID)
// and neither done nor halt has handed the work over, the agent is sent back with "Call done to hand over the work, or
// halt with a reason." at most twice. After that pi settles and the run fails with `the agent finished without calling
// done`, as before. A nudged agent still goes through done, so the checks still run. Not in an interactive session (the
// person at the TUI decides when to stop), and not in a run without a dispatch: that run is done when pi exits cleanly
// (runtime/pi.ts), so an agent that enables outcome only for the children it starts is never sent back.
//
// journal: each nudge is journaled as `outcome.nudge { n, max }`, and a done or halt that hands the work over as
// `agent.outcome { outcome: "done", changes } | { outcome: "halt", reason }` (a no-op in a run without a journal).

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { allChanges, formatViolations, runChecks } from "../../builders/supabase-api/checks.ts";
import { journalSend } from "../../../runtime/journal-client.ts";

export const NUDGE = "Call done to hand over the work, or halt with a reason.";
export const MAX_NUDGES = 2;

function writeAtomic(file: string, body: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), "utf-8");
  renameSync(tmp, file);
}

/** The job's base commit: what the builder checked out, and what the patch is cut from. */
const base = () => process.env.BUILDER_BASE || "HEAD";

/** The callback reason the builder sends verbatim: the one-sentence reason, then the question. */
export function feedbackReason(reason: string, question: string): string {
  return `${reason} Question: ${question}`;
}

export interface SettleState {
  /** pi's ctx.mode: "tui", "rpc", "json" or "print". */
  mode: string;
  /** done handed the work over (its file exists, or it succeeded in this process). */
  done: boolean;
  /** halt was called (its file exists, or it succeeded in this process). */
  halted: boolean;
  /** Nudges already sent in this run. */
  nudges: number;
  /** The run carries a dispatch (a job): it ends only through done or halt. */
  dispatch: boolean;
}

/** Whether to send the agent back when it is about to settle. */
export function shouldNudge(s: SettleState, max = MAX_NUDGES): boolean {
  return s.dispatch && s.mode !== "tui" && !s.done && !s.halted && s.nudges < max;
}

const fileSet = (name: string) => {
  const f = process.env[name];
  return !!f && existsSync(f);
};

export default function (pi: ExtensionAPI) {
  let doneCalled = false;
  let haltCalled = false;
  let nudges = 0;

  const reply = (text: string, isError = false) => ({
    content: [{ type: "text" as const, text }],
    details: {},
    terminate: !isError,
    ...(isError ? { isError: true } : {}),
  });

  pi.registerTool({
    name: "done",
    label: "Done",
    description:
      "Finish the job: run the slice commit-scope checks on everything changed in the clone and, when they pass, hand the work to the builder, which commits it and returns the patch. On a failed check, fix what it lists and call done again.",
    promptSnippet: "Finish the job: check the slice's changes and hand them to the builder",
    promptGuidelines: [
      "Call done once the slice is built, verified against the slice spec and its tests pass. The job only produces a patch through done; finishing without it fails the job.",
      "done runs the checks the build kit's pre-commit hook runs: no package.json, lockfile or server.ts changes, nothing outside src/slices/{context}/{slice}/ except the documented exceptions, existing migrations unchanged, a *.test.ts beside each command, projection or processor, no field missing from the slice spec, at least one it(...) per specification, an @openapi block above every route, no `BUILD:` marker left from the scaffold, and a clean `tsc --noEmit`.",
      "When done lists problems, fix each one and call done again. Never work around a check.",
      "When done succeeds, make no other tool call and stop work.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      let violations;
      let changes;
      try {
        changes = allChanges(ctx.cwd, base());
        violations = runChecks(ctx.cwd, changes);
      } catch (err) {
        return reply(`❌ could not read the changes: ${(err as Error).message}`, true);
      }
      if (violations.length > 0) {
        return reply(`❌ done refused — slice commit-scope guard found issues:\n\n${formatViolations(violations)}\n\nFix each issue, then call done again.`, true);
      }
      const file = process.env.BUILDER_DONE_FILE;
      doneCalled = true;
      if (!file) return reply(`Checks passed (${changes.length} changed file(s)). Not running in a builder run, so nothing was sent. Stop work now.`);
      try {
        writeAtomic(file, { ok: true, changes: changes.length });
      } catch (err) {
        doneCalled = false;
        return reply(`❌ could not hand the work to the builder: ${(err as Error).message}`, true);
      }
      journalSend({ kind: "agent.outcome", data: { outcome: "done", changes: changes.length } });
      return reply(`Checks passed (${changes.length} changed file(s)). The builder commits the changes and returns the patch. Stop work now.`);
    },
  });

  pi.registerTool({
    name: "halt",
    label: "Halt",
    description:
      "Stop building this slice and hand a question to a human, ONLY when the slice literally cannot be built, even with reasonable assumptions. The absolute exception: for unclear or missing details, assume and build instead.",
    promptSnippet: "Stop the build and ask a human, only when the slice literally cannot be built",
    promptGuidelines: [
      "The default is to assume and build. Before calling halt, read the slice spec fully and the build skill's instructions. For a missing example value, field type, name or status, a dependency that isn't built yet, or a style choice, pick the most sensible interpretation, build, and record each assumption as a one-line code comment instead of calling halt.",
      "Call halt only when nothing runnable and tested can be produced: for example the slice has no elements at all, or two parts of it contradict each other so no single implementation satisfies both. When in doubt, build.",
      "halt ends the job. Make no other tool call in the same turn, and stop work after it returns.",
      "In halt, write the question so a human reading it cold understands the gap: name the slice, name the specific field, rule or scenario, and say what is missing or contradictory.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "One sentence: what is missing or contradictory" }),
      question: Type.String({
        description: "The specific question or decision needed, naming the slice and the field, rule or scenario in question",
      }),
    }),
    async execute(_toolCallId, params) {
      const reason = String(params.reason ?? "").trim();
      const question = String(params.question ?? "").trim();
      if (!reason || !question) return reply("❌ reason and question are both required", true);
      const file = process.env.BUILDER_HALT_FILE;
      haltCalled = true;
      if (!file) return reply(`Not running in a builder run, so nothing was sent. Stop work on this slice.\nReason: ${feedbackReason(reason, question)}`);
      try {
        writeAtomic(file, { reason: feedbackReason(reason, question) });
      } catch (err) {
        haltCalled = false;
        return reply(`❌ could not hand the question to the builder: ${(err as Error).message}`, true);
      }
      journalSend({ kind: "agent.outcome", data: { outcome: "halt", reason: feedbackReason(reason, question) } });
      return reply(`Halted. The builder stops this job and reports: "${feedbackReason(reason, question)}"\nStop work on this slice now.`);
    },
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const state: SettleState = { mode: ctx.mode, done: doneCalled || fileSet("BUILDER_DONE_FILE"), halted: haltCalled || fileSet("BUILDER_HALT_FILE"), nudges, dispatch: !!process.env.BUILDER_JOB_ID };
    if (!shouldNudge(state)) return;
    nudges++;
    // The journal records the nudge; stderr keeps it in the run's log beside pi's output.
    journalSend({ kind: "outcome.nudge", data: { n: nudges, max: MAX_NUDGES, message: NUDGE } });
    process.stderr.write(`[outcome] nudge ${nudges}/${MAX_NUDGES}: the agent tried to stop without done or halt\n`);
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: "outcome-nudge", content: NUDGE, display: true }],
      continue: true,
    };
  });
}
