/**
 * Faux rules for the e2e demo (`TSF_FAUX_RULES=tests/fixtures/faux-demo.ts`; they go ahead of the built-ins, which
 * still answer `long turn` and `probe <tool> <json>`):
 * - `ping` answers `pong`.
 * - `tool demo` calls `list_pages {}` once, then answers `listed`.
 * - acceptance 4: `LIST_TOOLS_PROMPT` calls `list_tools {}` once, then answers `LIST_TOOLS_REPLY`.
 * - acceptance 5: `DISABLE_CODING_PROMPT` calls `set_tool_enabled` off for read, write, edit and bash and
 *   `set_thinking_level` max in one message, then answers `DISABLE_CODING_REPLY`.
 * - acceptance 9: `CRON_PROMPT` (the cron prompt) calls `list_pages {}`, then creates `Languages/<language>/Concept <n>.md`
 *   in each language folder, where n is one more than the highest `Concept <n>` the listing shows (so every run adds
 *   a new page, each name is unique per slot, and a regenerated request after a crash answers the same), then answers.
 * - the page demo prompt (acceptance 3) creates four folders in one message, then three pages, then selects the
 *   Python page, then summarises. Each step keys on which tool results exist after the last user message.
 */
import type { FauxRule, FauxTurn } from "../../src/agent/faux.ts";
import { LANGUAGES, PAGES_PROMPT, SELECTED_PAGE } from "./faux-pages.ts";

export { PAGES_PROMPT as EXPLAIN_PROMPT, SELECTED_PAGE };

const lower = (turn: FauxTurn, text: string): boolean => turn.lastUser.toLowerCase() === text;
const used = (turn: FauxTurn, name: string): boolean => turn.toolResults.some((r) => r.name === name);
const asked = (turn: FauxTurn): boolean => turn.lastUser === PAGES_PROMPT;

export const LIST_TOOLS_PROMPT = "List your tools.";
export const LIST_TOOLS_REPLY = "These are my tools, grouped by layer.";
export const DISABLE_CODING_PROMPT = "Disable all coding tools and set thinking to max.";
export const DISABLE_CODING_REPLY = "The coding tools are off and thinking is max.";
export const CODING_TOOLS = ["read", "write", "edit", "bash"] as const;

export const CRON_PROMPT = "Add a new concept page to each language folder under Languages.";
export const CRON_REPLY = "I added a new concept page to each language folder.";

/** One more than the highest `Concept <n>.md` in the `list_pages` result of this turn. */
export function nextConcept(turn: FauxTurn): number {
  const listing = turn.toolResults.find((r) => r.name === "list_pages")?.text ?? "";
  let max = 0;
  for (const m of listing.matchAll(/Concept (\d+)\.md/g)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

export const FOLDERS = ["Languages", ...LANGUAGES.map((l) => `Languages/${l.folder}`)] as const;

export const rules: FauxRule[] = [
  { name: "demo: ping", match: (t) => lower(t, "ping") && t.toolResults.length === 0, reply: () => ({ text: "pong" }) },
  {
    name: "demo: tool demo",
    match: (t) => lower(t, "tool demo") && t.toolResults.length === 0,
    reply: () => ({ text: "I will list the pages.", toolCalls: [{ name: "list_pages", args: {} }] }),
  },
  {
    name: "demo: tool demo (after the tool)",
    match: (t) => lower(t, "tool demo") && used(t, "list_pages"),
    reply: () => ({ text: "listed" }),
  },
  {
    name: "demo: list tools",
    match: (t) => t.lastUser === LIST_TOOLS_PROMPT && t.toolResults.length === 0,
    reply: () => ({ text: "I will list them.", toolCalls: [{ name: "list_tools", args: {} }] }),
  },
  {
    name: "demo: list tools (after the tool)",
    match: (t) => t.lastUser === LIST_TOOLS_PROMPT && used(t, "list_tools"),
    reply: () => ({ text: LIST_TOOLS_REPLY }),
  },
  {
    name: "demo: disable coding tools, thinking max",
    match: (t) => t.lastUser === DISABLE_CODING_PROMPT && t.toolResults.length === 0,
    reply: () => ({
      text: "Switching them off.",
      toolCalls: [
        ...CODING_TOOLS.map((name) => ({ name: "set_tool_enabled", args: { name, enabled: false } })),
        { name: "set_thinking_level", args: { level: "max" } },
      ],
    }),
  },
  {
    name: "demo: disable coding tools (after the tools)",
    match: (t) => t.lastUser === DISABLE_CODING_PROMPT && used(t, "set_thinking_level"),
    reply: () => ({ text: DISABLE_CODING_REPLY }),
  },
  {
    name: "demo: cron, list the pages",
    match: (t) => t.lastUser === CRON_PROMPT && t.toolResults.length === 0,
    reply: () => ({ text: "I will look at the pages first.", toolCalls: [{ name: "list_pages", args: {} }] }),
  },
  {
    name: "demo: cron, add a concept page to each language",
    match: (t) => t.lastUser === CRON_PROMPT && used(t, "list_pages") && !used(t, "create_page"),
    reply: (t) => {
      const n = nextConcept(t);
      return {
        text: `Adding concept ${n}.`,
        toolCalls: LANGUAGES.map((l) => ({
          name: "create_page",
          args: { path: `Languages/${l.folder}/Concept ${n}.md`, content: `# ${l.folder} concept ${n}\n\nA concept page added on schedule.\n` },
        })),
      };
    },
  },
  {
    name: "demo: cron, summary",
    match: (t) => t.lastUser === CRON_PROMPT && used(t, "create_page"),
    reply: () => ({ text: CRON_REPLY }),
  },
  {
    name: "demo: explain, create the folders",
    match: (t) => asked(t) && t.toolResults.length === 0,
    reply: () => ({
      text: "I will set up the folders first.",
      toolCalls: FOLDERS.map((path) => ({ name: "create_folder", args: { path } })),
    }),
  },
  {
    name: "demo: explain, create the pages",
    match: (t) => asked(t) && used(t, "create_folder") && !used(t, "create_page"),
    reply: () => ({
      text: "Now one page per language.",
      toolCalls: LANGUAGES.map((l) => ({ name: "create_page", args: { path: `Languages/${l.folder}/Basics.md`, content: l.text } })),
    }),
  },
  {
    name: "demo: explain, select the Python page",
    match: (t) => asked(t) && used(t, "create_page") && !used(t, "select_page"),
    reply: () => ({ toolCalls: [{ name: "select_page", args: { path: SELECTED_PAGE } }] }),
  },
  {
    name: "demo: explain, summary",
    match: (t) => asked(t) && used(t, "select_page"),
    reply: () => ({
      text: "I added Languages/Python, Languages/TypeScript and Languages/Rust, each with a Basics page, and opened the Python one.",
    }),
  },
];
