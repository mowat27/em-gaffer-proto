

When asked to build a slice, always follow this flow:

1. Read the slice definition from `.build-kit/.slices/<context>/<slicename>/slice.json`.
   **If `slice.json` is missing, or has no `commands`, `events`, `readmodels`, `screens` or `processors` (only id/title/status/sliceType/contextName), it is a summary stub, not an empty slice — never conclude "nothing to build" from it.** Run `/load-slice` with the slice's `sliceId` to pull the full definition from the board and re-read `slice.json`. Only a slice that is still empty after that full fetch is genuinely empty.
2. Determine the slice type:
   - **Webhook** — `sliceType === "WEBHOOK"` → invoke `/build-webhook`
   - **Translation** — `sliceType === "TRANSLATION"` → read `description` and `notes` from slice.json; use `/build-webhook` if notes describe an HTTP endpoint, otherwise default to `/build-automation`
   - **Automation** — `processors` array is non-empty → invoke `/build-automation`
   - **State-view** — `projections` or `queries` array is non-empty → invoke `/build-state-view`
   - **State-change** — default (has `commands` / `events`) → invoke `/build-state-change`
3. Invoke the matching skill and follow its instructions completely. Do not deviate.
4. **Baseline gate**: run `npx @eventmodelers/cli build-baseline check --scope backend` first and act only on its verdict — `UNCHANGED` means nothing on the board changed since the last recorded build: do not rebuild, just run the slice's tests and finish; `NO_BASELINE`/`UNKNOWN` mean one full field-by-field diff of slice.json against the code; `CHANGED` lists exactly which elements changed, were added or removed — diff and fix only those. After the checks pass and before committing, run `build-baseline record --scope backend`. A screen or UI prompt change never triggers a backend build.
5. **Verify against slice.json**: After the skill completes, check that every command field, event field, and specification in slice.json appears in the implementation. No invented fields — if it is not in slice.json, it must not be in the code. This applies even when the slice was previously `Done` and reappears as `Planned` — never dismiss a mismatch as "already implemented" or harmless drift; diff slice.json against the code field by field and update the code to match every change.
6. Run quality checks (`npm run build`, then the slice tests only).
7. If checks pass, commit with `feat: [Slice Name]` and set slice status to `Done`. For STATE_VIEW/STATE_CHANGE slices when `handover` is enabled the status to set is `Waiting`, not `Done` — see the `ui-contract` skill, Step 4.

After you are done, automatically run the tests for the slice that was edited.

## Commit Scope Guard

A pre-commit hook (`.githooks/pre-commit`, installed via `init --hooks` — see its own project's setup)
runs `.build-kit/lib/check-commit-scope.cjs` on every commit that touches `src/slices/{context}/{slice}/`
or a webhook's `supabase/functions/{fn}/index.ts`. It loads every check under `.build-kit/lib/checks/`
and rejects the commit if any of them find a problem:

- **blocked-paths** — `package.json`/lockfiles and `server.ts` are never touched by slice work
- **slice-scope** — everything staged must be inside the slice folder (or the webhook's own edge
  function) or a documented exception: `src/slices/{context}/{Context}Events.ts`,
  `src/common/loadPostgresEventstore.ts`, or `supabase/config.toml`
- **append-only-migrations** — `supabase/migrations/V{n}__*.sql` may only be **added**, never edited
- **test-file-present** — a changed Command/Projection/processor file needs a sibling `*.test.ts`
  (webhook edge functions are tested via `supabase functions serve`, not a test file — exempt)
- **no-invented-fields** — heuristic: flags a field used in code that isn't declared anywhere in
  `.build-kit/.slices/{context}/{slice}/slice.json`
- **spec-coverage** — heuristic: the test file needs at least as many `it(...)` blocks as slice.json
  has `specifications[]` entries
- **openapi-annotation** — every handler in a slice's `routes.ts` needs an `@openapi` JSDoc block
  above it, keyed on the registered path (`:param` written as `{param}`); without it the endpoint
  never reaches `/api-docs` or `/swagger.json`
- **tsc-build** — `npx tsc --noEmit` must still pass

If a commit is rejected, split it — commit the out-of-scope file separately from the slice work, or add
the missing test/fix the field — rather than passing `--no-verify`. Run `npm run run:checks` any time
you want to check your current work (by default this checks every uncommitted change — staged,
unstaged, and untracked; pass `-- --staged` to check only what's staged, matching what the pre-commit
hook itself checks). To add a new check, read `.build-kit/lib/checks/README.md` and drop in a file
following its interface — no other wiring needed.

## Example Slice Structure

```
src/slices/
├── {slice-name}/
│   ├── CommandHandler.ts
│   └── routes.ts
```
