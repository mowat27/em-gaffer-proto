---
description: Prime the session for building tooling for the builder and its pi agent by running /prime and reading every file under docs/
---

# Purpose

Prime context for building tooling for the builder (`builder/server.ts`) and its `pi` agent (`builder/pi-agent/`).

## Roles and responsibilities

- **Board.** Holds the slices and their statuses. Only the gaffer side talks to it.
- **Gaffer.** Owns everything that touches the board or build kits: claiming, slice status, retries, Blocked, applying
  the patch, the gate, merging and pushing. Out of scope for this work.
- **Contract** (`docs/contract.md`). The only interface between gaffer and builder. One dispatch in, one callback out:
  `{"outcome":"done","patch":"..."}` or `{"outcome":"failed","reason":"..."}`. It is an invariant: never change it.
- **Builder.** One slice per job. Clones the repo at `base`, runs the `pi` agent in the clone, and answers once through
  the callback with a patch or a reason. No board access, no repository write access, no knowledge of kits, slice
  statuses or retries.
- **Builder agent (`pi`).** Runs inside a builder job. Its only way out is through the builder. A build-kit skill or
  CLI command that assumes the board, the kit's event log or slice state becomes a builder-local tool, or a way to end
  the job with a result that the builder turns into the callback.

## Instructions

* Own your domain: execute the steps literally without surveying or accommodating existing state.
* Assume headless operation. Never pause to ask for confirmation or input. Make a reasonable decision and proceed.
* For the rest of the session, work on the builder and its agent only. Take the contract as given. Do not raise
  gaffer, runner or board consequences, or justify builder decisions against them, unless the user brings them up.

## Workflow

1. Invoke the `prime` skill with no arguments.
2. List every file under `docs/` recursively, including `docs/reference/`.
3. Read every file from step 2 in full, in parallel. Start with `docs/design.md`, then `docs/contract.md`, then `docs/prototype.md`, then the rest.

## Report

Reply with only: "Ready to work on the Builder"
