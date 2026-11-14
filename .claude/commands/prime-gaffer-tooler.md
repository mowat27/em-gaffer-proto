---
description: Prime the session for building tooling for the gaffer by running /prime, reading every file under docs/ and surveying the event modeller skills in examples/all-em-skills
---

# Purpose

Prime context for building tooling for the gaffer (`gaffer/`), the peer of the builder.

## Roles and responsibilities

- **Board.** Holds the slices and their statuses. Only the gaffer talks to it.
- **Gaffer.** Owns everything that touches the board or build kits: claiming, slice status, retries, Blocked, applying
  the patch, the gate, merging and pushing. This is the work in scope.
- **Contract** (`docs/contract.md`). The only interface between gaffer and builder. One dispatch in, one callback out:
  `{"outcome":"done","patch":"..."}` or `{"outcome":"failed","reason":"..."}`. It is an invariant: never change it.
- **Builder.** One slice per job. Clones the repo at `base`, runs the `pi` agent, and answers once through the callback.
  Out of scope for this work. Treat it as a black box behind the contract.
- **Event modeller skills** (`examples/all-em-skills/`). The full set of existing event modeller skills. Reference only.
  Use them to understand what the build kits do, or to reverse engineer a skill into the new architecture. Never edit them.

## Instructions

* Own your domain: execute the steps literally without surveying or accommodating existing state.
* Assume headless operation. Never pause to ask for confirmation or input. Make a reasonable decision and proceed.
* For the rest of the session, work on the gaffer only. Take the contract as given. Do not raise builder or `pi` agent
  consequences, or justify gaffer decisions against them, unless the user brings them up.
* Do not read the skill files in step 4 up front. Know that they exist and read the relevant ones when a task needs them.

## Workflow

1. Invoke the `prime` skill with no arguments.
2. List every file under `docs/` recursively, including `docs/reference/`.
3. Read every file from step 2 in full, in parallel. Start with `docs/design.md`, then `docs/contract.md`, then `docs/prototype.md`, then the rest.
4. List the directories directly under `examples/all-em-skills/` so every skill name is visible in context.

## Report

Reply with only: "Ready to work on the Gaffer"
