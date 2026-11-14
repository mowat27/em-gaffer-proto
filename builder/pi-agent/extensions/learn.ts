// `capture-learning` tool: the record path of `npx @eventmodelers/cli learn "<text>" --topic <topic>`
// (@eventmodelers/cli 2.0.55, shared/build-kit/lib/slice-learnings.js and slice-state.js) with the target file passed
// in by the caller instead of `.build-kit/AGENTS.md`.
//
// The CLI keeps learnings as events in the kit's log and regenerates AGENTS.md from them. This builder has no slice
// state and no retract or merge, so the file itself is the list: it is parsed the way the CLI adopts a hand-edited
// AGENTS.md, the learning is added unless one differing only in case or whitespace exists, and the file is rendered
// the way the CLI renders AGENTS.md (`## <topic>` groups in first-appearance order, `General` when no topic).
// Recording is refused while EVENTMODELERS_CURATING=1, as in the CLI.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Learning = { topic?: string; text: string };

// What a learnings file says as learnings (slice-learnings.js parseAgentsFile). A `##` (or deeper) heading sets the
// topic, a top-level `#` is the file's title and no topic. Bullets are learnings, and so are plain lines added after
// the list has begun, but not the paragraph a file opens with. A file with no bullets and no sub-heading is read line
// by line. Comments and fenced code are never learnings.
function parseLearnings(text: string): Learning[] {
  const items: (Learning & { introduction: boolean })[] = [];
  let topic: string | undefined;
  let fenced = false;
  let started = false;
  let structured = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.startsWith("<!--")) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (heading[1].length > 1) {
        topic = heading[2].trim() || undefined;
        started = true;
        structured = true;
      }
      continue;
    }
    const bullet = /^[-*]\s+/.test(line);
    if (bullet) {
      started = true;
      structured = true;
    }
    const learning = line.replace(/^[-*]\s+/, "").trim();
    if (learning) items.push({ topic, text: learning, introduction: !started });
  }
  return items.filter((i) => (structured ? !i.introduction : true)).map(({ topic: t, text: x }) => ({ topic: t, text: x }));
}

// Two learnings that differ only in case or whitespace are the same learning (slice-state.js learningKey).
function learningKey(text: string): string {
  return String(text).replace(/\s+/g, " ").trim().toLowerCase();
}

// The file: learnings grouped by topic in order of first appearance, one line each, duplicates dropped
// (slice-state.js renderLearnings).
function renderLearnings(learnings: Learning[]): string {
  const topics = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const { text, topic } of learnings) {
    const key = learningKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const name = topic?.trim() || "General";
    if (!topics.has(name)) topics.set(name, []);
    topics.get(name)!.push(String(text).trim());
  }
  if (!topics.size) return "";
  const body = [...topics].map(([name, lines]) => `## ${name}\n${lines.map((l) => `- ${l}`).join("\n")}\n`).join("\n");
  return `<!-- Generated from the slice-state event log. Record learnings with the learn command; do not edit. -->\n\n${body}`;
}

function writeIfChanged(path: string, content: string): void {
  if (!content) return;
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

// Records one learning. A learning the file already has is not recorded again (duplicate: true). The file is
// rewritten in the generated form either way, as the CLI does on every call.
function recordLearning(file: string, text: string, topic?: string): { duplicate: boolean } {
  const clean = String(text ?? "").trim();
  if (!clean) throw new Error("the learning is empty");
  const learnings = existsSync(file) ? parseLearnings(readFileSync(file, "utf-8")) : [];
  const duplicate = learnings.some((l) => learningKey(l.text) === learningKey(clean));
  if (!duplicate) learnings.push({ text: clean, ...(topic?.trim() ? { topic: topic.trim() } : {}) });
  writeIfChanged(file, renderLearnings(learnings));
  return { duplicate };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "capture-learning",
    label: "Capture learning",
    description:
      "Record one reusable learning (a codebase pattern, a gotcha, a command that works or doesn't, what a failed approach tried and why it failed) in a learnings file. The file is generated from the recorded learnings, never edit it by hand.",
    promptSnippet: "Record one terse reusable learning under a topic in a generated learnings file",
    promptGuidelines: [
      "Use capture-learning to record one terse line per reusable learning. capture-learning skips a learning the file already has, so call it without checking first.",
      "Never edit a file written by capture-learning with edit or write. capture-learning regenerates it from its recorded learnings.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "The learning: one terse line" }),
      topic: Type.Optional(Type.String({ description: "Group the learning under this heading in the file" })),
      file: Type.String({ description: "The learnings file, relative to the working directory or absolute" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) });
      const file = resolve(ctx.cwd, params.file);
      const shown = relative(ctx.cwd, file) || file;
      return withFileMutationQueue(file, async () => {
        try {
          // The curator may only merge and retract, an LLM asked to tidy must not add facts of its own.
          if (process.env.EVENTMODELERS_CURATING === "1") throw new Error("a curation turn only merges and retracts — new learnings are not recorded during it");
          const { duplicate } = recordLearning(file, params.text, params.topic);
          return reply(duplicate ? "ℹ️  Already recorded — nothing to add." : `✅ Recorded — ${shown} is updated.`);
        } catch (err) {
          return reply(`❌ ${(err as Error).message}`, true);
        }
      });
    },
  });
}
