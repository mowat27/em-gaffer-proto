# Recipe: Status

List the models, their branches and heads, and optionally a branch's versions. Read-only.

## Variables

- `SLUG` — optional; when given, also list versions
- `BRANCH` — default `main`

## Instructions

- Report only what the CLI prints; do not read model files directly.
- No models yet: say so and offer `create` or `import`.

## Workflow

1. Startup check.
2. `node "<skill-dir>/app/bin/c4-studio.mjs" list`
3. When `SLUG` is given: `node "<skill-dir>/app/bin/c4-studio.mjs" versions <SLUG> [--branch <BRANCH>]`

## Report

A table of models (slug, branches, head version), then the versions list when requested. One line on whether the server is running (`curl -s http://127.0.0.1:<port>/api/status`) only when the user asked about the studio.
