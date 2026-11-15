---
name: board-change-build
description: Build the changes made on the event model board by repeating the original multi-agent herdr build - scaffold the new endpoints, cache entries and pages, then run a Sonnet scheduler that drives the backend and frontend builder loops in herdr panes with a watchdog, then verify. Use when slices on the board are new or reset to Created and need building in this project.
argument-hint: "optional short name for the change, e.g. client-pages"
---

# Purpose

Build the board's pending slices with the same scaffold, scheduler and builder-loop process as the original build.

## Variables

* ARGUMENTS: $ARGUMENTS

## Instructions

- **The board is already right.** The human edits the board (or runs a modeler). This skill never edits the model and never sets a slice `Done` (builders do).
- **The slices to build** are every slice whose board status is `Created` or `Planned`, plus any the user names. The human resets a changed slice to `Created` on the board; that is the signal. Do not try to detect design changes by diffing.
- **Agents never message each other.** The signals are slice statuses on the board, report files in `tmp/board-change/`, and herdr panes. A report file is written last, so its existence means that agent finished.
- **Roles.** Main session (Opus, high effort): plans, launches, verifies, never writes application code. Scaffold agent (Sonnet, high effort): steps 3 to 4. Scheduler (Sonnet, high effort, `--permission-mode auto`): drives the loops. Never use Haiku: it does not support auto permission mode and stalls on prompts.
- **Never print or read out the token** in `.eventmodelers/config.json`. Never search the filesystem outside the repo. No `Co-Authored-By` lines. Never ask the human questions: decide, record the decision in the report, continue. Stop only on an authentication failure (MCP or REST 401/403): tell the human to log in again (`/mcp`).
- **Retry limit:** three attempts per step, then stop and report.

## Workflow

1. **Preflight.** All must hold, else stop and say which failed: `HERDR_ENV=1` (load the `herdr` skill first); `.eventmodelers/config.json` exists and one MCP `list_slices` call succeeds; `docker info` works; `uptime` load average is below 6 (wait up to 10 minutes); no uncommitted changes under `src/`, `web/src/` or `supabase/`; `.build-kit/` and `web/.build-kit/` exist.
2. **Plan.** Call `list_slices` and `get_chapter_bounds`. Take the pending slices. For each, call `get_slice_data` (chapter as `contextName`, plus `sliceId`) to learn its type, its screens and whether it is automation-only (processors, no screen). If none are pending, report "nothing to build" and stop. Order them into stages, at most 2 slices each: commands that produce new or changed events; then the read models that project them and the screens that show them; then automation-only slices, after the read model that triggers them and the command they call exist. Classify each as NEW (no folder in `.build-kit/.slices/default/`) or CHANGED (folder exists). Write `tmp/board-change/plan.md`: stage, slice, id, chapter, type, new or changed, automation-only, one line on what changed.
3. **Scaffold.** Spawn one Agent (model `sonnet`, max 300 words in its reply) with the scaffold instructions in the Scaffold section below and `tmp/board-change/plan.md`. Wait for it. If its report shows a failed check, stop; do not launch the scheduler.
4. **Brief.** Write `tmp/board-change/scheduler-brief.md` from the Scheduler Brief section below, replacing every `<<...>>` marker. None may remain (`grep -n '<<' tmp/board-change/scheduler-brief.md` prints nothing).
5. **Launch.** `herdr tab create --label "<name>-build"`; `herdr pane rename <pane> "agent: scheduler"`; `herdr agent start scheduler --kind claude --pane <pane> -- --model sonnet --permission-mode auto`; wait until the agent is ready; `herdr agent prompt scheduler "Read tmp/board-change/scheduler-brief.md and follow it exactly."`. Wait 10 seconds, then `herdr agent read scheduler --source recent-unwrapped --lines 40`. If the prompt sits unsubmitted in the input box, run `herdr agent send-keys scheduler enter` and read again. Continue only when it is visibly working (a prompt once sat unsubmitted and nobody noticed).
6. **Wait.** Run in the background `until [ -f tmp/board-change/build-report.md ]; do sleep 60; done`. Every 10 minutes check `herdr agent get scheduler`. If it is stuck on a permission prompt, report it; do not answer it and do not touch its panes.
7. **Verify, do not trust the report.** `list_slices`: every planned slice is `Done`, none `InProgress`. For each CHANGED slice, `git show --stat` of its feature commit includes code and test changes, not just a note. `npm test`, `npm --prefix web run build` and `npm --prefix web run lint` pass. No `Co-Authored-By` in the new commits. `herdr pane list` shows no leftover `loop:` panes.
8. **Clean up.** Ensure the scaffold agent and scheduler have finished and every pane this run created is closed.

## Scaffold

Instructions for the scaffold agent. Change nothing on the board. Never edit `src/slices`, migrations or the PDF engine. Stage explicit paths, never `git add -A` (the web loop shares the checkout). Commit in logical commits.

1. **Cache.** For each NEW slice, fetch it with `GET {baseUrl}/api/org/{org}/boards/{board}/slicedata?contextName=<chapter>&sliceId=<id>` (header `x-token` from the config; a wrong chapter returns `SLICE_NOT_FOUND`). Write `slices[0]` to `<folder>/slice.json` and add an entry to `index.json` (`{id, slice, index, contextName: "default", contextSlug: "default", folder, status, definition: {id, title, status}}`, folder = title lowercased, spaces removed) in both `.build-kit/.slices/default/` and `web/.build-kit/.slices/default/`. For CHANGED slices write nothing: the builder's diff against HEAD must show the real change, so a refreshed entry would hide it. Never touch a status.
2. **Endpoints.** Run `node scripts/modeled-endpoints.mjs` to regenerate `src/common/modeledEndpoints.ts`. A modeled endpoint outside the naming convention (a PDF download, a logo GET) goes in `EXTRA_ENDPOINTS` at the top of that script; add it, rerun, and keep `src/common/notImplemented.test.ts` green.
3. **Pages.** For each distinct screen title of the pending slices, the page is `web/src/pages/<PascalCaseTitle>.tsx` (title "Clients Page" gives `ClientsPage.tsx`). Never touch one that exists: the web kit composes into it. For a missing one create a shell like `git show 5a0e6da:web/src/pages/TemplatesPage.tsx`: probe the slice's read-model endpoint with `getReadModel` from `../lib/api` and show the `ApiError` message (the 501 "not built yet" text) in a `notification is-warning`. Take the route from the screen description, else `/<kebab-title-without-Page>`. Add the `<Route>` to `web/src/App.tsx` before the `*` route and, when the route has no parameter, a `<NavLink>` to `web/src/Layout.tsx`. Targeted edits only; both files are hand-maintained.
4. **Checks.** `npm test`, `npm --prefix web run build`, `npm --prefix web run lint` must pass.
5. **Report.** Write `tmp/board-change/scaffold-report.md` (facts, under 300 words): cache entries added, changed slices left alone, endpoints added, pages and routes created, check results, commit hashes. Finish with `DONE`.

## Scheduler Brief

The text below goes into `tmp/board-change/scheduler-brief.md`. Fill `<<...>>` from `plan.md`.

> You are the scheduler for the board-change build of <<APP>>. You write no application code (one exception below). Read `CLAUDE.md`, `.build-kit/CLAUDE.md`, `.build-kit/AGENTS.md`, `tmp/board-change/plan.md` and `tmp/board-change/scaffold-report.md`. Never search the filesystem outside this repo. Never print the token in `.eventmodelers/config.json`. No `Co-Authored-By` lines. Do not ask the user questions. Do not treat greyed or pre-typed text in an agent's input box as user input.
>
> Board <<BOARD_ID>>. Use the eventmodelers MCP tools `list_slices` and `update_slice_status` (param `newStatus`, not `status`). If MCP fails with an authentication error, say so in your report and stop.
>
> STAGES, in order; a stage finishes before the next starts: <<numbered list of slice names per stage>>. CHANGED existing slices: <<names>>.
>
> LAYOUT: you run in tab `<<TAB>>`. Split your own pane for each loop with `herdr pane split --current --direction down --cwd <dir> --no-focus` and label every pane you create with `herdr pane rename <pane> "<label>"`: `loop: backend` (cwd repo root), `loop: frontend` (cwd `web/`). Close your panes when finished. Never touch panes you did not create. Never ask the human to stop or restart a loop.
>
> LOOPS: backend `npx --yes @eventmodelers/cli run --non-interactive --name <<PREFIX>>be` at the repo root; frontend the same with `--name <<PREFIX>>fe` in `web/`. Start with `herdr pane run <pane> "<command>"`. A loop builds every slice whose status is `Planned`, logs `Slice build complete`, and idles; it never exits.
>
> ORDER: set a slice `Planned` BEFORE starting or restarting its loop; a status change made through MCP does not wake a running loop. At most 2 slices `Planned` at once, one per loop. Automation-only slices (processors, no screen) are backend-only: stop the frontend loop (ctrl+c in its pane) before setting one `Planned` and restart it afterwards, or it flags the slice `Blocked`. If a loop leaves a slice `Blocked`, read its comment, reset it to `Planned` when appropriate and continue.
>
> WATCHDOG: the connection to the board drops silently. While any slice is `Planned`, every 3 minutes compare the board status of `Planned` slices (`list_slices`) with each loop's cache (`.build-kit/.slices/default/index.json`, `web/.build-kit/.slices/default/index.json`) and its last output (`herdr pane read <pane> --source recent-unwrapped --lines 80`). If a slice has been `Planned` on the board for more than 4 minutes and the cache still shows `Created`, or the log says `No planned slices`, the event was missed: restart that loop (ctrl+c, run again), then re-check. Never wait on a commit without also running this check. Wait with `until`-style loops of `herdr pane wait-output <pane> --match "Slice build complete" --timeout 180000`, never one long wait. Report every missed event.
>
> BUILDERS: tell the backend builder (slice backend prompt hint, or a nudge via `herdr pane run`) not to write web UI and to run the full suite with `npm test`. For every CHANGED slice the builder must diff `slice.json` against the code field by field and implement every change with tests. After each, verify with `git show <hash> --stat` that real code and test changes were committed and the new fields exist. A commit that only adds a "re-verify" note is a failure: retry once, then stop that slice and report it failed. Builders branch `feature/<slice>` off the integration branch and fast-forward back; stage explicit paths, never `git add -A`.
>
> CHECKS: after each stage run `npm test` (rerun once if a test was cancelled), and in `web/` `npm run build` and `npm run lint`. If after a read-model slice the test "every projection exported by a slice is registered with the event store" fails, add the missing import and entry to `src/common/loadPostgresEventstore.ts` (`projections.inline`) yourself, rerun `npm test`, and commit as `Register <Name> projection with the event store`. That is your only hand edit.
>
> FINISH: when every listed slice is `Done` (or one failed after its retry), close your loop panes, strip `Co-Authored-By` lines from the new commits only (backup branch first), and write `tmp/board-change/build-report.md`: facts only, under 500 words: a table of slice, pass, commit, outcome; check results; every watchdog event; failures; what needs a human. Finish with `DONE` on its own line.

## Report

- Table of slice, pass, commit and outcome, corrected by the step 7 checks
- Verification results, one line each
- Watchdog events, failures, and what needs a human
- Paths to `plan.md`, `scaffold-report.md` and `build-report.md`
