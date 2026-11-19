# Recipe: Review

Check a Structurizr DSL workspace for parse errors, C4 correctness, renderer coupling and, on request, drift from the codebase. Reports findings; edits only when the prompt says "fix".

## Variables

- `USER_PROMPT` — optional workspace path, plus optional keywords "fix" and "against code"
- `WORKSPACE` — path from the prompt, else located by `cookbook/preferences.md` → Locating an Existing Workspace
- `FIX` — true when the prompt contains "fix"
- `DRIFT` — true when the prompt contains "against code", "drift" or "sync check"

## Instructions

- Read `cookbook/preferences.md`, `references/c4-model.md` and `references/structurizr-dsl.md`.
- When no workspace can be found, report that and stop.
- Each finding names the element or relationship by identifier, the rule it breaks (with the reference section) and the concrete fix.
- Judge against the official C4 definitions, not taste. Do not report style preferences as findings.

## Workflow

1. Run `bash <skill-dir>/scripts/validate.sh <WORKSPACE>`. Record parse errors and inspection results as findings.
2. Run the purity grep from `cookbook/preferences.md` → Quality Gate. Each keyword hit is a **renderer coupling** finding.
3. Read `WORKSPACE` in full and check every element and relationship against `references/c4-model.md` → Classification Rules, Notation Rules as Data and Anti-Patterns; against `references/structurizr-dsl.md` → Syntax Rules (including the implied-relationship rule), Tags and Views; and against `cookbook/preferences.md` → Evidence and Assumptions.
4. When `DRIFT`: gather evidence from the codebase for every level the workspace models, components included (as in `cookbook/model.md` step 2), and report elements missing from the model, elements with no evidence left, and changed descriptions or technologies.
5. When `FIX`: run `cookbook/update.md` with change type **fix** and these findings, then rerun steps 1 and 2.

## Report

```
## C4 review: <workspace path>

Validation: <ok | parse failed | inspections failed | not machine-validated>

| # | Severity | Element | Rule | Fix |
|---|----------|---------|------|-----|
| 1 | error | <id> | <rule> (<reference section>) | <fix> |

Summary: <n errors, n warnings>. <"Fixed: …" when FIX>
```

Severity: **error** for parse failures, inspection errors, renderer coupling and misclassified levels; **warning** for weak descriptions, generic relationship labels, missing `Assumed` tags and views over 20 elements; **drift** for codebase mismatches. Report "No findings." when there are none.
