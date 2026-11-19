# Recipe: Ask

Answer a question about a model with the c4-modeller skill's `ask` mode. Writes nothing and records no version.

## Variables

- `SLUG` — the model (resolve as in `cookbook/update.md`)
- `BRANCH` — default `main`
- `QUESTION` — the question, including any C4 level it names

## Instructions

- Follow `cookbook/preferences.md` → Modelling with c4-modeller. Do not use the CLI `ask` command.
- Read-only: no edits, no snapshot, no `validate` side effects.

## Workflow

1. Startup check.
2. Get the path:
   `node "<skill-dir>/app/bin/c4-studio.mjs" path <SLUG> --branch <BRANCH>`
3. Run c4-modeller `ask` mode with `QUESTION` against that workspace.

## Report

The answer exactly as c4-modeller's `ask` recipe formats it, naming the model and branch it came from. Nothing else.
