# Changing the verifier's rules

How to make a change `/change-rules` asks for. Do only that change.

## Where the rules live

- `checks.ts` (beside this file) holds every rule. `codeChecks` makes the code checks (exact facts read from the
  changed files) and the Jev questions (judgments). `judge` sends the questions to Jev in one request. `verify`
  applies the verdict rule: a build passes only when no finding is `fail` and none is `check`.
- `RULES` at the top of `checks.ts` lists every rule in plain words for `/list-rules`. Keep it in step with your change:
  add, edit or remove the entry for each rule you add, change or remove.
- Put an exact fact (a file exists, a type has these fields, a route is registered) in a code check. Put a judgment
  (a test covers a scenario, a handler enforces a rule) in a Jev question. Do not use Jev for what code can check.

## Jev

Jev is TypeSafe's System One model. Load the `typesafe-ai` skill and read the live docs it points to with
`fetch_docs` before you add or change a Jev question: the primitive's page (Noul or Score), State, and Confidence.
`judge` calls `https://api.typesafe.ai/v1/systemone` with model `jev-latest`. Keep every question over the same
`state` in that one request.

## Check your change

1. Run `try_rules` with `verify`: it checks the last build verified in this session with your rules and returns the
   verdict. When no build has been verified yet, there is nothing to run it on: skip this step.
2. Run `try_rules` with `list` and check the catalogue shows your change.
3. Fix any error before you finish.
4. When a build has been verified in this session, verify it again with the `verify` tool (no arguments: the last
   build) and report the new verdict.

Change only `checks.ts`. Reply with one or two sentences saying what changed, then the new verdict if there is one.
