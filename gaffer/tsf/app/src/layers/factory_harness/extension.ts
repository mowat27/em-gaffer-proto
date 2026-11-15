/**
 * factory_harness (DESIGN 8): the required harness layer. P1: the system prompt section (prompt layer 1: the stored
 * override or system-prompt.md, untagged) and a stable identity section (no clock: a section that changes every request
 * defeats the prompt cache, DESIGN 7 "Prompt sections"). P2: the permissions-ceiling guard hook (DESIGN 8 "Ceiling",
 * T27), reading `ctx.ceiling()` at call time; the layer is required, so the guard is always selected (D7). P6 adds the
 * cron note section (`factory_harness-cron`), P7 jev_judge. P5 adds `factory_harness-custom` (prompt layer 2: the enabled custom prompts, none = omitted).
 *
 * Section keys are `<layer>-<key>`, not DESIGN's `<layer>.<key>`: pi-durable 1.5.0 rejects any section key outside
 * /^[a-z][a-z0-9_-]*$/ at `registry.install` (harness/registry.js SECTION_KEY). Layer names have no `-`, so the first
 * `-` still separates the layer from the key.
 */
import type { Extension } from "@earendil-works/pi-durable";
import { ceilingGuard } from "../../agent/ceiling.ts";
import type { LayerContext } from "../../agent/layer-context.ts";
import { once } from "../../agent/tools.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../../core/prompts.ts";
import type { JevInput, Json } from "../../shared/types.ts";

const TEMPLATE = DEFAULT_SYSTEM_PROMPT;

/** The cron note (DESIGN 8, spec 8.6). Stable text: no clock and no entry names (the prompt cache). */
export const CRON_NOTE = [
  "Some user messages are cron prompts: the factory sent them on a schedule or on the user's request (they show in the chat as 'Cron: <name>'). Nobody is waiting at the keyboard for a cron prompt.",
  "Do the work the prompt asks for with your tools, without asking questions, and end with a short note of what you did. A cron prompt that arrives while you are busy waits until the turn ends.",
  "You can manage the schedule yourself with list_crons, create_cron, update_cron, delete_cron and run_cron_now when those tools are on.",
].join("\n");

/** Replace `{{name}}` placeholders; an unknown one is left as written (a user override must never break the prompt). */
export function renderTemplate(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section, defineAppTool, obj, str, arr, opt, oneOf, map, unknown, nullable } = ctx.pi;
  const vars = (): Record<string, string> => ({
    factoryName: ctx.settings().factoryName,
    projectRoot: ctx.paths.projectRoot,
  });
  return defineExtension({
    name: "factory_harness",
    sections: [
      section(
        "factory_harness-system",
        () => renderTemplate(ctx.settings().systemPrompt ?? TEMPLATE, vars()).trim(),
        { tag: false },
      ),
      section("factory_harness-identity", () =>
        [
          `Factory: ${ctx.settings().factoryName}`,
          `Project root: ${ctx.paths.projectRoot}`,
          "Pages folder: tsf/pages (Markdown, nested folders)",
        ].join("\n"),
      ),
      section("factory_harness-cron", () => CRON_NOTE),
      section("factory_harness-custom", () => ctx.prompts().customText() || undefined),
    ],
    tools: [
      defineAppTool({
        name: "jev_judge",
        description:
          "Ask jev (TypeSafe System One) one narrow question about some text or data; fast, cheap, typed probabilities (not facts: near 0.5 or low confidence means unsure). Ask one thing per call. Fails when TYPESAFE_API_KEY is not set. kind 'noul': probability the question's statement holds (optional criteria { true, false } says what counts). kind 'choice': which of options (name -> when it applies, or null) fits; returns probabilities and confidence. kind 'score': a position on levels (2 to 10 descriptions, low to high; score 0 is the first level) with probabilities and confidence.",
        parameters: obj({
          kind: oneOf(["noul", "choice", "score"]),
          question: str({ description: "What to judge: the yes/no question, or what to choose or rate", minLength: 1, maxLength: 4_000 }),
          state: unknown({ description: "The content to judge: a string, an object or an array (not a bare number or boolean)" }),
          criteria: opt(map(str(), { description: "noul only: { true: what counts as yes, false: what counts as no }" })),
          options: opt(map(nullable(str()), { description: "choice only: option name -> description of when it applies (or null); 2 to 255 options" })),
          levels: opt(arr(str(), { description: "score only: ordered level descriptions, low to high; 2 to 10", minItems: 2, maxItems: 10 })),
        }),
        // Safe to replay: the verdict is memoised under the call, so a replay returns it without asking again.
        replay: "safe",
        run: async (args, api, c) =>
          (await once(api, "verdict", c, async () => (await ctx.service().jevJudge(args as unknown as JevInput)) as unknown as Json)) as unknown as Json,
      }),
    ],
    hooks: [ceilingGuard(() => ctx.ceiling())],
  });
}
