---
name: verify-slice
description: Check that the code built for slices on a branch of a target repository (such as ../invoice-lite) is structurally OK, with code checks and Jev judgments. Use when asked to verify, check or grade built slices, a test/run-* branch, or the builder's output for a slice.
---

# verify-slice

Black-box check of built slices: `slice.json` in, code on a git ref out. It doesn't depend on which skills or tools built the code.

## Run

```
node .claude/skills/verify-slice/verify-slice.ts --repo ../invoice-lite --ref <branch|sha> examples/*
```

- Pass any number of slice files as positional arguments. Directories and files that are not a `slice.json` are skipped and listed.
- A slice's commits are those on `--ref` whose subject names `<context>/<Title>` (for example `invoicing/CreateClient`). A slice with no such commit is reported as not built. Pass `--commit <Title>=<sha>` (repeatable) when the subjects don't name the slice.
- Each built slice gets one Jev request with all its questions. Requests run 8 at a time and retry 429 and 5xx responses.
- Output is test-runner style: one character per check as each slice finishes (`.` pass, `F` fail, `?` Jev unsure, `*` slice not built), then the numbered failures and the checks to review, each with its message and slice file, then a summary line.
- The exit code is 1 when any check fails, 0 when none does, and 2 on an error such as a missing ref or repo.
- `--no-jev` runs only the code checks. `--table` prints Markdown tables instead, and `--json` prints JSON.
- Jev needs `TYPESAFE_API_KEY`. Under Agent Vault the placeholder key works.
- To check several branches, run it once for each branch.

## Checks

| Id | Kind | What |
|---|---|---|
| `endpoint.route` | code | The slice registers exactly the route from `src/common/modeledEndpoints.ts` (`POST /api/<command>` or `GET /api/query/<readmodel>-collection`), and no other route |
| `event.<Name>` | code | Each event in `slice.events` has a type with exactly its field names. An event the specs use without a schema in `slice.json` is reported as info |
| `readmodel.<Name>` | code | STATE_VIEW: a migration creates a table with a snake_case column for each read model field |
| `tests.count` | code | The slice folder has a test file with at least one test per spec |
| `scope.files` | code | Info: the changed files outside `src/slices/<context>/<Title>/` |
| `spec.<title>` | Jev Noul | A test sets up the scenario's given, performs its when and asserts its then |
| `rule.<title>` | Jev Noul | Each SPEC_ERROR rule is enforced by the handler |
| `emit.<Event>.<field>` | Jev Noul | STATE_CHANGE: the handler sets each field of each emitted event |
| `fill.<ReadModel>.<field>` | Jev Noul | STATE_VIEW: the projection fills each read model field from the right event data |
| `scope` | Jev Score | The change builds only what the slice asks for, on levels 0 to 3 |

A Noul passes at p(yes) >= 0.8 and fails at <= 0.3. Anything between is `check`. Read the files yourself before calling a `check` either way.

## Report

Show the output as printed.
