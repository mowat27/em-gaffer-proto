// Job context: puts the builder job's facts into the agent's system prompt, so the agent has them without a tool
// call. builder/server.ts passes them to pi as BUILDER_* environment variables. Outside a builder job
// ($BUILDER_JOB_ID unset) nothing is added.
//
// The section is added in `before_agent_start` as `systemPromptOptions.sections.builder_job`, which Pi renders as a
// `<builder_job>` block. The halt and done files are left out: they are the tools' business, not the agent's.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The variables shown to the agent, in order, keyed by name. The agent's instructions map them to tokens. */
const FIELDS = [
  "BUILDER_SLICE_TITLE",
  "BUILDER_SLICE_CONTEXT",
  "BUILDER_SLICE_ID",
  "BUILDER_SLICE_FILE",
  "BUILDER_ATTEMPT",
  "BUILDER_BASE",
  "BUILDER_JOB_ID",
];

/** The job section's text, or null outside a builder job. */
export function jobSection(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.BUILDER_JOB_ID) return null;
  const rows = FIELDS.filter((key) => env[key]).map((key) => `| \`${key}\` | \`${env[key]}\` |`);
  return ["You are running in a builder job that builds exactly one slice.", "", "| Variable | Value |", "|---|---|", ...rows].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const section = jobSection();
    if (section) event.systemPromptOptions.sections.builder_job = section;
  });
}
