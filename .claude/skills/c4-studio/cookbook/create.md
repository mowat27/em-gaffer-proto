# Recipe: Create

Create a C4 model in the studio: an empty skeleton, or one modelled from a prompt. The empty model comes from the CLI; the modelling is done by you with the c4-modeller skill, writing straight into the model's workspace file.

## Variables

- `NAME` — the model name (derive from the prompt when absent)
- `DESCRIPTION` — optional one-line description
- `PROMPT` — what to model; empty means an empty model
- `SLUG` — the model's slug, from the CLI output

## Instructions

- Follow `cookbook/preferences.md` → Modelling with c4-modeller. Never use the CLI `--prompt` flag here: it spawns headless claude.
- The workspace path comes from `path`, never from c4-modeller's default output location.
- Validation is part of the c4-modeller recipe; keep its report's assumptions and "not modelled" lines.

## Workflow

1. Startup check.
2. Create the empty model:
   `node "<skill-dir>/app/bin/c4-studio.mjs" create "<NAME>" [--description "<DESCRIPTION>"]`
   Read the slug from its output (or from `list`).
3. Print the workspace path:
   `node "<skill-dir>/app/bin/c4-studio.mjs" path <SLUG>`
4. If `PROMPT` is empty, stop here and go to Report.
5. Run the c4-modeller skill in `model` mode with `PROMPT`, writing to the path from step 3 (replace the skeleton). When `PROMPT` points at the codebase, model the codebase. Skip JSON export.
6. Record the version:
   `node "<skill-dir>/app/bin/c4-studio.mjs" snapshot <SLUG> -m "<one-line summary of the model>"`
7. If the studio server is running, nothing more is needed: it picks the change up.

## Report

Slug, workspace path, a two-line summary of what was modelled (levels, element counts), c4-modeller's assumptions, and the URL `http://127.0.0.1:<port>/?model=<SLUG>&branch=main`. Offer `serve` when the server is not running.
