/**
 * Built-in faux rules (DESIGN 7 "Faux model") and the `TSF_FAUX_RULES` loader. Rules from the module named by
 * `TSF_FAUX_RULES` (`export const rules: FauxRule[]`) go ahead of the built-ins; tests pass theirs through
 * `OpenAgentOptions.testing.rules`, ahead of both.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FauxRule, FauxTurn } from "./faux.ts";

const is = (text: string) => (turn: FauxTurn) => turn.lastUser.toLowerCase() === text && turn.toolResults.length === 0;

/** About 2 000 tokens of text (8 000 characters at the faux provider's 4 characters per token). */
export function longTurnText(): string {
  const parts = ["Long turn: a deliberately long answer, so a test can stop the factory while it streams."];
  for (let i = 1; parts.join(" ").length < 8_000; i++) {
    parts.push(`Paragraph ${i} keeps the stream going with plain words and nothing else to see here.`);
  }
  return parts.join(" ");
}

/** The command of the `effect turn` rule: one line of effect, then a sleep long enough to kill the process in. */
export const EFFECT_COMMAND = "echo effect >> tsf/data/effects.log; sleep 6";

const PROBE = /^probe\s+([a-z][a-z0-9_]*)(?:\s+([\s\S]*))?$/;

/** `probe <tool> [<json>]`: the tool name and the argument text after it ("{}" when absent). */
function parseProbe(turn: FauxTurn): { tool: string; json: string } | undefined {
  const m = PROBE.exec(turn.lastUser);
  return m ? { tool: m[1]!, json: (m[2] ?? "").trim() || "{}" } : undefined;
}

export const BUILTIN_RULES: FauxRule[] = [
  { name: "ping", match: is("ping"), reply: () => ({ text: "pong" }) },
  { name: "long turn", match: is("long turn"), reply: () => ({ text: longTurnText() }) },
  // `effect turn` (P2): an effect outside the transcript, so the durability test can count how often it ran.
  // `tsf/data` is protected for read, write and edit only; bash can write there, which is the point.
  {
    name: "effect turn",
    match: is("effect turn"),
    reply: () => ({ toolCalls: [{ name: "bash", args: { command: EFFECT_COMMAND } }] }),
  },
  {
    name: "effect turn (after the tool)",
    match: (turn) => turn.lastUser.toLowerCase() === "effect turn" && turn.toolResults.length > 0,
    reply: () => ({ text: "effect turn done" }),
  },
  // `probe <tool> [<json>]` (P2): one call to <tool> with the JSON object after the name as its arguments, whether or
  // not the tool is offered (an unoffered call is never validated; FauxTurn carries tool names only, so the arguments
  // always come from the prompt). Used by the ceiling guard tests and the P2 integration check.
  {
    name: "probe",
    match: (turn) => parseProbe(turn) !== undefined && turn.toolResults.length === 0,
    reply: (turn) => {
      const { tool, json } = parseProbe(turn)!;
      let args: unknown;
      try {
        args = JSON.parse(json);
      } catch {
        return { text: `probe: the arguments are not valid JSON: ${json}` };
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { text: `probe: the arguments must be a JSON object: ${json}` };
      }
      return { toolCalls: [{ name: tool, args: args as Record<string, unknown> }] };
    },
  },
  {
    name: "probe (after the tool)",
    match: (turn) => parseProbe(turn) !== undefined && turn.toolResults.length > 0,
    reply: () => ({ text: "probe done" }),
  },
];

/** `TSF_FAUX_RULES` module's `rules` first, then the built-ins. */
export async function loadFauxRules(): Promise<FauxRule[]> {
  const file = process.env.TSF_FAUX_RULES?.trim();
  if (!file) return [...BUILTIN_RULES];
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { rules?: unknown };
  if (!Array.isArray(mod.rules)) throw new Error(`TSF_FAUX_RULES module ${file} does not export rules: FauxRule[]`);
  return [...(mod.rules as FauxRule[]), ...BUILTIN_RULES];
}
