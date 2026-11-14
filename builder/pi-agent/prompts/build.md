---
description: Build one slice
argument-hint: "<sliceFile> <title> <context> <sliceId> <attempt> <logbook> <base> <model> <now>"
---

# Project Configuration

## File Structure Constraints

- **Strict Path Limitation**: if not instructed otherwise, only check `src/slices/{slicename}/*.ts`
- **Slice Organization**: Each feature/domain should be organized as a separate slice

## Key Files

| Handle | Path | Description |
| ---    | ---  | ---         |
| `SLICE_FILE` | `<code-repo>/.slice.json` | Defines the slice to be built |
| `LEARNINGS_FILE` | `<code-repo>/LEARNINGS.md` | text file containing learnings from previous agent runs |

## Commands

Information dense keywords capturing actions you can take and what they mean.

`HALT` - call the `halt` tool with the reason given and stop immediately
`CAPTURE-LEARNING` - call the `capture-learning` tool with a one terse line explaining the learning (max 50 words), the topic of the learning and `LEARNINGS_FILE`

## Code Standards

- **Language**: TypeScript only
- **Module System**: Use ES modules (import/export)
- **Type Safety**: Ensure all code is properly typed

## Development Guidelines

1. Each slice should be self-contained and focused on a specific domain
2. Maintain clear separation of concerns within each slice
3. Follow TypeScript best practices for type definitions and interfaces

Only check src/slices/{slice}/*.ts, do not check subfolders unless explicitely tasked to.
If not tasked explicitely to change routes, ignore routes*.ts — except the `routes.ts` of the slice you are
building: the build skill owns that file, and its `@openapi` block has to stay in step with the slice's
fields (the `openapi-annotation` check blocks the commit otherwise).

Ignore case for files and slices in prompts. "CartItems" slice is the same as "cartitems"

Do not change files with tests unless explicitely instructed, or the change brings the test in line with slice.json (e.g. step 4's field/spec diff): *.test.ts

At the start of every session, read `LEARNINGS.md` if it exists to load accumulated project learnings. It is generated from the learnings recorded so far

Record a new one using the `CAPTURE-LEARNING` command.

## Building a Slice

**CRITICAL: You MUST always use the provided skills to build slices. NEVER implement a slice manually.**
**ALL fields, event names, command names, and business rules MUST come exclusively from slice.json. Do NOT invent, assume, or guess any field or logic not present in the slice definition.**

**Default: make a reasonable assumption and build the slice.** If a detail is unclear or missing (an example value, a field type, a status mapping, a referenced event that isn't modeled yet, ...), pick the most sensible interpretation from `slice.json`, its specifications and the surrounding model, build it, and record each assumption in one line as a code comment. Ambiguity alone is never a reason to stop. **Only if the slice literally cannot be built** — nothing runnable can be produced even with sensible assumptions — invoke `HALT` with the specific question.  That must be the absolute exception; a and must only mean "impossible without a human", never "the agent preferred to ask".


### Workflow


1. Read the slice definition from `SLICE_FILE`.
   If `slice.json` is missing, or has no `commands`, `events`, `readmodels`, `screens` or `processors` then `HALT` with an explanation of what was missing.
2. Determine the slice type as `SLICE_TYPE`:
   - **Webhook** — `sliceType === "WEBHOOK"`
   - **Translation** — `sliceType === "TRANSLATION"`
   - **Automation** — `processors` array is non-empty
   - **State-view** — `projections` or `queries` array is non-empty
   - **State-change** — default (has `commands` / `events`)



### Finally

Always append exactly one line to `${6:-LOGBOOK.md}` in the form:

    - ${9:-just now} | ${3:-context}/${2:-task} | attempt ${5:-1} | slice_type: `$SLICE_TYPE` status: `PASS|FAIL` |

Keep every existing line in that file exactly as it is. Do not create, change or delete any other file. Do not
ask questions. When the line is appended, reply with the single word DONE.
