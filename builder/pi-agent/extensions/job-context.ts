// Job context: puts the builder job's facts into the agent's system prompt, so the agent has them without a tool
// call. builder/server.ts passes them to pi as BUILDER_* environment variables. Outside a builder job
// ($BUILDER_JOB_ID unset) nothing is added.
//
// The section is added in `before_agent_start` as `systemPromptOptions.sections.builder_job`, which Pi renders as a
// `<builder_job>` block. The halt and done files are left out: they are the tools' business, not the agent's.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The variables shown to the agent, in order, with their labels. */
const FIELDS: [env: string, label: string][] = [
  ["BUILDER_SLICE_TITLE", "Slice"],
  ["BUILDER_SLICE_CONTEXT", "Context"],
  ["BUILDER_SLICE_ID", "Slice id"],
  ["BUILDER_SLICE_FILE", "Slice spec file (in the working directory)"],
  ["BUILDER_ATTEMPT", "Attempt"],
  ["BUILDER_BASE", "Base commit"],
  ["BUILDER_LOGBOOK_FILE", "Logbook file"],
  ["BUILDER_JOB_ID", "Builder job id"],
];

/** The job section's text, or null outside a builder job. */
export function jobSection(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.BUILDER_JOB_ID) return null;
  const rows = FIELDS.filter(([key]) => env[key]).map(([key, label]) => `| ${label} | \`${env[key]}\` |`);
  return ["You are running in a builder job that builds exactly one slice.", "", "| Fact | Value |", "|---|---|", ...rows].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const section = jobSection();
    if (section) event.systemPromptOptions.sections.builder_job = section;
  });
}
