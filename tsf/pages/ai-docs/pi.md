# Configuring a Pi agent (harness engineering guide)

Audience: an agent or engineer that configures a plain Pi agent: system prompt, tools, skills, prompt templates, hooks (extensions), MCP, and packages. Plain means one `pi` process with no durable-execution layer around it.

Source: the Pi docs at `packages/coding-agent/docs/` in https://github.com/earendil-works/pi (main, read 2026-11-13), plus `src/core/system-prompt.ts` and `examples/`. Pi changes quickly. Confirm flags with `pi --help` and settings with the schema at `https://pi.dev/schemas/settings.schema.json`.

Doc base URL: `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/` (`configuration.md`, `settings.md`, `extensions.md`, `skills.md`, `prompt-templates.md`, `mcp.md`, `packages.md`, `cli.md`, `sdk.md`, `security.md`, `compaction.md`).

## 1. Mental model

- F1. Pi has no built-in hooks file, permission system, sub-agents, or plan mode. All of these are extensions: TypeScript modules loaded into the Pi process. Pi ships examples for most (`examples/extensions/`: `permission-gate.ts`, `protected-paths.ts`, `subagent/`, `plan-mode/`, `preset.ts`).
- F2. The agent loop: input, then `before_agent_start`, then turns. A turn is one model request plus the tool calls in its response. The run ends when no tool results or queued messages need another request.
- F3. The model request is built from: system prompt, active session branch, tool declarations, skill descriptions. Skill bodies load on demand.
- F4. Extensions, tools, and everything Pi spawns run with the OS permissions of the Pi process. Project trust and the transcript are not a sandbox. Isolation comes from the environment you run Pi in (container, VM, dedicated user).

### Which mechanism to use

| Need | Mechanism | Cost |
|---|---|---|
| Standing instructions for every run | `AGENTS.md` / `APPEND_SYSTEM.md` | Always in context |
| Replace Pi's identity and default rules | `SYSTEM.md` or `--system-prompt` | Always in context |
| Reusable prompt text with arguments | Prompt template (`prompts/*.md`) | None until invoked |
| Procedure with scripts and references, loaded when relevant | Skill (`skills/<name>/SKILL.md`) | Description only until loaded |
| Block, rewrite, or observe tool calls and results | Extension `tool_call` / `tool_result` handlers | Code |
| Add a tool the model can call | Extension `pi.registerTool()` or MCP server | Code or a server |
| Change what the model sees per run | Extension `before_agent_start` / `context` | Code |
| Force a follow-up before the run ends | Extension `agent_before_settle` | Code |
| Share any of the above | Pi package | npm or git |

Pick the smallest mechanism that works. Text files first, then skills, then extensions.

### Claude Code concept map

| Claude Code | Pi |
|---|---|
| `CLAUDE.md` | `AGENTS.md` (Pi also reads `CLAUDE.md`) |
| `PreToolUse` hook | extension `tool_call` (return `{ block: true, reason }`) |
| `PostToolUse` hook | extension `tool_result` |
| `UserPromptSubmit` hook | extension `input` or `before_agent_start` |
| `Stop` hook | extension `agent_before_settle` (return `continue: true`) |
| `SessionStart` hook | extension `session_start` |
| `PreCompact` hook | extension `session_before_compact` |
| `settings.json` permissions | none built in. Write a `tool_call` gate |
| `.claude/agents` | none built in. See `examples/extensions/subagent/` |

## 2. Files and precedence

`<agent-dir>` defaults to `~/.pi/agent`. Override with `PI_CODING_AGENT_DIR` or the SDK `agentDir` option. Project config lives in `.pi/` under the working directory.

| Path (agent dir, or `.pi/` for project) | Purpose |
|---|---|
| `settings.json` | Settings, resource paths, packages |
| `mcp.json` | MCP servers |
| `SYSTEM.md` | Replace the default system prompt |
| `APPEND_SYSTEM.md` | Append to the system prompt |
| `extensions/` | Extensions |
| `skills/` | Skills |
| `prompts/` | Prompt templates |
| `themes/` | Themes |
| agent dir only: `models.json`, `auth.json`, `keybindings.json` | Models/endpoints, credentials, keys |
| agent dir or any cwd ancestor: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` | Context files |

Rules:

1. Project settings override user settings. Resource lists (`extensions`, `skills`, `prompts`, `themes`, `packages`) combine.
2. For `SYSTEM.md` and `APPEND_SYSTEM.md`, a trusted project file wins over the agent-dir file. They are not merged.
3. `AGENTS.override.md` replaces `AGENTS.md`/`CLAUDE.md` only in the same directory.
4. Context files load from the agent dir, the cwd, and parent directories. They load regardless of project trust.
5. `/reload` re-reads settings, extensions, skills, templates, themes, and context files in an interactive session.

### Project trust (headless gotcha)

Project `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and `.agents/skills` load only after the project is trusted.

- Interactive: Pi asks. `/trust` saves the decision in `~/.pi/agent/trust.json`.
- Print, JSON, and RPC modes cannot prompt. With `defaultProjectTrust: "ask"` (default) or `"never"` they silently skip all project resources.
- Fix for automation: pass `--approve` per run, set `defaultProjectTrust: "always"` in agent-dir settings (it cannot be set in project settings), or put the configuration in the agent dir and point `PI_CODING_AGENT_DIR` at it.
- Context files (`AGENTS.md`, `CLAUDE.md`) are not trust-gated. Treat their contents as untrusted input.

## 3. Running Pi as a harness target

```sh
pi -p "prompt"                       # print mode: final text on stdout, exit non-zero on error/aborted
pi --mode json "prompt" > ev.jsonl   # JSONL events, one run. Check events for failure, exit code is not enough
pi --mode rpc --no-session           # long-lived, JSONL commands on stdin
```

Useful flags for a controlled run:

| Goal | Flag |
|---|---|
| No persisted session | `--no-session` |
| Isolated config | `PI_CODING_AGENT_DIR=/path` |
| Isolated sessions | `--session-dir <dir>` / `PI_CODING_AGENT_SESSION_DIR` |
| Model and thinking | `--provider p --model m --thinking high`, or `--model provider/id:high` |
| Tool allowlist | `--tools read,grep,find,ls` |
| Remove tools | `--exclude-tools 'mcp__*'`, `--no-builtin-tools`, `--no-tools` |
| Load only what you name | `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-themes`, then add `-e`, `--skill`, `--prompt-template` |
| System prompt | `--system-prompt <text\|file>`, `--append-system-prompt <text\|file>` (repeatable) |
| Trust project files | `--approve` / `--no-approve` |
| No network chatter | `--offline` |

`--no-*` flags disable discovery. Explicit `-e`, `--skill`, and `--prompt-template` paths still load.

Extensions see `ctx.mode` (`tui`, `rpc`, `json`, `print`) and `ctx.hasUI`. In print and JSON modes UI calls (`confirm`, `select`) cannot ask a human, so gates must decide on their own and fail closed.

Completion signal: `agent_settled`. `agent_end` is not final because retries, compaction retries, and queued messages can start another run.

Embedding in TypeScript instead of spawning a process: `createAgentSession()` from `@earendil-works/pi-coding-agent` (see section 11).

## 4. Controlling the system prompt

### Layers, in the order Pi builds them

From `src/core/system-prompt.ts`. Each section is rendered as `<name>…</name>` except `preamble`.

| Section | Source | Present when |
|---|---|---|
| `preamble` | Default coding-assistant sentence, or `SYSTEM.md` / `--system-prompt` | always |
| `tools` | One-line `promptSnippet` per active tool | default prompt only |
| `rules` | Tool `promptGuidelines`, extension `promptGuidelines`, built-in rules | default prompt only |
| `docs` | Pointers to Pi's own docs | default prompt only |
| `addendum` | `APPEND_SYSTEM.md`, `--append-system-prompt` | when set |
| `project_context` | `AGENTS.md` / `CLAUDE.md` files as `<project_instructions path=…>` | when files exist |
| `skills` | Skill names, descriptions, paths | skills exist and a reader tool (`read` or `bash`) is active |
| `cwd` | Working directory | always |
| custom sections | `systemPromptOptions.sections` from extensions | when set |

### D1. Replacing the prompt drops `tools`, `rules`, and `docs`

When `SYSTEM.md` or `--system-prompt` is set, only `preamble` is replaced, and the default `tools`, `rules`, and `docs` sections disappear. Tool declarations still reach the model through the provider's tool definitions, but one-line tool snippets and rule bullets (`promptGuidelines`) are not rendered. If your tools rely on guidelines, restate that guidance in `SYSTEM.md`, or add it as an extension `section`.

Append, context files, skills, `cwd`, and custom sections are kept.

### Choose the lightest control

1. O1. `AGENTS.md` for project facts and conventions. Read automatically, travels with the repo.
2. O2. `APPEND_SYSTEM.md` or `--append-system-prompt` for instructions that must sit before project context and apply to every run of this harness.
3. O3. `SYSTEM.md` or `--system-prompt` when the agent is not a general coding assistant. Accept D1.
4. O4. An extension adding a named section or per-run changes, when content depends on state (active tools, mode, repo).

### Extension-controlled prompt (preferred over rewriting the string)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    // Structured options: edit in place. Section names match /^[a-z][a-z0-9_-]*$/ and cannot be "preamble".
    event.systemPromptOptions.sections.build_rules = "- Run `npm test` before finishing.";
    // Also available: selectedTools, toolSnippets, toolGuidelines, promptGuidelines,
    // appendSystemPrompt, contextFiles, skills, customPrompt, cwd.
  });
}
```

- Editing `sections`, `selectedTools`, or `promptGuidelines` lets Pi send a small patch and keep the provider cache for models that accept mid-conversation system messages.
- Returning `{ systemPrompt }` or setting `forceSystemPrompt` replaces the whole prompt for that run. The next change is a cache miss.
- `before_agent_start` can also return `{ message: { customType, content, display } }` to inject a persistent message into the session.
- Handlers chain in load order. `event.systemPrompt` and `ctx.getSystemPrompt()` show the chained value so far.
- Per-request edits of the full transcript including the system message: `context_with_system` (must keep a system message at index 0). Raw payload rewrites: `before_provider_request`. `ctx.getSystemPrompt()` does not reflect payload rewrites.

### Verify what the model gets

Do not assume. Dump it:

```ts
import { writeFileSync } from "node:fs";

pi.on("before_agent_start", (_e, ctx) => {
  writeFileSync("/tmp/pi-system-prompt.txt", ctx.getSystemPrompt());
});
```

In the SDK, read `session.systemPrompt`. `before_provider_request` shows the final provider payload.

## 5. Tools

Built-in tools: `read`, `bash`, `edit`, `write` (default on), plus `grep`, `find`, `ls`, `powershell`. Built-in extensions add `codemode` and `tool_search`, off by default.

Selection, highest precedence first:

1. CLI: `--no-tools`, `--tools a,b` (plain names replace the set; `*` patterns allowed), `--exclude-tools` (applied last, includes MCP), `--no-builtin-tools`.
2. Settings `defaultTools`: plain names replace the defaults. `+name` / `-name` entries adjust them. Example: `"defaultTools": ["read", "grep", "find", "ls"]` for a read-only agent, or `["+codemode"]` to add one.
3. Project `defaultTools` with only `+`/`-` entries changes the user's selection. A plain-name list replaces it.

Notes:

- `--tools` and `defaultTools` choose which tools are declared to the model. MCP tools stay reachable according to their own `exposure` (section 9) unless a `--tools` entry starts with `mcp__`.
- `/reload` enables tools newly added to `defaultTools`. It does not disable tools you removed.
- A read-only agent with `--tools read,grep,find,ls` still runs as the OS user. If bash is not in the list, no shell is reachable through built-ins, but extension and MCP tools still can be.

### Override a built-in tool

Register a tool with the same name (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`) from an extension. The result shape, including `details`, must match the built-in. `promptSnippet` and `promptGuidelines` are not inherited, so redefine them. Rendering is inherited per slot. See `examples/extensions/tool-override.ts`.

### Custom tool

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    promptSnippet: "Greet a person by name",            // one line in <tools>
    promptGuidelines: ["Use greet when the user asks to greet someone."], // names the tool explicitly
    parameters: Type.Object({ name: Type.String({ description: "Name to greet" }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
    },
  });
}
```

Rules:

- `promptGuidelines` are appended flat to `<rules>`. Name the tool in every bullet. "Use this tool when…" is ambiguous.
- Arguments are validated as JSON Schema with light coercion (numeric strings to numbers, and so on). `Type.Refine`, codecs, and custom formats do not run. Check those in `execute()`.
- Tools mutating files must wrap the whole read-modify-write in `withFileMutationQueue(absolutePath, fn)`. Tool calls run in parallel by default, and without the queue concurrent edits overwrite each other.
- Return `isError: true` or throw to signal failure. Thrown errors reach the model as error results.
- Register at load time or later (`session_start`, handlers). `pi.setActiveTools([...])` switches tools at runtime.
- Tools cannot be unregistered. Re-register with `exposure: "hidden"` to withdraw one.
- `exposure`: `direct` (default), `model-only`, `codemode`, `deferred`, `hidden`. `defaultActive: false` registers without activating.

### Codemode and tool search

`codemode` lets the model write a JS script that calls other tools (parallel calls, output filtering, `models.classify()`). Enable with `"defaultTools": ["+codemode"]`. `settings.codemode.mode: "only"` hides all other tools and routes them through scripts. `tool_search` finds and declares tools that are not declared up front, useful with many MCP tools. See `codemode.md`.

## 6. Skills

A skill is a directory with `SKILL.md`. Pi implements the Agent Skills spec, so skills are portable.

```text
pdf-tools/
├── SKILL.md
├── scripts/extract.sh
├── references/formats.md
└── assets/template.json
```

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

Rules:

- The `description` is the routing signal (max 1024 characters). State what the skill does and when to use it. "Helps with PDFs" is too vague.
- `name`: lowercase letters, digits, hyphens, max 64, no leading, trailing, or doubled hyphens. Match the directory name for portability.
- Only name, description, and path enter the system prompt. The model reads `SKILL.md` when a task matches. Models can miss a relevant skill, so force with `/skill:name [args]`.
- `disable-model-invocation: true` hides the skill from automatic selection. It remains available through `/skill:name`.
- Use relative paths to bundled files.
- Malformed `SKILL.md` and skills without a description are not loaded. Name collisions keep the first and warn.
- The skills prompt section exists only when `read` or `bash` is active. A skill-driven agent must keep one of them.

Locations: `<agent-dir>/skills/`, `.pi/skills/`, `~/.agents/skills/`, `.agents/skills/` (walks from cwd up to the repo root), the settings `skills` array, `--skill <path>`, packages. Discovery is recursive for directories containing `SKILL.md`. `settings.enableSkillCommands: false` hides `/skill:*` from command discovery. Typed commands still work.

Validate: start Pi without `quietStartup` and read the diagnostics, then run `/skill:name`. Project skills can instruct the model to run code, so they are trust-gated.

## 7. Prompt templates

Markdown files that become `/name` commands. Pi expands them before the text enters the agent.

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

Saved as `prompts/review.md`, invoked as `/review concurrency`. Substitutions: `$1…`, `$@` / `$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`. Arguments use shell-like quoting. Conventional directories load direct `.md` children only. Nested files need the settings `prompts` array or a package manifest.

Use a template for repeatable prompt text. Use a skill when the task needs bundled scripts or reference files.

## 8. Extensions (hooks and custom behavior)

### Placement and shape

Auto-discovered: `<agent-dir>/extensions/*.ts|js`, `*/index.ts`, `*/package.json` with a `pi.extensions` field, and the same under `.pi/extensions/` (trust-gated). Discovery goes one level deep. Other paths: settings `extensions`, `-e ./file.ts` (testing), packages. Auto-discovered extensions hot-reload with `/reload`.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {   // may be async
  pi.on("session_start", async (_event, ctx) => { /* ... */ });
  pi.registerTool({ /* ... */ });
  pi.registerCommand("name", { description: "...", handler: async (args, ctx) => {} });
  pi.registerFlag("my-flag", { /* ... */ });
}
```

- TypeScript runs through jiti, no build step. Available imports: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`, Node built-ins. Other npm dependencies need a `package.json` and `npm install` beside the extension.
- The factory can run in invocations that never start a session. Do not start processes, sockets, watchers, or timers in the factory. Start them in `session_start` and close them in an idempotent `session_shutdown` handler.
- Extensions run in-process with full OS permissions and can read prompts, files, and credentials. Install only code you reviewed.

### Event reference

Handlers run in extension load order, then registration order.

| Event | Use | Return |
|---|---|---|
| `project_trust` | Decide trust before project resources load (user/global and `-e` extensions only) | `{ trusted: "yes"\|"no"\|"undecided", remember? }` |
| `session_start` / `session_shutdown` | Init and cleanup. `reason` tells startup, reload, new, resume, fork | none |
| `resources_discover` | Contribute skill, prompt, theme paths | `{ skillPaths, promptPaths, themePaths }` |
| `input` | Intercept raw user text before skill and template expansion | `{ action: "continue"\|"transform"\|"handled", text? }` |
| `before_agent_start` | Inject a message, edit system prompt and tool selection for this run | `{ message?, systemPrompt? }` |
| `agent_start` / `agent_end` | Run bounds. `agent_end` is not final | none |
| `agent_before_settle` | Last chance to append entries and request one more run | `{ entries?, continue? }` |
| `agent_settled` | Final, notification only | none |
| `turn_start` / `turn_end` | Per-turn. `turn_end` can append entries and request continuation | `{ entries?, continue? }` |
| `context` | Modify messages (without system messages) before each model call | `{ messages }` |
| `context_with_system` | Modify the full transcript including system message | `{ messages }` |
| `before_provider_headers` / `before_provider_request` / `after_provider_response` | Edit headers, replace payload, inspect status | headers mutate in place / payload / none |
| `message_start` / `message_update` / `message_end` | Observe. `message_end` can replace the finalized message (same role) | `{ message }` |
| `tool_execution_start/update/end` | Observe every tool call, including blocked ones (end only) | none |
| `tool_call` | Block or rewrite a call before it runs | `{ block: true, reason?, terminate? }`, or mutate `event.input` |
| `tool_result` | Patch a result after it runs | partial `{ content, details, structuredContent, isError, usage }` |
| `user_bash` | Intercept user `!` / `!!` commands | `{ operations }` or `{ result }` |
| `model_select` / `thinking_level_select` | React to model and thinking changes | none |
| `session_before_compact` / `session_compact` | Cancel or replace compaction | `{ cancel }` or `{ compaction }` |
| `session_before_switch` / `session_before_fork` / `session_before_tree` | Cancel `/new`, `/resume`, `/fork`, `/tree` | `{ cancel: true }` |

### Composition rules

- Notification events ignore return values. Keep them fast, since streaming events block the stream.
- `input`, `context`, `context_with_system`, `message_end`, `tool_result`, `before_provider_request` chain: each handler receives the previous handler's output. Preserve fields you do not own.
- `tool_call.input` is mutable in place. Later handlers see earlier mutations. No re-validation runs after you mutate.
- A gate (`block`, `handled`, `cancel`) stops the normal path. Make gates fail closed. An error thrown in a `tool_call` handler blocks the tool.
- `tool_call` does not fire for unknown tools or invalid arguments. Sibling tool calls in one assistant message are checked sequentially but run concurrently, so `tool_call` does not see sibling results.
- Use `isToolCallEventType("bash", event)` to narrow typed inputs.
- Order of hooks per request: `context`, `context_with_system`, `before_provider_headers`, `before_provider_request`, `after_provider_response`, stream events. Per tool call: `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end`.

### Recipe H1. Block dangerous commands and protected paths (PreToolUse)

```ts
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DANGEROUS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];
const PROTECTED = [".env", ".git/", "node_modules/"];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (DANGEROUS.some((p) => p.test(cmd))) {
        if (!ctx.hasUI) return { block: true, reason: "Blocked: dangerous command" }; // headless: fail closed
        const ok = await ctx.ui.confirm("Dangerous command", cmd);
        if (!ok) return { block: true, reason: "Blocked by user" };
      }
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(event.input.path);
      if (PROTECTED.some((p) => path.includes(p))) {
        return { block: true, reason: `Path "${path}" is protected` };
      }
    }
  });
}
```

Path substring checks are a guardrail, not a boundary. `bash` can reach the same files. For a real limit, remove `bash` from the tool set or run Pi in a sandbox.

### Recipe H2. Require a check before the run ends (Stop hook)

```ts
export default function (pi: ExtensionAPI) {
  let asked = false;
  pi.on("agent_before_settle", async (event) => {
    if (asked) return;            // guard: an unconditional continue loops forever
    asked = true;
    return {
      entries: [...event.entries, {
        type: "custom_message",
        customType: "review-reminder",
        content: "Run the tests and review the final diff before replying.",
        display: false,
      }],
      continue: true,
    };
  });
}
```

Allowed draft entry types: `custom`, `custom_message`, `context_edit`, `compaction`. An aborted run suppresses the continuation. Reset the guard in `session_start` if the extension instance serves several runs.

### Recipe H3. Rewrite or redact a tool result (PostToolUse)

```ts
pi.on("tool_result", async (event) => {
  if (event.toolName !== "bash") return;
  const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const redacted = text.replace(/(AKIA|sk-)[A-Za-z0-9]{12,}/g, "[redacted]");
  if (redacted === text) return;
  return { content: [{ type: "text", text: redacted }] };   // replacing content drops structuredContent
});
```

### Recipe H4. Transform or handle user input (UserPromptSubmit)

```ts
pi.on("input", async (event) => {
  if (event.source === "extension") return { action: "continue" };
  if (event.text.startsWith("?quick ")) {
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
  }
  return { action: "continue" };
});
```

Extension commands (`/name`) run before `input` fires. `input` sees `/skill:x` and `/template` unexpanded.

### Recipe H5. Constrain tools per run

```ts
pi.on("session_start", () => pi.setActiveTools(["read", "grep", "find", "ls"]));
```

Or edit `event.systemPromptOptions.selectedTools` in `before_agent_start`. Both keep the prompt's tool sections consistent with the executable tools.

### Recipe H6. Custom compaction

`session_before_compact` receives `preparation` (messages to summarize, tokens, `firstKeptEntryId`, `previousSummary`) and can return `{ cancel: true }` or `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`. `ctx.modelRegistry.complete(model, …)` lets you summarize with a cheaper model. See `examples/extensions/custom-compaction.ts`.

### Other API surface

`pi.sendMessage` (custom message into context; `deliverAs: "steer" | "followUp" | "nextTurn"`, `triggerTurn`), `pi.sendUserMessage`, `pi.appendEntry` (durable state not sent to the model), `pi.exec(cmd, args)` (no shell), `pi.setModel`, `pi.setThinkingLevel`, `pi.getSettings`, `pi.registerProvider`, `pi.registerMcpServer`, `pi.events`. Context object: `ctx.cwd`, `ctx.mode`, `ctx.hasUI`, `ctx.ui`, `ctx.sessionManager`, `ctx.model`, `ctx.signal`, `ctx.getSystemPrompt()`, `ctx.getContextUsage()`, `ctx.isIdle()`, `ctx.abort()`, `ctx.compact()`, `ctx.shutdown()`.

### State

Store tool state in result `details` and rebuild from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`. Rebuilding from all entries mixes abandoned branches into state. Use `pi.appendEntry` for durable data the model must not see.

## 9. MCP servers

Config: `<agent-dir>/mcp.json` (user) and `.pi/mcp.json` (project, trust-gated). Project entries replace user entries by name. A project entry with only `enabled`/`exposure`/`toolExposure` overrides those fields of the user entry.

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

- Transports: stdio (`command`, `args`, `env`, `cwd`) and streamable HTTP (`url`, `headers`, `oauth`). SSE is rejected.
- `${VAR}` expands in `env` and `headers`. `!command` runs a command as the whole value.
- Tool names are `mcp__<server>__<tool>`. Server names allow letters, digits, `_`, `-`.
- `exposure` / `toolExposure` decide whether tools are declared directly, listed in codemode, or found via `tool_search`. Servers with many tools should not use `direct`, because every declaration costs context. `description` makes the server discoverable in the prompt and in search.
- Manage with `pi mcp add|remove|list|login|logout`, or `/mcp` in a session. `pi mcp list` exits 1 when an entry is invalid or a server is not connected. Logs: `~/.pi/agent/mcp.log`.
- Disable for a run: `--no-mcp`. Remove from tool set: `--exclude-tools 'mcp__*'`.
- Keep credentialed servers in user config, not in the project file.
- An extension can add servers with `pi.registerMcpServer(name, config)`. Registrations are not saved, so register on every load.

## 10. Packages

Distribute extensions, skills, prompts, and themes together.

```sh
pi install npm:@scope/pkg@1.0.0     # or git:github.com/user/repo@v1, or ./local-path
pi install -l <source>              # project settings instead of user settings
pi list | pi config | pi update --extensions | pi remove <source>
pi -e npm:@scope/pkg                # try for one run
```

Layout: `extensions/`, `skills/`, `prompts/`, `themes/` at the package root, or an explicit manifest:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"]
  }
}
```

- Host-provided packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) go in `peerDependencies` with `"*"`. Never in `dependencies`. A second copy breaks Pi's module mapping.
- Runtime imports go in `dependencies`. `devDependencies` are not installed.
- Pin versions (`@1.2.3`, a git tag, or a commit). Pinned sources are not re-checked.
- Narrow a package in settings: `{ "source": "npm:x", "extensions": ["extensions/*.ts", "!extensions/legacy.ts"], "skills": [] }`. Omit a type to load all, `[]` to load none, `!pattern` to exclude, `+path` to include one path.

## 11. Embedding with the SDK

When the harness is a Node or Bun program rather than a spawned `pi` process:

```ts
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  appendSystemPromptOverride: (base) => [...base, "## Harness rules\n- Be concise"],
  // systemPromptOverride: () => "Replace the whole preamble",
  // when replacing, also pass appendSystemPromptOverride: () => [] to skip APPEND_SYSTEM.md
});
await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  // tools / noTools / excludeTools / customTools, model, thinkingLevel, settingsManager, cwd
});
const off = session.subscribe((e) => { /* e.type === "message_update" ... */ });
try { await session.prompt("task"); } finally { off(); session.dispose(); }
```

- `prompt()` while streaming must say `steer` or `followUp`. Otherwise it rejects.
- Inline extensions go through `DefaultResourceLoader` `extensionFactories`. The SDK does not load the CLI's built-in codemode, tool search, or MCP extensions. Add `createCodemodeExtension()`, `createToolSearchExtension()`, `createMcpExtension()` yourself, then call `session.bindExtensions()`.
- `SessionManager` owns finalized context. Assigning `session.agent.state.messages` does not replace it.
- Always `dispose()`.

Other process-based options: `RpcClient` (from the same package) for a long-lived child, `--mode json` for one structured run.

## 12. Settings that matter for a harness

Full list in `settings.md`.

| Setting | Why |
|---|---|
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels` | Pin model and effort |
| `enabledModels` | Restrict the model scope |
| `defaultTools` | Tool selection (section 5) |
| `extensions`, `skills`, `prompts`, `packages`, `themes` | Resource paths. User paths resolve from the agent dir, project paths from `.pi/`. Support `!glob`, `+path`, `-path` |
| `enableSkillCommands` | Expose `/skill:*` |
| `defaultProjectTrust` | `ask` / `always` / `never`. Agent-dir settings only |
| `compaction.enabled`, `.reserveTokens`, `.keepRecentTokens`, `.modelOverrides` | Context management |
| `retry.*` | Agent-level retries. Keep `retry.provider.maxRetries` at `0` unless needed |
| `sessionDir` | Session storage. Read before trust resolution |
| `shellPath`, `shellCommandPrefix` | Shell used by `bash` |
| `quietStartup` | Hides startup diagnostics. Turn it off while debugging resource loading |
| `httpProxy`, `selfUpdateCommand` | Agent-dir settings only |

Add `"$schema": "https://pi.dev/schemas/settings.schema.json"` for validation.

Minimal agent-dir `settings.json` for a locked-down headless agent:

```json
{
  "$schema": "https://pi.dev/schemas/settings.schema.json",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-5-5",
  "defaultThinkingLevel": "medium",
  "defaultTools": ["read", "grep", "find", "ls", "edit", "write"],
  "defaultProjectTrust": "never",
  "quietStartup": true,
  "extensions": ["./extensions/guard.ts"],
  "skills": ["./skills"]
}
```

Provider and model identifiers depend on your `models.json` and credentials. Check with `pi --list-models`.

## 13. Sessions and compaction

- Sessions are JSONL trees. Each entry has an id and parent. The active branch supplies model context. `--no-session` keeps it in memory.
- Compaction inserts a summary entry that replaces older messages in later requests. Originals stay in the file. It starts when free context falls below `compaction.reserveTokens`.
- `/compact [instructions]` compacts on demand. `/tree`, `/fork`, `/clone` branch history.
- Sessions can hold prompts, tool output, file contents, and credentials. Review before `/export` or `/share`.
- Shell commands run by the `bash` tool get `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`. Pi sets `AI_AGENT=pi` and `PI_CODING_AGENT=true` in child processes (CLI and RPC entry points).

## 14. Safety checklist

1. R1. Pi asks for no approval before tool calls. If you need gates, write them (recipe H1) and make them fail closed in headless modes.
2. R2. Extensions, packages, and skills execute with the Pi process's permissions. Review source before installing. Pin versions.
3. R3. Project trust only controls what loads. It does not limit what tools can touch.
4. R4. Files, comments, and tool output can carry prompt injection. `AGENTS.md` loads without trust.
5. R5. For untrusted input or unattended runs, run Pi entirely inside a container or VM with only the files, credentials, and network the task needs. See `containerization.md` and `security.md`.
6. R6. Use scoped, short-lived credentials. Keep secrets out of project `mcp.json` and settings.

## 15. Build-and-verify workflow for a harness engineer

1. A1. Decide the run mode (print, json, rpc, SDK) and the agent dir. Put config in an isolated agent dir (`PI_CODING_AGENT_DIR`) so user settings do not leak in.
2. A2. Start from the smallest config: `settings.json` (model, `defaultTools`), one `AGENTS.md` or `APPEND_SYSTEM.md`.
3. A3. Add skills for procedures, prompt templates for reusable prompts.
4. A4. Add an extension only for behavior text cannot enforce: gates, result rewrites, stop checks, custom tools.
5. A5. Test an extension in isolation: `pi -p --no-session --no-extensions -e ./ext.ts "prompt"`.
6. A6. Dump the system prompt and the active tool list (section 4, `pi.getActiveTools()`) and compare with intent.
7. A7. Run headless exactly as production will (same flags, same trust mode), because UI-dependent code paths and trust-gated project files behave differently there.
8. A8. After editing resources in an interactive session, `/reload`.

## 16. Gotchas

- G1. Resources from `.pi/` silently missing in print or RPC mode: project trust is `ask`/`never`. Use `--approve` or agent-dir config (section 2).
- G2. `SYSTEM.md` set but tool guidance is gone: expected, see D1.
- G3. Skills not offered: no `read` or `bash` tool is active, the description is missing, or the name collided with an earlier skill.
- G4. `tool_call` gate bypassed through `bash`: path and command filters are heuristics. Remove the tool or isolate the process.
- G5. `agent_before_settle` / `turn_end` loops: `continue: true` is re-evaluated every time. Guard it.
- G6. Overriding a built-in tool breaks the UI or session: the result `details` shape must match the built-in.
- G7. Background timers or processes started in the extension factory leak across reloads: start in `session_start`, stop in `session_shutdown`.
- G8. `/reload` did not disable a tool removed from `defaultTools`: it only enables newly added ones.
- G9. Duplicate Pi classes after packaging: host packages were listed in `dependencies` instead of `peerDependencies`.
- G10. Exit code 0 in JSON mode with a failed run: inspect the event stream for an `error` or `aborted` stop reason.
