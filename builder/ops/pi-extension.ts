// The pi adapter of the tool core (design section 9): it registers the run's allowed ops/core tools as pi tools. The
// runner loads it (runtime/pi.ts) for an agent run whose resolved tools include a built ops/core tool; no agent.yml
// lists it. It adds no logic: every call goes through callTool with the caller `agent`, so the core checks the call
// again (the run's resolved tools within the live machine limit), validates the arguments and runs the tool.
//
// - At load: one pi tool per allowed core tool the run resolved, with the tool's own description and schema. A
//   result is the tool's value as JSON (text as is); a ToolError comes back as an error result with its message.
// - Reload: config_reload writes runs/<id>/config.json into every live run. This extension applies it between turns,
//   never in the middle of one: when a turn ends (pi sends the change before the next model request) and before a new
//   prompt starts a run. Tools the new limit leaves out are deactivated, and tools an earlier reload took away come
//   back when the limit allows them again. A run never gets more than it resolved at start (G6, D10). Each change is
//   journaled as `config.loaded`. Until then the core refuses a call the new limit leaves out.
// - Outside a run (no $BUILDER_RUN_DIR, or no readable run.json) it registers nothing.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { journalSend } from "../runtime/journal-client.ts";
import { readRunConfig } from "../runtime/run.ts";
import { AgentTools } from "./core/context.ts";
import { callTool, isToolError, registry } from "./core/index.ts";
import { allTools } from "./groups.ts";

/** A tool's value as the model reads it: a string as it is, anything else as indented JSON. */
export function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

const firstSentence = (s: string): string => /^[^.]*\.?/.exec(s)?.[0]?.trim() || s;

export default function (pi: ExtensionAPI) {
  const run = AgentTools.fromEnv();
  if (!run) return;
  const registered = new Set<string>();

  const register = (name: string) => {
    const def = registry().get(name);
    if (!def || def.stub || registered.has(name)) return;
    registered.add(name);
    pi.registerTool({
      name: def.name,
      label: def.name,
      description: def.description,
      promptSnippet: firstSentence(def.description),
      parameters: def.params,
      async execute(_toolCallId, params) {
        try {
          const out = await callTool(def.name, params, run.context());
          return { content: [{ type: "text" as const, text: resultText(out) }], details: {} };
        } catch (err) {
          const text = isToolError(err) ? (err.code === "refused" ? `refused: ${err.message}` : err.message) : err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text }], details: {}, isError: true };
        }
      },
    });
  };

  const atStart = run.allowed();
  for (const name of run.resolvedTools) if (atStart.has(name)) register(name);

  let stamp = run.stamp();
  const apply = () => {
    const now = run.stamp();
    if (now === stamp) return;
    stamp = now;
    const allowed = run.allowed();
    const known = new Set(allTools());
    const active = pi.getActiveTools();
    const removed = active.filter((t) => known.has(t) && !allowed.has(t));
    for (const t of run.resolvedTools) if (allowed.has(t)) register(t);
    const present = new Set(pi.getAllTools().map((t) => t.name));
    const added = run.resolvedTools.filter((t) => allowed.has(t) && !active.includes(t) && present.has(t));
    if (removed.length || added.length) pi.setActiveTools([...active.filter((t) => !removed.includes(t)), ...added]);
    const c = readRunConfig(run.runDir);
    journalSend({ kind: "config.loaded", data: { tools: [...allowed], removed, added, ...(c ? { loadedAt: c.loadedAt, layers: c.layers, limit: c.limit } : {}) } });
  };
  pi.on("turn_end", async () => apply());
  pi.on("before_agent_start", async () => apply());
}
