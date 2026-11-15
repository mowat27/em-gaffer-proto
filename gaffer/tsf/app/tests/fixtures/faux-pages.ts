/**
 * Faux rules for the page demo (acceptance 3): `TSF_FAUX_RULES=tests/fixtures/faux-pages.ts`, or `createTestFactory({
 * rules })`. The prompt "Explain the basics of Python, TypeScript and Rust in nested folders in our pages." creates
 * Languages/{Python,TypeScript,Rust}/Basics.md with three create_page calls, then selects one page, then answers.
 */
import type { FauxRule, FauxTurn } from "../../src/agent/faux.ts";

export const PAGES_PROMPT = "Explain the basics of Python, TypeScript and Rust in nested folders in our pages.";

export const LANGUAGES = [
  {
    folder: "Python",
    text: [
      "# Python basics",
      "",
      "Python is a dynamically typed language with significant indentation.",
      "",
      "```python",
      "def greet(name: str) -> str:",
      '    return f"Hello, {name}"',
      "```",
      "",
      "- Lists, dicts and sets are built in.",
      "- `pip` installs packages; `venv` isolates them.",
      "",
    ].join("\n"),
  },
  {
    folder: "TypeScript",
    text: [
      "# TypeScript basics",
      "",
      "TypeScript is JavaScript with a static type system that is erased at build time.",
      "",
      "```ts",
      "const greet = (name: string): string => `Hello, ${name}`;",
      "```",
      "",
      "- Interfaces and unions describe shapes.",
      "- `tsc` checks types; a bundler or runtime runs the output.",
      "",
    ].join("\n"),
  },
  {
    folder: "Rust",
    text: [
      "# Rust basics",
      "",
      "Rust is a compiled language with ownership and borrowing instead of a garbage collector.",
      "",
      "```rust",
      'fn greet(name: &str) -> String { format!("Hello, {name}") }',
      "```",
      "",
      "- `cargo` builds, tests and manages crates.",
      "- `Result` and `Option` replace exceptions and null.",
      "",
    ].join("\n"),
  },
] as const;

/** The page the demo selects. */
export const SELECTED_PAGE = "Languages/Python/Basics.md";

const asked = (turn: FauxTurn): boolean => turn.lastUser === PAGES_PROMPT;
const used = (turn: FauxTurn, name: string): boolean => turn.toolResults.some((r) => r.name === name);

export const rules: FauxRule[] = [
  {
    name: "pages demo: create the pages",
    match: (turn) => asked(turn) && turn.toolResults.length === 0,
    reply: () => ({
      text: "I will write one page per language in its own folder.",
      toolCalls: LANGUAGES.map((l) => ({
        name: "create_page",
        args: { path: `Languages/${l.folder}/Basics.md`, content: l.text },
      })),
    }),
  },
  {
    name: "pages demo: select one",
    match: (turn) => asked(turn) && used(turn, "create_page") && !used(turn, "select_page"),
    reply: () => ({ toolCalls: [{ name: "select_page", args: { path: SELECTED_PAGE } }] }),
  },
  {
    name: "pages demo: done",
    match: (turn) => asked(turn) && used(turn, "select_page"),
    reply: () => ({ text: "I added Languages/Python, Languages/TypeScript and Languages/Rust, each with a Basics page, and opened the Python one." }),
  },
];
