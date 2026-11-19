# Recipe: Branch

Fork a branch, list a branch's versions, or roll a branch back, through the CLI. Rollback writes the chosen version into the branch and records a new version; nothing is lost.

## Variables

- `SLUG` — the model
- `ACTION` — `fork`, `versions` or `rollback`
- `NEW` — fork: the new branch name (`[a-z0-9][a-z0-9-]*`)
- `FROM` — fork: source `<branch>` or `<branch>@<version>`; default the default branch head
- `BRANCH` — default `main`
- `VERSION` — rollback: the version id

## Instructions

- Never copy or edit files under `branches/` or `history/` by hand to fork or roll back.
- Rollback replaces the branch's working copy. Run it only when the user asked for it with a named version, or after they picked one from the list. If they gave none, list the versions and stop.
- After a fork, further modelling on the new branch goes through `update` with `--branch <NEW>`.

## Workflow

1. Startup check.
2. Run one of:
   - fork: `node "<skill-dir>/app/bin/c4-studio.mjs" branch <SLUG> <NEW> [--from <FROM>]`
   - versions: `node "<skill-dir>/app/bin/c4-studio.mjs" versions <SLUG> [--branch <BRANCH>]`
   - rollback: `node "<skill-dir>/app/bin/c4-studio.mjs" rollback <SLUG> <VERSION> [--branch <BRANCH>]`
3. For fork and rollback, confirm with `versions <SLUG> --branch <branch>` that the new head exists.

## Report

Fork: the new branch, its source, and the URL `http://127.0.0.1:<port>/?model=<SLUG>&branch=<NEW>`. Versions: the CLI table (id, time, source, message), newest first. Rollback: the version restored and the new head version id.
