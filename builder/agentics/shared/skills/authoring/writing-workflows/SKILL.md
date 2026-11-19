---
name: writing-workflows
description: How builders (workflows of code, template, agent and workflow steps) are written, run, tested, changed and activated in this builder. Use before you create, clone or change a builder, add a step, a listener or a sidecar, or switch the active builder.
---

# Writing workflows

Paths below are relative to `builder/`.

A builder is a workflow: a module whose default export is `defineBuilder({ ... })`. The build server runs the active
builder for every dispatch, and any run can start one with `run_start { "workflow": "<id>" }`.

## The pieces

- `agentics/builders/<id>/builder.ts`: the definition. Its id is its folder.
  - `name`, `provides` (the `requires` entries it satisfies besides `repo:*`), `budgetMinutes`, `steps`, and optional
    `listeners` and `sidecars`.
- Steps (`engine/workflow.ts`, types in `engine/types.ts`, checked by `engine/load.ts`):
  - `code(name, async (ctx) => output, { budgetMinutes })`: plain code. Reusable ones are in `engine/steps/` (clone,
    prepare, classify, checks, commit, verify).
  - `template(name, { set, data, dir })`: renders a template set (see the writing-templates skill).
  - `agent(name, { agent, args | prompt, cwd, budgetMinutes })`: starts the agent as a child run in the workspace and
    waits for its `done`.
  - `workflow(name, "<builder id>")`: another builder's steps, inline, in the same workspace and context store.
- Each step's output goes to the run's context store (`outputs/<step>.json`). A later step reads it with
  `ctx.get("<step>")`; anyone reads it with `context_get { "run": "<run>", "step": "<step>" }`.
- The first step that fails ends the workflow with its reason: no partial result, no retry. A step that changes files
  is never optional (E6). Throw a `StepFailure` to fail and still keep an output (the verify step keeps its verdict).
- Budgets: each step's own, capped by the job deadline (the smaller of the builder's `budgetMinutes` and the server's
  `jobTimeoutMinutes`). An overrun stops the step and names it (E4).
- Listeners observe the journal of the run and its children and never block: every module in
  `agentics/shared/listeners/` plus the builder's own (`engine/listeners.ts`). Sidecars (the `sidecar()` helper in
  the engine) start an agent on batches of journal events, never on the step path.

## Examples

- `agentics/builders/supabase-api/builder.ts`: clone, prepare, classify, scaffold, implement, checks, commit.
- `agentics/builders/supabase-api-verified/builder.ts`: the build as a `workflow` step, then a `code` verify step.

## Running and changing one

- Try it without the server: `run_start { "workflow": "<id>", "input": { "dispatch":
  "data:dispatches/createclient-new.json" } }`, then `run_wait`, `job_get`, `journal_query`, `context_get`. Clone the
  app from a local folder with `"repos": { "app": "<path>" }` in `input`.
- Read: `builder_list`, `builder_get { "id": "supabase-api" }`. Change: `builder_update` (with `expectedVersion`).
  Try a variant without touching the active one: `builder_clone`, change the clone, run it, compare.
- Validation loads the module in its own process, checks its steps and type-checks every changed `.ts` file. When the
  active builder does not load at accept, the server uses its newest valid version in `agentics/history/`, and with
  none the job fails (E2).
- The active builder: `agentics/builders/active.yml`, switched with `builder_activate`. The machine config's
  `server.builder` wins when the operator sets it.
- The contract is the fixed boundary (G2): the dispatches a builder accepts and the callback it sends do not change.
  `test/contract.test.ts` holds that for supabase-api; run it after a change to a step.
