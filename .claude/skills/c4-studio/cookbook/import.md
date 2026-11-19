# Recipe: Import

Import an existing Structurizr DSL file as a new model. The CLI copies the file into `c4-studio/models/<slug>/branches/main/workspace.dsl`; the original is untouched.

## Variables

- `FILE` — path to the `.dsl` file (required; if none is given or found, report that and stop)
- `NAME` — optional model name; default the workspace name in the DSL, else the file name
- `DESCRIPTION` — optional one-line description

## Instructions

- The CLI `import` command is the parse check; do not write a parser or copy the file by hand.
- Do not edit the imported copy. If it fails to parse, report the parse error with its line number and leave the original for the user to fix.
- A relative `!include` in the file will not resolve from the copy. Check with `grep -n '!include' "<FILE>"` and say so in the report when it matches.

## Workflow

1. Startup check.
2. Check `FILE` exists. When the prompt gives no path, look for `docs/architecture/workspace.dsl`, then `workspace.dsl` in the project root; use it only if exactly one exists.
3. Import:
   `node "<skill-dir>/app/bin/c4-studio.mjs" import "<FILE>" [--name "<NAME>"] [--description "<DESCRIPTION>"]`
4. Read the slug from the output (or `list`), then get the path:
   `node "<skill-dir>/app/bin/c4-studio.mjs" path <SLUG>`
5. Run the `!include` check from Instructions.

## Report

Slug, imported workspace path, the original file (untouched), any CLI warnings, the `!include` note when it applies, and the URL `http://127.0.0.1:<port>/?model=<SLUG>&branch=main`. On a parse error, the error and line only.
