# supabase-api template sets

The `scaffold` step renders one set per slice kind before the agent starts: `templates/state-change/` and
`templates/state-view/`. The `classify` step picks the kind, `view-model.ts` builds the data, and
`engine/templates.ts` (`renderSet`) renders the set into the app directory. The agent then fills the `BUILD:`
markers. A kind with no templates (an empty set, or `automation`, `webhook`, `translation`) skips the scaffold and the
agent builds from the skills, as before. A render error does the same: it never fails the job.

## Layout of a set

```
templates/state-view/
  src/slices/{{context}}/{{pascal slice}}/{{pascal slice}}Projection.ts.hbs   a template: its path is its output path
  supabase/migrations/{{migrationFile}}.hbs                                  "" when no migration is needed: left out
  partials/columns.hbs                                                       {{> columns}}
  injections/10-import.hbs                                                   inserted into an existing file
  injections/20-register.hbs
```

- Every `*.hbs` file is a template, except under `partials/` and `injections/` at the set's root. Other files
  (`.gitkeep`, notes) are ignored.
- Files and injections are processed in sorted path order, so prefix injections with numbers when order matters.

## Paths

Each path segment (without `.hbs`) is rendered with the view model: `{{context}}`, `{{pascal slice}}`, any field.

- A segment that renders empty leaves the file out, and its content is not rendered. That is how a file is made
  conditional. A file name cannot hold `/`, so block helpers (`{{#if}}…{{/if}}`) cannot go in a path: compute the name
  in the view model (for example `migrationFile: "V3__clients.sql"` or `""`).
- A segment may not render to `.`, `..` or something holding a slash. Nothing is written outside the app directory,
  in `.git/` or in `node_modules/`.
- Stay inside the slice commit scope (`checks.ts`): `src/slices/{context}/{slice}/`, the context's
  `src/slices/{context}/{Context}Events.ts`, `src/common/loadPostgresEventstore.ts`, and new
  `supabase/migrations/V{n}__*.sql` files.

## Files: never overwritten

A file that does not exist is created. A file that exists is kept, whatever the verdict (NEW or CHANGED), and listed
as `kept` in the report so the agent reworks it. So a shared file such as `{Context}Events.ts` can be a template too:
the first slice of a context creates it, later ones keep it and add to it through injections. The verdict is in the
view model (`verdict`) if a template needs to differ.

## Content

Handlebars with `noEscape` (code, not HTML) and `strict`:

- A missing field (`{{nmae}}`) is a render error, so give every field a value (`false`, `[]`, `""`, `null`), never
  leave it undefined. The helpers below also fail on a missing value.
- Put block helpers on lines of their own. Handlebars then drops those lines, with no stray blank lines:

  ```hbs
  export type {{pascal slice}}Command = Command<'{{pascal slice}}', {
  {{#each command.fields}}
      {{camel name}}{{#if optional}}?{{/if}}: {{tsType this}};
  {{/each}}
  }>;
  ```

  Never write `}` right after `}}`: `{{/each}}}` reads as a triple-stash and fails to parse.
- `{{@index}}`, `{{@first}}`, `{{@last}}` and `{{@root.x}}` work inside `{{#each}}`.

### BUILD: markers

Write `BUILD:` (as a word) in a comment wherever the agent has to write code, and say what it has to write:
`// BUILD: decide. Enforce "Empty name is rejected" and "Invalid contact email is rejected"`. Every marker is listed
in the report (`markers`, with the path and line). The `done` tool and the `checks` step refuse a changed file that
still holds one. The learnings file is the one exception. The scaffold must compile with its markers in place, so
leave stubs that type-check (`return state;`, `throw new Error("not implemented")`).

### Partials

`{{> name}}`, where the name is the file's path below the partials folder, without `.hbs`. Shared partials live in
`agentics/shared/templates/partials/`. A set's own `partials/` override the shared ones of the same name.

### Helpers

| Helper | Example | Gives |
|---|---|---|
| `pascal` | `{{pascal "create client"}}` | `CreateClient` |
| `camel` | `{{camel "CreateClient"}}` | `createClient` |
| `kebab` | `{{kebab "CreateClient"}}` | `create-client` |
| `snake` | `{{snake "contactEmail"}}` | `contact_email` |
| `tsType` | `{{tsType this}}` on a field, or `{{tsType type cardinality}}` | `string`, `number`, `boolean`, `Record<string, unknown>`; a `List` gives `T[]`; an unknown type `unknown` |
| `sqlType` | `{{sqlType this}}` | `TEXT`, `INTEGER`, `BIGINT`, `DOUBLE PRECISION`, `NUMERIC`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `JSONB`; a `List` gives `JSONB`; an unknown type `TEXT` |
| `json` | `{{json example}}`, `{{json example 2}}` | JSON, compact or indented |

Words split at case changes, digits stay with their word (`addressLine2` gives `address_line2`), and acronyms are
lowered (`HTTPServer` gives `HttpServer`). The helpers are plain functions in `engine/templates.ts`, so a view model
can call them too. The set is fixed: put any other logic in the view model, as computed fields.

## Injections

`injections/*.hbs` add a snippet to a file that exists, or that the set created in the same render. YAML front matter,
then the body:

```hbs
---
target: 'src/common/loadPostgresEventstore.ts'
anchor: '/^\s*projections: projections\.inline\(\[/'
position: after
key: '{{pascal slice}}Projection,'
---
                {{pascal slice}}Projection,
```

| Key | Meaning |
|---|---|
| `target` | The file, relative to the app directory. Rendered |
| `anchor` | A literal line (compared after trimming both) or `/regex/flags`. Rendered. The first matching line, among the lines the file had before this render's injections, is used |
| `position` | `after` (default) or `before` the anchor line |
| `key` | The idempotency key. Rendered. When the target already contains it, nothing is inserted (`present`). The body must contain it |
| `each` | Optional: a view-model array (dotted path, e.g. `sourceEvents`). The injection runs once per item, with the item as the context and `@root`, `@index`, `@first`, `@last` set |

- Quote every value in single quotes. Unquoted `{{` and `: ` are YAML syntax, and in single quotes a backslash is
  literal, so regexes need no doubling.
- Several insertions at one anchor keep their order: each goes after (or before) the ones already inserted there.
- A missing target or anchor is not an error. The report gets a `task` with the snippet, and the agent places it.
- A render error (a bad key, front matter or template) skips the whole scaffold, and nothing is written.

## The view model

`view-model.ts` gathers the input and calls the kind's pure function:

| File | Owner | Holds |
|---|---|---|
| `view-model.ts` | core | `viewModel(classification, ctx)`, `viewModelInput()`, `modelFor()` |
| `view-model/common.ts` | core | `ViewModelInput`, the slice types, `BaseModel` and `baseModel()`, `names()`, `nextMigrationNumber()` |
| `view-model/state-change.ts` | state-change | `StateChangeModel`, `stateChangeModel(input)` |
| `view-model/state-view.ts` | state-view | `StateViewModel`, `stateViewModel(input)` |

`ViewModelInput` is `{ slice, changes, sourceEvents, context, existingMigrations, verdict, sliceFolder, contextFiles,
modeledEndpoints }`:

- `context` is the folder under `src/slices/`: an existing folder whose name matches the dispatch's context ignoring
  case, else the dispatch's context.
- `existingMigrations` lists the file names in `supabase/migrations/`, sorted. `nextMigrationNumber()` turns them
  into the next `V{n}`.
- `sliceFolder` is the folder under the context folder: an existing folder whose name matches the slice title
  ignoring case, else the title in PascalCase. Use `{{sliceFolder}}` in paths so a slice built before is not built
  twice under another spelling.
- `contextFiles` lists the file names directly in the context folder, sorted (an existing events file, for one).
- `modeledEndpoints` holds the app's endpoint entries from `src/common/modeledEndpoints.ts` (`POST createclient`), in
  file order, or `[]`. A slice listed there takes its path from it.
- The last three are optional in the type (test inputs may leave them out); `viewModelInput()` always sets them.

Keep the model pure and deterministic. No clock and no randomness, and fields in slice order. Give names in every
case (`names()`), TypeScript and SQL types, and specifications with given, when and then. Extend `BaseModel`
(`context`, `slice`, `verdict`) rather than renaming its fields, because the harness and the paths above rely on them.

## Goldens and the compile test

Every sample dispatch (`agentics/shared/data/dispatches/*.json`) whose kind has a set needs a golden case. The
golden test fails until it has one.

```
test/golden/
  _base/                       files every case starts from: the parts of invoice-lite at the dispatches' base that
                               injections target (src/common/loadPostgresEventstore.ts, supabase/migrations/...)
  createclient-new/
    before/                    optional: files laid over _base/ first (for CHANGED: the earlier build of the slice)
    files/                     expected: every file the scaffold created or changed
    report.json                expected: the scaffold report
  createclient-changed/ ...
```

A case is named after its dispatch. A `case.json` with `{ "dispatch": "<name>" }` lets a case of another name render
that dispatch. Folders starting with `_` are not cases.

To add or update goldens (from `builder/`):

```
mkdir -p test/golden/createclient-new                         # plus before/ for a CHANGED case, _base/ files once
UPDATE_GOLDEN=1 node --test test/unit/scaffold-golden.test.ts # writes files/ and report.json
git diff test/golden/                                         # review what the scaffold renders
node --test test/unit/scaffold-golden.test.ts                 # compare: must pass
node --test test/unit/scaffold-compile.test.ts                # tsc --noEmit on the scaffold, in a snapshot of invoice-lite
```

The compile test renders each such dispatch into a snapshot workspace of invoice-lite at the dispatch's base. The
repository is `../invoice-lite` beside the gaffer repository, or `$BUILDER_DEV_REPO`. The snapshot comes from the
runtime's cache, `builder/runs/.snapshots/`, or under `$BUILDER_RUNS_DIR`. The case's `before/` is laid over it, but
not `_base/`, since the snapshot is the real base. Then it runs `npx tsc --noEmit`. It is skipped only when the
repository is not on the machine. `KEEP_TEST_TMP=1` keeps the workspace of a failure. Both tests also run in
`npm test`.

The files under `test/golden/` are data. `tsconfig.json` excludes them and `npm test` does not run them, so a golden
`*.test.ts` is never compiled or run by the builder itself.
