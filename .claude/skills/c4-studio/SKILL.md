---
name: c4-studio
description: C4 Studio installs a local web app and CLI into a project for working on C4 architecture models stored as Structurizr DSL, with versions, branches and ADRs. Use when installing C4 Studio into a project, starting the studio UI, creating a C4 model (empty, from a prompt, or reverse engineered from the codebase), importing an existing workspace.dsl ("import this workspace.dsl", "import an existing Structurizr DSL", "bring this model into C4 Studio"), updating or asking about a model, deleting models or branches, branching, forking or rolling back a model, recording ADRs, listing models and versions, or whenever the user mentions "C4 Studio" or "c4 studio".
argument-hint: "[install|serve|create|reverse|import|update|ask|delete|branch|status] [arguments]"
---

# C4 Studio

A skill that carries a resident local web app. `install` stamps a `c4-studio/` directory into the project (a just mod, a config file, a sample env file, a `models/` data directory); the app itself stays in this skill directory and runs from there. Models are Structurizr DSL workspaces: the DSL is the source of truth, and layout, ADRs, versions and branches are sidecars beside it in `c4-studio/models/<slug>/`. Modelling inside this skill is done by the current coding agent with the `c4-modeller` skill. The UI, the CLI's prompt commands and `just c4-studio ...` use headless `claude` instead.

## Startup

On invocation, check whether `c4-studio/` exists in the project root. If it does not, say so in one line ("C4 Studio is not installed in this project") and offer `install`. Do not install unless the mode is `install`. Do not report status unprompted; wait for the request.

## Modes

| Mode | What it does | Typical invocation |
|------|--------------|--------------------|
| `install` | Stamp `c4-studio/` into the project, register the just mod, append ignore rules | "install C4 Studio" |
| `serve` | Start the studio server in the background and open the UI | "start the studio" |
| `create` | Create a model: empty, or from a prompt via c4-modeller | "create a model called billing: an API, a worker and Postgres" |
| `reverse` | Reverse engineer the codebase into a model (new, or sync into an existing one) | "reverse engineer this repo into C4 Studio" |
| `import` | Import an existing Structurizr DSL file as a new model | "import docs/architecture/workspace.dsl" |
| `update` | Change a model's branch via c4-modeller, then snapshot | "update billing: add components for the API" |
| `ask` | Answer a question about a model; writes nothing | "ask billing what talks to the database at container level" |
| `delete` | Delete a model or one branch, only when named explicitly | "delete model billing" |
| `branch` | Fork a branch, list versions, roll back | "fork billing to try-queue", "roll billing back to <version>" |
| `status` | List models, branches, heads and versions | "what models do we have" |

## Recipes

| Mode | Recipe |
|------|--------|
| `install` | `cookbook/install.md` |
| `serve` | `cookbook/serve.md` |
| `create` | `cookbook/create.md` |
| `reverse` | `cookbook/reverse.md` |
| `import` | `cookbook/import.md` |
| `update` | `cookbook/update.md` |
| `ask` | `cookbook/ask.md` |
| `delete` | `cookbook/delete.md` |
| `branch` | `cookbook/branch.md` |
| `status` | `cookbook/status.md` |
| shared rules | `cookbook/preferences.md` |

## Resources

| Path | Purpose |
|------|---------|
| `scripts/install.sh` | The installer. Run from the project root; never overwrites; reports stamped and kept |
| `template/` | Stamped into the project: `mod.just`, `config.json`, `.env.example` |
| `app/` | The resident app (server, UI, CLI). `app/DESIGN.md` documents the CLI, storage layout and HTTP API |
| `../c4-modeller/` | The modelling skill that `create`, `reverse`, `update` and `ask` delegate to |

All paths are relative to this skill's directory (`<skill-dir>`).

## Hard rules

- **The DSL is the source of truth.** Never edit `layout.json`, `lineage.json` or `model.json` by hand.
- **Never edit anything under `c4-studio/models/<slug>/history/`.** Versions are written only by the app and the CLI.
- **After editing a `workspace.dsl` directly, run `snapshot`** so the version is recorded. A direct edit with no snapshot is only picked up when the server is running.
- **Modelling through this skill is done by the current coding agent** with the c4-modeller skill. Never spawn `claude` yourself. Only `just c4-studio ...`, the CLI prompt commands and the UI use headless claude.
- **The app's just targets live only in the mod** (`c4-studio/mod.just`). Never add top-level recipes to the project's justfile.
- Never overwrite files the user owns (`config.json`, `.env`, `mod.just`). Never print key values from `.env`.

## Dispatch

Parse `$ARGUMENTS`. When the first token is a mode name above, that is the **MODE** and the rest is the **USER_PROMPT**. Otherwise infer the mode from the whole of `$ARGUMENTS`: install, set up -> `install`; start, open, run the studio -> `serve`; create, new model -> `create`; reverse engineer, model this codebase -> `reverse`; import, bring in, an existing `.dsl` file -> `import`; update, change, add, rename -> `update`; a question -> `ask`; delete, remove -> `delete`; fork, branch, rollback, restore, undo -> `branch`; list, versions, what models -> `status`. If still unclear, list the modes and stop.

For every mode except `install`, apply the Startup check first. Read `cookbook/preferences.md`, then the mode's recipe, and execute it.

## Cleanup

Before reporting, ensure any background task you started has finished or is intentionally left running. `serve` leaves the server running on purpose and says so in its report. In headless sessions, do not start `serve` unless asked.
