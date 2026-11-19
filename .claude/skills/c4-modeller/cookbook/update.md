# Recipe: Update

Change an existing Structurizr DSL workspace: zoom into a container, add a deployment environment or dynamic flow, add, rename or remove elements, or resync the model with the codebase. Keeps identifiers and view keys stable so renderers and other consumers keep working.

## Variables

- `USER_PROMPT` — the change to make, plus an optional workspace path
- `WORKSPACE` — the workspace to change; path from the prompt, else located by `cookbook/preferences.md` → Locating an Existing Workspace
- `CHANGE` — the requested change, classified in step 2

## Instructions

- Read `cookbook/preferences.md`, `references/c4-model.md` and `references/structurizr-dsl.md` before editing.
- When no workspace exists, run `cookbook/model.md` with the prompt instead, and say so in the report.
- Edit in place. Never rename an existing identifier or view key unless the prompt asks for a rename; renderer extensions and stored layouts refer to them.
- Every new element, relationship and view follows the same rules as `model`: classification, description, technology, tags, verb-phrase relationships, standard view keys.
- When the workspace contains constructs outside the renderer-agnostic subset that this skill did not write, leave them and list them in the report as pre-existing.

## Workflow

1. Read `WORKSPACE` in full. Note its identifiers, scope, levels and view keys.
2. Classify `CHANGE`:
   - **zoom** — add components to a named container ("add components for the API")
   - **deploy** — add or change a deployment environment
   - **flow** — add a dynamic view for a named feature or use case
   - **edit** — add, rename, move or remove named elements or relationships
   - **sync** — reconcile the model with the current codebase
   - **fix** — apply findings from a `review` report
3. Gather only the evidence the change needs (the named container's code for **zoom**, deployment configs for **deploy**, the code path of the flow for **flow**, everything for **sync**).
4. Apply the change:
   - **zoom**: add components inside the container and move the relationships they explain down to component level. Inbound relationships target the component that first receives the call (a single router or entry point when one dispatches all requests, otherwise each handler). Apply the implied-relationship rule in `references/structurizr-dsl.md` → Syntax Rules: remove a container-level relationship only when exactly one component relationship replaces it; when several do, keep the container-level one as the summary and move it above them. Add a `components-<container-id>` view.
   - **deploy**: add the environment with nodes, instances and infrastructure, plus a `deployment-<slug>` view.
   - **flow**: add any missing static relationships, then a `dynamic-<slug>` view with ordered steps.
   - **edit**: make the named edits. When removing an element, remove its relationships and every view, include and dynamic step that names it.
   - **sync**: add elements that now exist, remove elements whose evidence is gone, update descriptions and technologies that changed. Keep identifiers of elements that still exist.
   - **fix**: apply each finding; skip any that conflict with the official C4 definitions and say why.
5. Validate with `cookbook/preferences.md` → Validation Loop, exporting JSON when it applies or when `workspace.json` already sits beside the workspace.
6. Run `cookbook/preferences.md` → Quality Gate.

## Report

A short change list (added, changed, removed, each with identifier), followed by the Model Hand-Off block from `cookbook/preferences.md`.
