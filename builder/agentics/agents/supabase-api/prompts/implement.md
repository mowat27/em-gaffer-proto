---
description: Implement one slice from its scaffold
argument-hint: "<sliceFile> <title> <context> <sliceId> <attempt> <base> <model> <now>"
---

# Implement the Slice

The builder has already classified the slice and, for the kinds that have templates, rendered a scaffold of it: the
slice's files with their types, test cases and route wired from the slice, and `BUILD:` markers where code is
missing. Your job is to finish it.

## Key Files and Tools

| Handle | Where | Description |
| --- | --- | --- |
| `SLICE_FILE` | `.slice.json` | The slice to build: the source of truth (in the working directory, the app) |
| `LEARNINGS_FILE` | `LEARNINGS.md` | Learnings from earlier builds (in the working directory, the app) |
| The slice summary | `<builder_slice>` in the system prompt | The slice's kind and verdict, what changed, and what the scaffold did |
| The scaffold report | the `context_get` tool with step `scaffold` | `files` (created or kept), `injections` (inserted, present or task), `tasks`, `markers`; `skipped` when nothing was rendered |
| The job | the `context_get` tool with no step | The dispatch, including `changes` (what changed since the last build, with `before`) and `sourceEvents` |

## Commands

`HALT` - call the `halt` tool with the reason given and stop immediately
`DONE` - call the `done` tool. If it lists problems, fix each one and call it again. When it passes, stop immediately
`CAPTURE-LEARNING` - call the `capture-learning` tool with one terse line explaining the learning (max 50 words), the
topic of the learning and `LEARNINGS_FILE`

## Code Standards

- **Language**: TypeScript only, ES modules (import/export), properly typed.
- Keep the slice self-contained: its files live in `src/slices/{context}/{slice}/`. The only shared files a slice
  touches are the ones the scaffold and the build skill name (the context's events union, the projection
  registration, a new migration).
- Ignore case for files and slices: the "CartItems" slice is the same as "cartitems".
- Only look at `src/slices/{context}/{slice}/*.ts` and the files the scaffold report names, unless a task needs more.
  Do not read the whole code base.
- Ignore other slices' `routes*.ts`. The `routes.ts` of your slice is yours: its `@openapi` block has to stay in step
  with the slice's fields (the `openapi-annotation` check refuses the commit otherwise).
- Do not change test files unless the change brings them in line with `SLICE_FILE`: the scaffold's test file is
  yours to complete.

At the start of the session, read `LEARNINGS_FILE` if it exists. Record a new learning with `CAPTURE-LEARNING`.

## The Slice Is the Source of Truth

**ALL fields, event names, command names and business rules MUST come exclusively from `SLICE_FILE`. Do NOT invent,
assume or guess any field or logic not present in it.** The scaffold was rendered from the same slice, so its names
and fields are right: keep them.

**Default: make a reasonable assumption and build the slice.** If a detail is unclear or missing (an example value, a
field type, a status mapping, a referenced event that isn't modeled yet, ...), pick the most sensible interpretation
from `SLICE_FILE`, its specifications and the surrounding model, build it, and record each assumption in one line as a
code comment. Ambiguity alone is never a reason to stop. **Only if the slice literally cannot be built** — nothing
runnable can be produced even with sensible assumptions — invoke `HALT` with the specific question. That must be the
absolute exception: a halt must only mean "impossible without a human", never "the agent preferred to ask".

## Workflow

1. Read `SLICE_FILE`, then the scaffold report (`context_get` with step `scaffold`). The `<builder_slice>` summary
   tells you the kind (`state-change`, `state-view`, `automation`, `webhook` or `translation`) and the verdict.
2. Read the build skill for the kind: `/build-state-change`, `/build-state-view`, `/build-automation` or
   `/build-webhook`. For `translation`, read `description` and `notes` in `SLICE_FILE`: use `/build-webhook` if they
   describe an HTTP endpoint, otherwise `/build-automation`.
   - **The report has `skipped`** (no templates for the kind, or the render failed): there is no scaffold. Build the
     whole slice from the skill.
   - **Otherwise**: the skill tells you how to fill the scaffold for the kind. Fill every marker in `markers`: write
     the code the `BUILD:` comment asks for and remove the comment. Do every item in `tasks` (an injection the
     builder could not place: put the snippet where it belongs). A file the report lists as `kept` existed before:
     it was not overwritten, so bring it in line with the slice yourself.
3. **Verdict CHANGED**: the slice was built before and `kept` files hold that code. Read `changes` from the job
   (`context_get` with no step) and rework the code for every changed, added or removed element and source event,
   using `before` to see what was built. A slice can be unchanged apart from added specifications: add every
   specification that has no test yet.
4. **Verify against `SLICE_FILE`**: check that every command field, event field and specification in it appears in the
   implementation, and that nothing else does. Diff the slice against the code field by field and update the code to
   match every change; never dismiss a mismatch as "already implemented". For every specification, there is one
   executable test.
5. Run the checks: the `npm` tool with `["run", "build"]`, then the slice's tests only (`npx` with
   `["tsx", "--test", "<the slice's test file>"]`). Fix what fails.
6. Invoke `DONE`. It refuses a slice that still holds a `BUILD:` marker, as well as the other commit-scope checks: fix
   what it lists and call it again. Do not commit: the builder commits for you. Do not ask questions.
