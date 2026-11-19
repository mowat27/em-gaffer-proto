# C4 Studio design

Local app for working on C4 models stored as Structurizr DSL. Resident in the `c4-studio` skill directory; installed into a project by `../scripts/install.sh`, which stamps `c4-studio/` into the project root. The DSL is the source of truth. Everything else (layout, ADRs, history, lineage) is a sidecar.

Read `src/shared/types.ts` first. It is the contract between every module. Do not change it without updating every consumer.

## Runtime

- Node >= 22.18. Entry point `bin/c4-studio.mjs` (plain JavaScript): installs `node_modules` on first run, registers the tsx loader from the app's own dependencies, then imports `src/cli/main.ts`. No server build step. Frontend is Vite + React 19, built to `dist/web` and served by the same server. ES modules only, imports between local files carry the `.ts`/`.tsx` extension.
- One HTTP server (Hono on `@hono/node-server`), default port 47145 (`C4_STUDIO_PORT` or `config.port`). No HTTPS. Binds 127.0.0.1.
- Vite dev server on 47146 proxies `/api` to the server (dev only).
- The server process is started from the project root. Resolution order for the project root: `C4_STUDIO_PROJECT` env, else git toplevel of cwd, else cwd. The models dir is `<projectRoot>/c4-studio/models`. The skill dir is `path.resolve(import.meta.dirname, '../../..')` from any file under `src/`.
- Provider keys: `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY` from the process environment first, then `<projectRoot>/c4-studio/.env` (a tiny KEY=VALUE loader that never overrides existing variables). Never log key values. Never validate key format. No proxy code anywhere: the environment (`NODE_USE_ENV_PROXY`, `HTTPS_PROXY`) handles routing.

## Storage layout (in the project)

```
c4-studio/
  mod.just                 just mod (stamped by installer, registered in the root justfile with `mod c4-studio`)
  config.json              StudioConfig (stamped; user-owned)
  .env.example             stamped; user copies to .env (gitignored)
  .env                     provider keys (gitignored)
  models/                  the data directory; tracked in git like any project content (only models/.jobs/ and branch .job.lock files are ignored)
    <slug>/
      model.json           ModelMeta
      lineage.json         Lineage
      branches/<branch>/
        workspace.dsl      source of truth for this branch
        layout.json        Layout sidecar
        adrs/NNNN-<slug>.md
      history/<versionId>/ full snapshot: workspace.dsl, layout.json, adrs/
    .chat/<slug>/
      _chats/<id>.json     Chat: one file per chat, for the model rather than a branch (messages without reasoning)
      _chats/index.json    ChatSummary[]: the chat list, so listing reads no chat
      <branch>/runs.jsonl  AgentRun per line: the agent history of that branch
```

- Slugs and branch names: `[a-z0-9][a-z0-9-]*`, max 64 chars. Default branch `main`.
- Version id: `Date.now().toString(36)` + 4 random base36 chars.
- A snapshot is written on every DSL or ADR change: UI edit (source `ui`, message from the op), file change seen by the watcher (source `file`, debounced 1500 ms, message "Edited in file"; suspended while a headless claude job or a claude-code chat turn is writing the branch), headless claude job (source `agent`, one version when the job finishes, message from the job), CLI (source `cli`), fork (`fork`), rollback (`rollback`), model creation (`init`). A snapshot is skipped when the DSL hash and ADR content equal the head's. Layout-only changes never create a version but the current layout is included in every snapshot.
- Rollback writes the chosen version's `workspace.dsl` and `adrs/` into the branch working copy and creates a new version (parent = old head, source `rollback`, message `Rollback to <id>`). The current `layout.json` is kept (positions are keyed by element id, so they still apply).
- Fork creates `branches/<new>/` as a copy of a source branch's working copy (or of a chosen version's snapshot), records `parent`, `forkedFrom` and an initial version with source `fork`.
- Delete branch removes its working copy; its versions stay in `lineage.json` with the branch marked deleted (`branches[name]` removed, versions kept) so history stays coherent. Delete model removes the whole directory.
- All writes to a model go through one in-process async mutex per model.

## Parser semantics (core/dsl)

Implements the renderer-agnostic subset in `../../c4-modeller/references/structurizr-dsl.md` plus tolerance for anything else. Must never throw on unknown constructs: unknown statements and blocks (`styles`, `themes`, `theme`, `branding`, `terminology`, `autoLayout`, `animation`, `!script`, `!plugin`, `!docs`, `!adrs`, `archetypes`, `image` views, `filtered` views, `!include`, `workspace extends`) are skipped with a Warning. Only genuine syntax errors (unbalanced braces, unknown element keyword in a model block, undefined identifier in a relationship, duplicate relationship, duplicate identifier) are ParseErrors with a line number.

- Tokeniser: line-oriented. `//` and `#` start a line comment, `/* */` block comments, double-quoted strings with `\"` escapes, `{` at end of line opens a block, `}` alone closes, `=` and `->` are tokens. A line that ends with `\` continues on the next line.
- Identifiers: `[a-zA-Z_0-9]+` (also `-` inside with a warning). Canonical element id is the hierarchical path regardless of `!identifiers` mode (so `banking.api` in both modes). In flat mode a reference is just the identifier; in hierarchical mode a reference is resolved relative to the current block first (`api` inside `banking { }`), then as an absolute path, then by searching the whole tree for a unique match.
- Relationships: `a -> b "desc" "tech" "tags"`. Inside an element block, `this -> x` and `x -> this` are allowed (`this` = the enclosing element). Duplicate (source, destination, description) is a ParseError, matching Structurizr.
- Implied relationships (Structurizr default `CreateImpliedRelationshipsUnlessAnyRelationshipExistsStrategy`): for each explicit relationship s→d in definition order, for every pair (s', d') where s' ∈ {s} ∪ ancestors(s) and d' ∈ {d} ∪ ancestors(d), (s', d') ≠ (s, d), s' ≠ d', s' is not an ancestor-or-self of d' and d' is not an ancestor-or-self of s': if no relationship (explicit or implied) exists between s' and d', add one with the same description, technology and tags, `implied: true`, `impliedFrom: <explicit id>`. Ancestors stop at the software system level (never a deploymentEnvironment).
- Deployment: `deploymentEnvironment`, nested `deploymentNode`, `infrastructureNode`, `containerInstance <containerRef>`, `softwareSystemInstance <systemRef>`. Instances get `instanceOf`. Relationships between instances are implied from the relationships of what they instantiate, within one environment (`live.ecs.apiInstance -> live.rds.~db`), and are included in `relationships` with `implied: true`. Explicit relationships in deployment blocks (`lb -> ecs.apiInstance "Forwards requests to" "HTTPS"`) are explicit.
- Views: `systemLandscape`, `systemContext <system>`, `container <system>`, `component <container>`, `dynamic <scope|*>`, `deployment <system|*> <environment>`; each takes `"key"` `"description"` positionally (key optional: generate `<kind>-<n>` with a warning). Inside: `include *`, `include a b c`, `include ->a->`, `include ->a`, `include a->`, `include "element.tag==X"`, `include "element.group==X"` (quoted or not), `exclude <same forms>`, `exclude a -> b`, `title "…"`, `description "…"`, `autoLayout …` (ignored, warning), `animation { }` (ignored). Dynamic views contain ordered `a -> b "desc" "tech"` steps; each must match an explicit or implied relationship with that source and destination (description may differ; when it differs, use the first relationship between the pair and keep the step's own description). A step with no matching relationship is a ParseError (Structurizr rejects it).
- `include *` resolution (matches Structurizr; verified against the CLI's JSON export of `references/example.dsl`):
  - systemLandscape: all people and software systems.
  - systemContext S: S, plus every person and software system with a relationship to or from S (explicit or implied).
  - container S: all containers of S, plus every person, software system (not S) and container of another system that has a relationship with any container of S.
  - component C: all components of C, plus every person, software system (not C's system), container (not C) and component of another container that has a relationship with any component of C.
  - deployment S env: every deploymentNode and infrastructureNode in env, and every containerInstance / softwareSystemInstance in env (for S: instances of S or of S's containers; `*`: all). Empty deployment nodes (no instances anywhere below) are still included.
  - dynamic: the elements named by the steps, in order.
  - View relationships = every relationship (explicit or implied) whose source and destination are both in the view, except that a dynamic view lists only its steps' relationships.
- Spans: every element, explicit relationship and view carries `startLine`/`endLine`.

## Editing DSL text (core/dsl/edit.ts)

`applyEdits(dsl: string, ops: EditOp[]): EditResult`. Edits are text splices on the current file content so comments and formatting outside the touched lines survive. After splicing, the result is re-parsed; if it does not parse, the whole batch is rejected (`ok: false`) and nothing is written. Rules:

- `setElement`: re-emit the element's first line as `<indent>[<id> = ]<keyword> "<name>" "<description>" "<technology>" "<tags>"` (drop trailing empty args; persons and software systems have no technology argument), keeping any ` {` and trailing comment. Properties expressed as nested statements (`description "…"` inside the block) are updated in place instead.
- `addElement`: generate a lowerCamelCase identifier from the name (strip non-alphanumerics, dedupe with a numeric suffix), insert the statement as the last line inside the parent block (before its closing brace, after the last child element and before any relationship lines in that block when possible); when the parent has no block, add ` {` to its line and a closing `}` line. Top-level elements go at the end of the `model` block's element section (before the first top-level relationship line, or before the first `deploymentEnvironment`, whichever is first). Indentation follows the file (detect from the first indented line; default 4 spaces).
- `removeElement`: delete the element's lines, every explicit relationship line whose source or destination is the element or a descendant, every `containerInstance`/`softwareSystemInstance` of it, every view scoped to it or a descendant, every include/exclude/step line naming it in remaining views, and every `group` block that becomes empty. An unnamed element (no identifier) is addressed by its synthetic id.
- `addRelationship`: append at the end of the `model` block (before its closing brace) using full hierarchical references (`banking.api -> banking.db …`). In flat identifier mode use flat identifiers.
- `setRelationship` / `removeRelationship`: implied relationships cannot be edited (`ok: false, error: 'implied relationship'`).
- `addView` / `removeView`: append to or remove from the `views` block, with `include *` for the new view. Create the `views` block when missing.
- `created`: ids of elements/relationships added, in op order.

## HTTP API (server)

All JSON. Errors are `{ error: string, parseError?: ParseError }` with 400 (bad input), 404, 409 (conflict, e.g. branch exists), 500.

```
GET    /api/status                                       → Status
GET    /api/models                                       → ModelSummary[]
POST   /api/models            { name, description? }     → ModelSummary   (empty skeleton on main; prompt-driven creation = POST /api/jobs after this)
POST   /api/models/import     { path?, dsl?, name?, description? } → ModelSummary   (import an existing Structurizr DSL file: `path` absolute or relative to projectRoot, or raw `dsl` text; name defaults to the workspace name in the DSL, else the file name; the text is copied verbatim into branches/main/workspace.dsl, version source `init`, message "Imported from <path>"; 400 with parseError when it does not parse; a `!include` directive is allowed but reported in `warnings` because relative includes will not resolve from the copy)
GET    /api/models/:model                                → ModelDetail
DELETE /api/models/:model                                → 204
POST   /api/models/:model/branches  { name, from?: Ref } → BranchInfo     (from defaults to the default branch head)
DELETE /api/models/:model/branches/:branch               → 204 (default branch cannot be deleted; 400)
GET    /api/models/:model/branches/:branch               → BranchState
PUT    /api/models/:model/branches/:branch/dsl  { dsl, message? }   → BranchState | 400 with parseError (nothing written)
POST   /api/models/:model/branches/:branch/edits { ops: EditOp[], message? } → BranchState & { created: string[] } | 400
PUT    /api/models/:model/branches/:branch/layout/:viewKey  ViewLayout     → 204   (replaces that view's layout; merges into layout.json)
DELETE /api/models/:model/branches/:branch/layout/:viewKey                 → 204   (forget positions = re-run auto layout)
GET    /api/models/:model/branches/:branch/versions      → Version[] (newest first)
GET    /api/models/:model/branches/:branch/versions/:id  → { version, dsl, workspace, layout, adrs: Adr[] }
POST   /api/models/:model/branches/:branch/rollback { version } → BranchState
POST   /api/models/:model/branches/:branch/snapshot { message } → Version | 204 when nothing changed
POST   /api/models/:model/branches/:branch/validate      → ValidationResult (runs Structurizr CLI/Docker; 30 s timeout)
GET    /api/models/:model/branches/:branch/adrs          → Adr[]
POST   /api/models/:model/branches/:branch/adrs  AdrInput → Adr
PUT    /api/models/:model/branches/:branch/adrs/:id AdrInput → Adr
DELETE /api/models/:model/branches/:branch/adrs/:id      → 204
GET    /api/models/:model/compare?left=<branch>[@<version>]&right=<branch>[@<version>] → Comparison
GET    /api/events                                       → SSE stream of ServerEvent (every event, all models); `event: message`, `data: <json>`; a comment ping every 15 s
GET    /api/jobs                                         → Job[] (events trimmed to the last 50)
POST   /api/jobs              JobRequest                 → Job (202)
GET    /api/jobs/:id                                     → Job (full events)
DELETE /api/jobs/:id                                     → 204 (cancel: SIGTERM)
GET    /api/chat/providers                               → ChatProviderInfo[]
GET    /api/chat/providers/:id/models                    → { provider, models, source: 'live'|'fallback', error? } (live list from the provider's API with the user's key, cached 10 min)
PUT    /api/chat/favourites/:id   { models: string[] }    → { provider, models } (saved to config.json chat.favourites)
GET    /api/chat/chats/:model                            → ChatSummary[] (newest first)
GET    /api/chat/chats/:model/:id                        → Chat | 404
GET    /api/chat/runs/:model/:branch                     → AgentRunSummary[] (newest first)
GET    /api/chat/runs/:model/:branch/:id                 → AgentRun
POST   /api/chat   ChatRequestBody { model, branch, chatId, message, provider, modelId } → AI SDK UI message stream response
GET    /api/project/files?dir=<rel>&glob=<pattern>       → { files: string[] } (read-only, scoped to projectRoot; used by the reverse-engineer dialog path picker)
GET    /*                                                → dist/web (SPA fallback to index.html)
```

The file watcher (chokidar) watches `<modelsDir>/**/{workspace.dsl,layout.json,adrs/*.md,model.json}`. A change re-reads the branch, bumps `revision`, broadcasts `branch`, and (for DSL/ADR changes) schedules the debounced `file` snapshot. Writes made by the server itself are deduped by hash, not by suppressing the watcher. Creating or deleting a model directory broadcasts `models`.

## Headless claude (jobs)

`claude -p <prompt> --model <config.claude.model> --effort <config.claude.effort> --output-format stream-json --verbose --permission-mode <config.claude.permissionMode> --allowedTools <config.claude.allowedTools joined by ','> --add-dir <modelsDir> [--add-dir <c4ModellerDir> when it sits outside the project] [--add-dir <codePath>] <config.claude.args...> <request.claudeArgs...>`, cwd = projectRoot, stdin closed. `claude` is resolved from PATH (or `C4_STUDIO_CLAUDE`). Extra args are appended verbatim with no validation; if claude rejects them the job fails with claude's stderr.

The c4-modeller skill directory is resolved in this order: `<projectRoot>/.claude/skills/c4-modeller`, `~/.claude/skills/c4-modeller`, `<skillDir>/../c4-modeller`. The prompt names it explicitly:

- create: "Follow the c4-modeller skill at <c4ModellerDir>/SKILL.md in `model` mode. Request: <prompt>. Write the workspace to <abs workspace.dsl> (replace the skeleton there), export JSON beside it only if the skill's recipe says so, validate with <c4ModellerDir>/scripts/validate.sh, and finish with the Model Hand-Off block. Do not write anywhere else."
- reverse (new or into existing): `model` mode on the codebase at <codePath> (all levels with evidence) when the branch has only the skeleton, else `update sync` against <codePath>.
- update: "Follow the c4-modeller skill … in `update` mode on the workspace at <abs path>: <prompt>".
- ask: "Follow the c4-modeller skill … in `ask` mode on the workspace at <abs path>: <question>". The final result text is the answer.

Stream-json events map to JobEvent: assistant text → `text`; tool_use → `tool` ("Read <path>", "Bash <first 80 chars>"); the `result` message → `result` (also stored in `job.result`, with `session_id` into `job.sessionId`). Jobs are kept in memory (last 50) and in `<modelsDir>/.jobs/<id>.json`. While a job writes a branch, `BranchState.busy` is set and the watcher's snapshot uses source `agent` and the job's message.

## Chat (AI SDK)

The server holds each chat. The browser sends only the new user message with the chat id; the server appends it to the saved chat (a message sent again, as Retry does, replaces itself and everything after it), saves the chat before answering so the prompt survives a failed answer, and saves it again with the answer at the end of the stream. Chats belong to a model, not a branch: a prompt runs on the branch open when it is sent. "New chat" starts a chat with a new id and keeps the old one; the panel lists the model's chats and reopens any of them. Each assistant message carries metadata `{ runId, provider, modelId, branch }`, and each agent run records its `chatId`. Reasoning is neither streamed to the browser nor saved in the chat (the agent run keeps it per step), so it is never sent back with later prompts. Chats saved by older versions as `.chat/<model>/<branch>/conversation.json` become chats of their own on first use; the old file is renamed `conversation.migrated.json`.

`POST /api/chat` uses `streamText` from `ai` with `convertToModelMessages(messages)`, `stopWhen: stepCountIs(40)`, and returns `result.toUIMessageStreamResponse({ sendReasoning: false })`. Providers: `createOpenRouter({ apiKey })` from `@openrouter/ai-sdk-provider`, `createFireworks({ apiKey })` from `@ai-sdk/fireworks`, `createAnthropic({ apiKey })` from `@ai-sdk/anthropic`. Default model ids: openrouter `anthropic/claude-sonnet-5.5`, fireworks `accounts/fireworks/models/kimi-k3`, anthropic `claude-sonnet-5-5`. Suggested lists in `src/server/chat/providers.ts`.

System prompt: the assistant is a C4 architecture modeller working on one branch of one model; it includes the full current DSL, the branch and view keys, a condensed version of c4-modeller's DSL syntax rules and tag vocabulary, and the instruction to make changes with tools (`edit_model` for targeted changes, `replace_dsl` for rewrites), to keep identifiers stable, and to summarise what changed.

Tools (zod v4 schemas, server-side execution; every tool returns plain JSON):

- `get_model()` → `{ dsl, elements: [{id, kind, name}], views: [{key, kind}] }`
- `get_element({ id })`, `list_relationships({ element? })`, `list_views()`
- `edit_model({ ops: EditOp[], message })` → EditResult summary (never writes when parsing fails; returns the error so the model can retry)
- `replace_dsl({ dsl, message })` → same contract as PUT …/dsl
- `validate_model()` → ValidationResult
- `list_files({ dir?, glob? })`, `read_file({ path, maxLines? })`, `search_files({ pattern, glob?, maxResults? })` — scoped to projectRoot plus the two skill dirs; reject `..` escapes; skip `node_modules`, `.git`, `dist`
- `list_skills()` → skill names found in `<projectRoot>/.claude/skills`, `~/.claude/skills`, `<skillDir>/..`; `read_skill({ name, file? })` → SKILL.md or a named file inside it
- `list_adrs()`, `add_adr(AdrInput)`
- `create_branch({ name, from? })`

`provider: 'claude-code'`: spawn `claude -p` with the last user message (`--session-id` on the first turn, `--resume <sessionId>` afterwards while the chat's previous answer came from claude-code with the same model; the session id is saved in the chat), same flags as jobs plus `--include-partial-messages`, and translate stream-json into a UI message stream with `createUIMessageStream` / `createUIMessageStreamResponse` from `ai`: text deltas as text parts, tool uses as `tool-<name>` parts (input-available, then output-available with the tool result text when it arrives), the result as finish. The prompt tells claude which workspace file it is working on and to use the c4-modeller skill for changes.

## Web app

React 19 + Vite, `@pw/ui` React components and CSS (`@pw/ui/themes/precision-weave-neon.css`, `@pw/ui/components.css`, `@pw/ui/styles/glass.css`), `ThemeProvider` (system default; toggle light/dark/system in the top bar), `@xyflow/react` for diagrams, `@dagrejs/dagre` for auto layout, `@ai-sdk/react` `useChat` for chat, `react-markdown` for ADRs. URL state: `?model=<slug>&branch=<b>&page=diagram|history|compare|adrs|jobs&view=<key>&element=<id>`.

"New model" offers four ways: empty, from prompt, reverse engineer the codebase, import an existing DSL file (path input, or paste the DSL text).

Screens: diagram (canvas + element inspector aside + toolbar: view picker, labels on/collapsed, auto layout, add element, add relationship, validate, fit), history (versions and branch graph, fork/rollback/compare actions), compare (two refs side by side, same view key, diff list), ADRs (list, detail, create/edit form with element multi-select), jobs (headless claude runs with live log), chat (drawer on the right, provider and model selectors, tool activity in `ActivityLog`). Models and branches are chosen in the top bar; "New model" (empty / from prompt / reverse engineer codebase) and "Delete" live there too.

Performance: the canvas records `performance.now()` when a `branch` SSE event arrives and again in a `useLayoutEffect` after the nodes/edges for the new revision commit; the difference is shown in the status bar ("render 23 ms") and stored on `window.__c4studio.lastRenderMs`. Node and edge components are memoised; the model → nodes/edges derivation is memoised on `(revision, viewKey, layout, labelsCollapsed)`.

## CLI (src/cli/main.ts)

`c4-studio <command> [args] [-- <claude args>]`, run as `node <skill>/app/bin/c4-studio.mjs` from the project root (the just mod and the skill both call it this way; the launcher installs `node_modules` on first run and registers the tsx loader from the app's own dependencies). Commands:

```
list                                   models, branches, heads
create <name> [--description d] [--prompt "…"] [--branch main]   empty skeleton; with --prompt runs a headless claude job and streams its log
import <file.dsl> [--name n] [--description d]                   import an existing Structurizr DSL file as a new model (copy; the original is untouched)
reverse <name|slug> [--into] [--path <codePath>] [--branch b]    reverse engineer the codebase into a new model (or an existing one with --into)
update <slug> "<prompt>" [--branch b]                            headless claude update
ask <slug> "<question>" [--branch b]                             headless claude ask; prints the answer
delete <slug> [--branch b] [--yes]                               delete a model or one branch
branch <slug> <new> [--from <branch>[@<version>]]                fork
versions <slug> [--branch b]                                     history
rollback <slug> <version> [--branch b]
snapshot <slug> -m "<message>" [--branch b]                      record a version now (used by the skill after the coding agent edits the DSL itself)
validate <slug> [--branch b]
serve [--port n] [--open]                                        start the server (builds dist/web when missing)
path <slug> [--branch b]                                         print the absolute workspace.dsl path
```

Everything after `--` is appended verbatim to the claude invocation. Exit codes: 0 ok, 1 failure, 2 usage.

## Deviations recorded during the build

- A job that writes a branch (server-side or CLI-side) holds `branches/<b>/.job.lock` for its duration; the server's watcher skips its automatic "Edited in file" snapshot while a fresh lock (under 30 minutes old) exists, so the job's own snapshot labels the version. The CLI `snapshot -m` command relabels the head when it is an automatic file snapshot of the same content (a coding agent edited the DSL while the server was running), via `store.relabelHead`.
- A change to `lineage.json` refreshes every branch's state, so heads changed by another process show up over SSE.
- Synthetic id for an unnamed deployment environment is `~` plus the lowerCamel name (`~live`). Nested groups are named `Outer/Inner`. `perspectives` entries are stored as `perspective.<name>` properties. A relationship between an element and its own ancestor or descendant is a warning, not an error.
- The empty skeleton ignores `workspace.scope` through `properties` rather than `configuration { scope }`, so containers added through the UI still validate. A fresh skeleton fails the Structurizr inspections (disconnected system, empty container view) until something is modelled.
- `C4_STUDIO_VALIDATOR=none` disables the Structurizr validator (used by tests). `C4_STUDIO_CLAUDE` overrides the claude binary.
- `/api/project/files` returns `dirs` as well as `files`. `POST /api/models/import` returns `warnings: string[]` alongside the summary.
- Creation routes return 201; `POST /api/jobs` returns 202.

## Decisions

- D1 Own DSL parser in TypeScript instead of the Structurizr CLI in the render path: the CLI needs a JVM or Docker and takes seconds; the UI needs < 100 ms. The CLI stays the authoritative validator, run on demand.
- D2 Text-splice edits rather than regenerating the file from the model, so the user's formatting and comments survive and file edits and UI edits are interchangeable.
- D3 Versions are full snapshots in `history/`: models are kilobytes, snapshots are simple to restore and inspect, and no git is involved.
- D4 Layout lives in `layout.json` beside the DSL (the DSL cannot persist positions without `workspace.json`, which would make a derived file the source of layout truth).
- D5 ADRs are markdown with frontmatter beside the DSL rather than `!adrs` in the workspace, so the workspace stays within c4-modeller's renderer-agnostic subset.
- D6 Headless claude for prompt-driven CRUD from the UI, CLI and just (it can run the c4-modeller skill and explore the codebase); the AI SDK chat is the lightweight in-app path with its own tools, and `claude-code` is offered as a chat provider too.
