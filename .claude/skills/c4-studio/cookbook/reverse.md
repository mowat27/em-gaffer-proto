# Recipe: Reverse

Reverse engineer a codebase into a C4 model: into a new model, or synchronised into an existing one. Modelling is done by you with the c4-modeller skill; the CLI only creates the model and records the version.

## Variables

- `NAME` — the new model's name; default the repository directory name
- `SLUG` — an existing model to sync into (when the user names one or says "into")
- `CODE_PATH` — the codebase to read; default the project root
- `BRANCH` — default `main`

## Instructions

- Follow `cookbook/preferences.md` → Modelling with c4-modeller. Never use the CLI `reverse` command here: it spawns headless claude.
- The codebase is read-only evidence. Write only to the workspace path from `path`.
- Default levels: everything with evidence (system context, containers, deployment when definitions exist). Components only for containers the user names.

## Workflow

1. Startup check.
2. New model: run
   `node "<skill-dir>/app/bin/c4-studio.mjs" create "<NAME>"`
   and take the slug. Existing model: use `SLUG`.
3. Get the path:
   `node "<skill-dir>/app/bin/c4-studio.mjs" path <SLUG> [--branch <BRANCH>]`
4. New model: run c4-modeller `model` mode on `CODE_PATH`, output to that path. Existing model: run c4-modeller `update sync` on that path against `CODE_PATH`.
5. Record the version:
   `node "<skill-dir>/app/bin/c4-studio.mjs" snapshot <SLUG> -m "Reverse engineered from <CODE_PATH>" [--branch <BRANCH>]`

## Report

Slug, branch, workspace path, c4-modeller's change list or levels modelled, assumptions and not-modelled lines, and the URL `http://127.0.0.1:<port>/?model=<SLUG>&branch=<BRANCH>`.
