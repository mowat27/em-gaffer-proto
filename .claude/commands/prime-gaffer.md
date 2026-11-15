---
description: Prime the session for working on the gaffer and its TSF by running /prime, mapping gaffer/, reading every file under docs/ and surveying the event modeller skills in examples/em-skills
---

# Purpose

Prime context for working on the gaffer (`gaffer/`): its build kit (`gaffer/kit/`), its TSF (`gaffer/tsf/`) and its VM scripts (`gaffer/vm/`). The builder is its peer, with its own TSF and VM in `builder/`.

## Roles and responsibilities

- **Board.** Holds the slices and their statuses. Only the gaffer talks to it.
- **Gaffer.** Owns everything that touches the board or build kits: claiming, slice status, retries, Blocked, applying
  the patch, the gate, merging and pushing. This is the work in scope.
- **Gaffer TSF** (`gaffer/tsf/`). The gaffer's own Tiny Software Factory, with project root `gaffer/`. The `gaffer` layer runs the runner with `gaffer.ts`. The `theme` layer installs the Ember colour theme. Gaffer tooling is built as layers here, in `gaffer/tsf/layers/`.
- **Contract** (`docs/contract.md`). The only interface between gaffer and builder. One dispatch in, one callback out:
  `{"outcome":"done","patch":"..."}` or `{"outcome":"failed","reason":"..."}`. It is an invariant: never change it.
- **Builder.** One slice per job, in `builder/` with its own TSF and VM. Out of scope for this work. Treat it as a black
  box behind the contract.
- **Event modeller skills** (`examples/em-skills/`). Existing event modeller skills, kept for reference. Use them to
  understand what the build kits do, or to reverse engineer a skill into the new architecture. Never edit them.

## Instructions

* Own your domain: execute the steps literally without surveying or accommodating existing state.
* Assume headless operation. Never pause to ask for confirmation or input. Make a reasonable decision and proceed.
* For the rest of the session, work on the gaffer only (`gaffer/` and the shared `docs/`). Take the contract as given. Do not raise builder, `builder/tsf/` or `pi` agent consequences, or justify gaffer decisions against them, unless the user brings them up.
* Do not read the skill files in step 5 up front. Know that they exist and read the relevant ones when a task needs them.

## Workflow

1. Invoke the `prime` skill with no arguments.
2. Run `git ls-files gaffer`. Do not read the files, just remember the structure.
3. List every file under `docs/` recursively, including `docs/reference/`.
4. Read every file from step 3 in full, in parallel. Start with `docs/design.md`, then `docs/contract.md`, then `docs/prototype.md`, then `docs/hosting.md`, then the rest.
5. List the directories under `examples/em-skills/` recursively, two levels deep, so every skill name is visible in context.

## Report

Reply with only: "Ready to work on the Gaffer"
