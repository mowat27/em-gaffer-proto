---
description: Prime the session for working on the builder, its pi agent and its TSF by running /prime, mapping builder/ and reading every file under docs/
---

# Purpose

Prime context for working on the builder (`builder/server.ts`), its `pi` agent (`builder/pi-agent/`), its TSF (`builder/tsf/`) and its VM scripts (`builder/vm/`). The gaffer is its peer, with its own kit, TSF and VM in `gaffer/`.

## Roles and responsibilities

- **Board.** Holds the slices and their statuses. Only the gaffer side talks to it.
- **Gaffer.** Owns everything that touches the board or build kits: claiming, slice status, retries, Blocked, applying
  the patch, the gate, merging and pushing. Out of scope for this work.
- **Contract** (`docs/contract.md`). The only interface between gaffer and builder. One dispatch in, one callback out:
  `{"outcome":"done","patch":"..."}` or `{"outcome":"failed","reason":"..."}`. It is an invariant: never change it.
- **Builder.** One slice per job. Clones the repo at `base`, runs the `pi` agent in the clone, and answers once through
  the callback with a patch or a reason. No board access, no repository write access, no knowledge of kits, slice
  statuses or retries.
- **Builder TSF** (`builder/tsf/`). The builder's own Tiny Software Factory, with project root `builder/`. The `builder` layer runs the build server and covers settings, events and pi sessions. Builder tooling that the factory agent or UI uses is built as layers in `builder/tsf/layers/`.
- **Builder agent (`pi`).** Runs inside a builder job. Its only way out is through the builder. A build-kit skill or
  CLI command that assumes the board, the kit's event log or slice state becomes a builder-local tool, or a way to end
  the job with a result that the builder turns into the callback. Its files are plain Pi files in `builder/pi-agent/`.

## Instructions

* Own your domain: execute the steps literally without surveying or accommodating existing state.
* Assume headless operation. Never pause to ask for confirmation or input. Make a reasonable decision and proceed.
* For the rest of the session, work on the builder and its agent only (`builder/` and the shared `docs/`). Take the contract as given. Do not raise gaffer, `gaffer/tsf/`, runner or board consequences, or justify builder decisions against them, unless the user brings them up.

## Workflow

1. Invoke the `prime` skill with no arguments.
2. Run `git ls-files builder`. Do not read the files, just remember the structure.
3. List every file under `docs/` recursively, including `docs/reference/`.
4. Read every file from step 3 in full, in parallel. Start with `docs/design.md`, then `docs/contract.md`, then `docs/prototype.md`, then `docs/hosting.md`, then the rest.

## Report

Reply with only: "Ready to work on the Builder"
