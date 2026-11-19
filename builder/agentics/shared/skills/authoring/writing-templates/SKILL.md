---
name: writing-templates
description: How a builder's template sets (the Handlebars scaffold rendered before its agent starts) are laid out, rendered, tested and changed. Use before you create or change a template set, an injection, a partial or a view model.
---

# Writing templates

Paths below are relative to `builder/`.

A template set is the deterministic scaffold of one slice kind. A workflow's `template` step renders it before the
agent starts, so the agent only fills in what needs judgement (`BUILD:` markers). The full reference is
`agentics/builders/supabase-api/templates/README.md`: read it before you change a set.

## The pieces

- The sets: `agentics/builders/supabase-api/templates/<kind>/` (`state-change`, `state-view`). A set's tree mirrors
  the output paths; every `*.hbs` file is a template, and each path segment is rendered (`{{pascal slice}}`). A
  segment that renders empty leaves the file out.
- `partials/` (a set's own) and `agentics/shared/templates/partials/` (shared): `{{> name}}`.
- `injections/*.hbs`: a snippet inserted into an existing file at an anchor, with an idempotency `key`.
- The view model, what the templates render from: `agentics/builders/supabase-api/view-model.ts` and one file per kind
  in `agentics/builders/supabase-api/view-model/`. Keep it pure and deterministic: no clock, no randomness.
- The renderer and its helpers (`pascal`, `camel`, `kebab`, `snake`, `tsType`, `sqlType`, `json`):
  `engine/templates.ts`. The step: `template("scaffold", { set, data, dir })` in
  `agentics/builders/supabase-api/builder.ts`.

## Rules the renderer enforces

- An existing file is never overwritten: it is reported `kept`, and the agent reworks it.
- Rendering is strict and all or nothing: a missing field or partial, bad injection front matter or a path that
  escapes skips the whole scaffold and writes nothing (E11). The agent then builds from its skills. A render error never fails the job.
- A missing injection target or anchor is not an error: it becomes a task in the scaffold report.
- Write `BUILD:` in a comment wherever the agent must write code, and say what. `done` and the `checks` step refuse a
  changed file that still holds one, so the scaffold must type-check with its markers in place.

## Changing a set

- Read: `template_list`, then `template_get { "id": "supabase-api/state-change", "file": "<path in the set>" }`.
- Change: `template_update { "id": "supabase-api/state-change", "expectedVersion": "<version>", "edits": [...] }` or
  `files`. Template ids are `<builder>/<set>` or `shared/<set>`. Validation renders the set against every sample
  dispatch of its kind in `agentics/shared/data/dispatches/`, and refuses a change that does not render.
- The view model is part of the builder: change it with `builder_update { "id": "supabase-api", ... }`, which
  type-checks it.
- A workflow run pins its templates when it starts (E1): a change reaches the next run.

## Tests

- Goldens: `test/golden/<case>/` (expected files and `report.json`), compared by
  `test/unit/scaffold-golden.test.ts`. After a deliberate change: `UPDATE_GOLDEN=1 node --test
  test/unit/scaffold-golden.test.ts`, review `git_diff` of `builder/test/golden/`, then run the test again without
  it.
- `test/unit/scaffold-compile.test.ts` runs `tsc` on the rendered scaffold in a snapshot of invoice-lite.
- Every sample dispatch whose kind has a set needs a golden case.
