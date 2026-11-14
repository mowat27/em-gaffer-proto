// `halt` tool: the builder's replacement for the build kit's `/request-feedback` skill
// (@eventmodelers/cli 2.0.55, shared/skills/request-feedback/SKILL.md).
//
// The skill posts a question as a comment on the slice, marks the slice Blocked on the board, and stops work on the
// slice. The builder deliberately has no board access, so this tool stops the job instead and hands the question to
// the builder, which reports it to the gaffer as `{"outcome":"failed","reason":"<reason> Question: <question>"}`.
//
// Channel: builder/server.ts names a halt file in $BUILDER_HALT_FILE (outside the job workspace, so it never lands in
// the patch). The tool writes `{ "reason": "<reason> Question: <question>" }` there. The builder watches the file,
// stops pi when it appears and posts the failed callback with that reason verbatim. The tool result also sets `terminate`, so pi stops on its own when this
// is the only call in the batch.
//
// Dropped from the skill: connecting to the board, resolving the slice's node id, the duplicate chapter and slice
// title checks (step 2.5), the board comment and the Blocked status. The gaffer posts the reason on the slice as a
// note. Kept: the "absolute exception" rule, the wording rules for the question, the one-sentence reason (the skill's
// `statusReason`), and stopping work on the slice.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The callback reason the builder sends verbatim: the one-sentence reason, then the question. */
function feedbackReason(reason: string, question: string): string {
  return `${reason} Question: ${question}`;
}

function writeHalt(file: string, body: { reason: string }): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), "utf-8");
  renameSync(tmp, file);
}

export default function (pi: ExtensionAPI) {
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
      const reply = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text }],
        details: {},
        terminate: !isError,
        ...(isError ? { isError: true } : {}),
      });
      const reason = String(params.reason ?? "").trim();
      const question = String(params.question ?? "").trim();
      if (!reason || !question) return reply("❌ reason and question are both required", true);
      const file = process.env.BUILDER_HALT_FILE;
      if (!file) {
        return reply(`Not running in a builder job, so nothing was sent. Stop work on this slice.\nReason: ${feedbackReason(reason, question)}`);
      }
      try {
        writeHalt(file, { reason: feedbackReason(reason, question) });
      } catch (err) {
        return reply(`❌ could not hand the question to the builder: ${(err as Error).message}`, true);
      }
      return reply(`Halted. The builder stops this job and reports: "${feedbackReason(reason, question)}"\nStop work on this slice now.`);
    },
  });
}
