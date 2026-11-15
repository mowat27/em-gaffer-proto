---
name: import-from-build-kit
description: Import code and agentics from the @eventmodelers/cli and its build kits into this project's builder agent as like-for-like ports. Use when porting a CLI command, build-kit script, or build-kit behaviour into builder/pi-agent, when the user asks to extract a tool from an eventmodelers CLI command, or when the builder agent must be stopped from writing a file directly with a tool_call hook.
argument-hint: "[mode] [cli command and requirements]"
---

# Import from build kit

Port behaviour from the `@eventmodelers/cli` package and its build kits into the builder's Pi agent
(`builder/pi-agent/`). Every port is translated from the CLI's source code, never from its `--help` text or
docs. The port is checked against the CLI module itself before it is reported.

## Modes

| Mode | What it does | Typical invocation |
|------|--------------|--------------------|
| `tool` | Port one CLI command to a Pi extension tool in `builder/pi-agent/extensions/` | "tool `learn \"<text>\" --topic <topic>`, write to a file the caller passes in, call it capture-learning" |
| `guard` | Add a `tool_call` hook that blocks direct writes to a file and points the agent at the tool to use | "guard the learnings files, use capture-learning" |

## Recipes

| Mode | Recipe |
|------|--------|
| `tool` | `cookbook/tool.md` |
| `guard` | `cookbook/guard.md` |

All recipe paths are relative to this skill's directory.

## Shared Context

Every recipe relies on these facts. Verify any that a recipe depends on before acting on it.

- **CLI source.** The installed package is in the npx cache: `~/.npm/_npx/*/node_modules/@eventmodelers/cli`.
  Several versions may exist. Choose the highest `version` in `package.json`, not the newest directory. Commands
  are declared in `cli.js` with `.command('<name> ...')`. Logic lives in `shared/build-kit/lib/*.js`. Kit
  templates live in `stacks/<stack>/templates/build-kit/`.
- **Build kit model.** A build kit is a `.build-kit/` directory in the target repo, driven by the CLI's run loop.
  Kit commands share one local event log (`.build-kit/events/`, `events.log`, `events.seq`) that holds slice
  state, tasks, prompts and learnings. Files such as `.build-kit/AGENTS.md` are projections regenerated from that
  log. With `--sync`, events that name a slice are uploaded to the board.
- **Builder agent model.** The builder (`builder/server.ts`) runs one `pi` process per job with the isolated agent
  dir `builder/pi-agent/` (`PI_CODING_AGENT_DIR`). Pi's cwd is a fresh clone of the target repo. The builder has
  no slice state, no event log, no board connection and no kit agent config. Extensions load only from
  `builder/pi-agent/extensions/`. The `tsf/pages/Builder/Agent/` pages are copied into the agent dir only for
  `AGENTS.md` and `prompts/build.md`.
- **Pi reference.** `tsf/pages/ai-docs/pi.md` covers the extension API (section 8) and tools (section 5).

---

## Dispatch

Parse `$ARGUMENTS`. When the first token is a mode, it is the **MODE** and the rest is the **USER_PROMPT**.

Otherwise, read the request together with the conversation and map it onto modes. A request can name several
modes, or none, e.g. "build the new tools and hooks":

- Each tool to port is one `tool` run. Each set of files to protect is one `guard` run.
- Run a tool before any guard that points at it. When a guard's TOOL_NAME is a tool from the same request, the
  guard goes into that tool's extension.
- Decisions already agreed in the conversation (tool names, changed paths, dropped kit machinery) are CHANGES and
  answer the divergence gate. Ask only about a divergence the conversation has not settled.
- A build-kit script (e.g. `stacks/<stack>/templates/build-kit/lib/*.cjs`) is ported like a CLI command: its file
  takes the place of the `.command(...)` block.
- Wiring a port needs to work outside `builder/pi-agent/extensions/` (an env var or check in `builder/server.ts`,
  a line in `prompts/build.md`) is part of the run. Report it separately.

Only when nothing in the request maps onto a mode, list the modes above and stop.

---

### `tool` mode

1. Read `cookbook/tool.md`
2. From USER_PROMPT, take the CLI command and flags to port (**COMMAND**), the requested tool name if given
   (**TOOL_NAME**), and any requested changes from the CLI's behaviour, such as a hard-coded path made a
   parameter (**CHANGES**)
3. Execute the recipe
4. Return the results

---

### `guard` mode

1. Read `cookbook/guard.md`
2. From USER_PROMPT, take what to protect (**TARGET**) and the tool the agent must use instead (**TOOL_NAME**)
3. Execute the recipe
4. Return the results
