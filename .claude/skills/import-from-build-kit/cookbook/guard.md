# Recipe: Guard

Add a `tool_call` hook to the builder's Pi agent that blocks direct writes to a protected file and tells the
agent which tool to use instead. Build kits protect files by convention ("never edit it by hand"). The builder
enforces it, because a model told not to edit a file will still edit it.

## Variables

- `TARGET`: what to protect. Either a fixed path, e.g. `config.json`, or the files a tool generates, e.g. "the
  learnings files capture-learning writes"
- `TOOL_NAME`: the tool the agent must use instead, e.g. `capture-learning`
- `SCRATCH`: a fresh directory in the session scratchpad for the tests

## Instructions

- **Identify files the way the tool does.** A fixed path is matched by its resolved absolute path. A tool that takes
  the file as a parameter has no single path to protect. In that case, recognise its files by a marker the tool
  writes, such as a generated-file header, plus the set of files the tool wrote in this session.
- **Put the guard with the tool.** When `TOOL_NAME` is an extension in `builder/pi-agent/extensions/`, add the hook
  to that file so the guard shares the marker constant and the written-files set. Otherwise create
  `builder/pi-agent/extensions/<target>-guard.ts`.
- **Block, don't rewrite.** Return `{ block: true, reason }`. Never mutate `event.input` to redirect the write.
- **Make the reason actionable.** Name the file, the tool that was blocked, and the exact call to make instead, e.g.
  `Record each learning with capture-learning (text, topic, file: "docs/L.md") instead.` The model follows the
  reason, so it is the main lever.
- **Treat the bash check as a guardrail.** Matching words in a command cannot catch a path built at runtime. Say so
  in the report. Removing `bash` from the tool set is the real boundary.
- **Ask only when TARGET is ambiguous.** If TARGET cannot be resolved to a fixed path or a recognisable marker, use
  AskUserQuestion once with the candidate rules. Otherwise run without asking.

## Workflow

1. **Confirm the API.** In the installed Pi, check that `isToolCallEventType` is exported from `dist/index.d.ts`
   and read the input field names in `dist/core/tools/write.d.ts` and `edit.d.ts` (`path`, `content`). Pi lives at
   `~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/`, and
   `~/.pi/agent/install/current-version` holds the version.
2. **Write the identification.**
   - Fixed path: `resolve(ctx.cwd, p.replace(/^@/, "")) === resolve(ctx.cwd, TARGET)`.
   - Generated files: a `MARKER` constant shared with the tool's renderer, a `startsWithMarker(path)` helper that
     reads only the first bytes, and a `Set` of absolute paths that the tool's `execute` adds to after each write.
3. **Write the hook** with `pi.on("tool_call", async (event, ctx) => { ... })`:
   - `write`: block when the path is protected, or when `event.input.content` contains the marker (stops the agent
     hand-making a generated file).
   - `edit`: block when the path is protected.
   - `bash`: return early unless the command writes (`sed -i`, `tee`, `>`, `>>`, `mv`, `cp`, `patch`, `truncate`,
     `rm`). Then block when it names a known protected path (absolute or relative to `ctx.cwd`), or when any word
     in it resolves to a file that starts with the marker.
   - Add every newly recognised file to the set.
4. **Stub test.** In SCRATCH, copy the extension to `port.ts` with the Pi imports replaced by stubs:
   `isToolCallEventType = (n, e) => e.toolName === n`, `withFileMutationQueue = (_p, f) => f()`, and `Type` methods
   that return their argument. Write `run.ts`, which calls the default export with a fake `registerTool` and `on`,
   then calls the captured handler with `{ toolName, input }` events. Cover at least:
   - `write` and `edit` to an unprotected file (allow)
   - `edit` to a protected file that existed before the session (block)
   - `write` and `edit`, including an `@`-prefixed path, after the tool wrote the file (block)
   - `write` of new content containing the marker (block)
   - `bash` appends and `sed -i` on a protected file (block), `cat` of it (allow), a write to an unprotected file
     (allow)
   - `read` of a protected file (allow)

   Run with `node --experimental-strip-types run.ts`. Fix until every case matches.
5. **Live test.** In a fresh scratch directory, create a protected file, then run
   `PI_CODING_AGENT_DIR=<repo>/builder/pi-agent pi -p --no-session "<ask it to change the file with edit, follow any block reason, and report what happened>"`.
   Before running, check that `defaultModel` in `builder/pi-agent/settings.json` is inside `enabledModels` when
   that list is set. Pi starts on a scoped model otherwise. Pass it explicitly with `--model` if it isn't. Pass
   when the reply reports the block and the file was changed only through `TOOL_NAME`.

## Report

Reply in this order:

1. Where the hook lives and how it identifies protected files.
2. What it blocks and allows, per tool.
3. Test results: the stub cases and the live run.
4. Limits (`R1`...): runtime-built paths in bash, plus the case where `bash` is not in `defaultTools` and the bash
   check is dormant.
