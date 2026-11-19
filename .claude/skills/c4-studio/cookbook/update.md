# Recipe: Update

Change a model's branch with the c4-modeller skill's `update` mode, then record the version. Done by you, never by headless claude.

## Variables

- `SLUG` — the model (from the prompt; `list` to resolve; if only one model exists, use it)
- `BRANCH` — default `main`
- `CHANGE` — what to change (add components for a container, add a deployment environment or dynamic flow, edit elements, sync with the code, apply review fixes)

## Instructions

- Follow `cookbook/preferences.md` → Modelling with c4-modeller. Do not use the CLI `update` command.
- Work on the working copy at the path from `path`. Never touch `history/`.
- For ADRs, edit `branches/<BRANCH>/adrs/NNNN-<slug>.md` (frontmatter and markdown, same shape as the existing ones; read one first) and snapshot the same way.

## Workflow

1. Startup check.
2. Get the path:
   `node "<skill-dir>/app/bin/c4-studio.mjs" path <SLUG> --branch <BRANCH>`
3. Run c4-modeller `update` mode with `CHANGE` on that path.
4. Record the version:
   `node "<skill-dir>/app/bin/c4-studio.mjs" snapshot <SLUG> -m "<one-line summary of the change>" --branch <BRANCH>`
   No output means nothing changed.

## Report

The c4-modeller change list (added, changed, removed), validation result, the snapshot message, and the URL `http://127.0.0.1:<port>/?model=<SLUG>&branch=<BRANCH>`.
