# Recipe: Tool

Port one `@eventmodelers/cli` command to a Pi extension tool for the builder agent. The tool reproduces the
command's observable behaviour exactly: inputs, validation, output files byte for byte, duplicate handling, result
and error messages. The only differences are the CHANGES the user asked for and the ones the user approves at the
divergence gate.

## Variables

- `COMMAND`: the CLI command and flags to port, e.g. `learn "<text>" --topic <topic>`
- `TOOL_NAME`: the tool name. Default: the command name
- `CHANGES`: requested departures from the CLI, e.g. "write to a file passed by the caller instead of AGENTS.md"
- `CLI_DIR`: resolved in step 1
- `SCRATCH`: a fresh directory in the session scratchpad for the differential test

## Instructions

- **Read the source, not the help.** `--help` and README text describe intent. Only the code shows what the command
  does. Follow every import the command's action reaches until all behaviour is accounted for.
- **Map every dependency.** Commands often look simple and sit on kit machinery, such as an event log the output
  file is regenerated from, the adoption of hand edits, kit dir resolution, agent metadata or board sync. List each
  one before writing code.
- **Stop at divergence.** If the command depends on anything the builder agent does not have (see Shared Context in
  `SKILL.md`), do not pick a translation yourself. Present the gate in step 5 and wait for the user's decision.
  This is the one human-in-the-loop step. Everything else runs without asking.
- **Mirror the source.** Keep the CLI's function names, order of operations, messages and comments, so the port can
  be diffed against the source when the CLI changes.
- **Port only the flags in COMMAND.** Fix the other options at the defaults the CLI uses when they are omitted, e.g.
  `scope: 'repo'`, no tags. Do not add retract, merge or other modes unless COMMAND names them.
- **Write the extension in `builder/pi-agent/extensions/`**, never under `tsf/pages/`. Pages are not copied there.

## Workflow

1. **Resolve CLI_DIR.** List `~/.npm/_npx/*/node_modules/@eventmodelers/cli/package.json` and choose the highest
   `version`. If none exists, run `npx -y @eventmodelers/cli --version` once to populate the cache and list again.
   Record the version.
2. **Find the action.** Grep `CLI_DIR/cli.js` for `.command('<command name>`. Read the full `.command(...)` block:
   options, defaults, guards (env checks such as `EVENTMODELERS_CURATING`), the branch COMMAND takes, and the exact
   `console.log` and `console.error` strings and exit codes.
3. **Trace the implementation.** Read every function the branch calls, in full, and every function those call,
   across `shared/build-kit/lib/`. Stop at Node built-ins. Read helpers such as fold, key and render functions, not
   only the entry function.
4. **Write the dependency map.** For each piece of state or input the command touches, write one line: what it is,
   where it lives, whether it affects the output for COMMAND, and whether the builder has it. Typical entries: kit
   dir resolution (`requireBuildKitDir`, `pinnedKitDir`), the event log, projections regenerated from it, adoption of
   hand edits, agent metadata (`agentEventMeta`), board upload (`--sync`), env guards, hard-coded paths.
5. **Divergence gate.** If any map entry affects the output and the builder lacks it, or a CHANGE breaks a CLI
   assumption (e.g. one store shared by several target files), use AskUserQuestion. Show the map entries involved
   in one sentence each and offer these options:
   - **Store-free translation (Recommended when no other modes are needed).** Reproduce COMMAND's output using only
     the files the builder has. For example, parse the target file the way the CLI adopts hand edits, apply the
     operation, render it the way the CLI's projection does.
   - **Exact port with a local store.** Port the kit machinery too, with its location adapted to the builder (e.g.
     one store per target file). Keeps ids and enables later retract or merge.
   - **Stop.** Do not port this command.

   Name any observable differences of each option, e.g. ids missing from messages, or ordering of hand-added
   headings. If nothing diverges, skip the gate.
6. **Write the extension** at `builder/pi-agent/extensions/<command name>.ts`:
   - A header comment naming the CLI version and source files ported, the semantics carried over, and every
     difference from the CLI with the reason.
   - The ported functions, mirroring source names and comments, typed for TypeScript.
   - `pi.registerTool` with `name: TOOL_NAME`, a `label`, a `description` adapted from the command's description,
     a `promptSnippet`, and `promptGuidelines` that name the tool in every bullet.
   - Parameters with `typebox` matching the ported flags plus any CHANGES, e.g. a `file` parameter resolved against
     `ctx.cwd`.
   - `execute` wrapped in `withFileMutationQueue(<target path>, ...)` when it writes files. Return the CLI's success
     messages verbatim (substitute the new path where the CLI printed a hard-coded one). Return errors as
     `❌ <message>` with `isError: true`, where the CLI printed to stderr and exited 1.
7. **Differential test.** In SCRATCH:
   1. Copy the extension to `port.ts`, replacing the Pi and typebox imports with stubs:
      `withFileMutationQueue = (_p, f) => f()`, and `Type` methods that return their argument.
   2. Write `run.ts`. It imports the extension's default export with a fake `registerTool`, and imports the CLI's
      own entry function from `CLI_DIR/shared/build-kit/lib/`.
   3. Run the same input sequence through both. The sequence covers: a first call, a near-duplicate (case and
      whitespace), an input with optional flags omitted, a second item in an existing group, an invalid input, and
      a seeded hand-written target file.
   4. Compare output files byte for byte, plus duplicate and error results. Compare events too when the port keeps
      a store, ignoring `id` and `at`.
   5. Run it with `node --experimental-strip-types run.ts`.
   6. Fix the port until everything matches, except differences approved at the gate.
8. **Clean up.** If the port replaces an earlier version of the tool, delete files the new design no longer uses.

## Report

Reply in this order, with reference codes:

1. The extension path, the tool name, and the CLI version and source files it was ported from.
2. The differential test result: which cases ran and whether files and messages matched.
3. Decisions (`D1`...): the gate outcome and any defaults fixed for unported flags.
4. Risks (`R1`...), always including:
   - Behaviour that destroys content when the tool is pointed at an existing file, if the CLI regenerates its
     output.
   - That the tool has not been run inside Pi.
   - That `defaultTools` in `builder/pi-agent/settings.json` may need `"+<tool name>"`.
