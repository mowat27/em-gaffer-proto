# Recipe: Delete

Delete a model or one branch. Destructive and irreversible, so it runs only when the user named the target explicitly.

## Variables

- `SLUG` — the model
- `BRANCH` — set only when the user asked to delete a branch; the default branch `main` cannot be deleted
- `EXPLICIT` — true only when the user's words name the model (and the branch) to delete

## Instructions

- Never infer a target from context ("clean up", "remove the old one"). Without an explicit name, delete nothing.
- Deleting a model removes `c4-studio/models/<slug>/` with all branches and history. Deleting a branch removes its working copy; its versions stay in the history.
- Never use `rm` on `c4-studio/models/`; use the CLI.

## Workflow

1. Startup check.
2. Resolve the target with `list` (`node "<skill-dir>/app/bin/c4-studio.mjs" list`) and confirm it exists.
3. If `EXPLICIT` is false: run nothing; go to Report with what would be deleted.
4. If true: run
   `node "<skill-dir>/app/bin/c4-studio.mjs" delete <SLUG> [--branch <BRANCH>] --yes`
5. Run `list` again to confirm it is gone.

## Report

The target (model, or model and branch) and the result. When nothing was deleted: "Would delete <target>: <branches and version count>. Name it explicitly to proceed."
