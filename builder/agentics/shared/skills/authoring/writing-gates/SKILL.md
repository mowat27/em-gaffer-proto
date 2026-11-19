---
name: writing-gates
description: How gates (checks inside an agent's pi process that allow, block or rewrite a tool call, or patch its result) are written, loaded, tested and changed in this builder. Use before you create or change a gate, or when you decide whether a rule belongs in a gate, a check or a listener.
---

# Writing gates

Paths below are relative to `builder/`.

A gate runs inside an agent's pi process on the tool calls it names. On `tool_call` it sees the call before the tool
runs and allows it, blocks it with a reason, or rewrites its input. On `tool_result` it sees the result and allows it
or patches it. Gates decide alone and fail closed: a gate that throws or returns nothing blocks the call (E9). Every
decision is journaled as `tool.gate`.

## The API

`engine/gates.ts` (plain Node, no pi import, so gates are tested without pi):

```ts
import { allow, block, defineGate } from "../../../engine/gates.ts";

export default defineGate({
  tools: ["write", "edit"],          // or "*"
  on: "tool_call",                   // or "tool_result"; default tool_call
  check(call, ctx) {
    return ctx.mayWrite(String(call.input.path)) ? allow() : block("outside the agent's writes", String(call.input.path));
  },
});
```

- Decisions: `allow()`, `block(reason, path?)`, `{ rewrite: input }`, `{ patch: resultFields }`.
- The context: `cwd`, `base`, `writes`, `areas`, `dispatch` (the run builds a slice), `mayWrite(path)`,
  `isProtected(path)`, `existsAtBase(rel)`, `changedFiles()`. Helpers for shell commands: `shellWriteWords`,
  `redirectTargets`, `resolvePath`.
- A module may export a list of gates that share state, such as a `tool_call` gate and a `tool_result` gate:
  `agentics/shared/gates/learnings-file.ts`.

## Where gates live and how they load

- Shared gates: `agentics/shared/gates/<name>.ts`. An agent.yml lists them: `gates: [shared:write-scope,
  shared:blocked-paths]`. They run in that order and the first block wins.
- The runner loads them through the gate host (`runtime/gate-host.ts`) after the agent's own extensions, so a gate
  judges the input after every rewrite. The journal extension comes first and also sees blocked calls.
- Examples: `agentics/shared/gates/write-scope.ts` (machine config, slice scope, the agent's `writes` and `areas`),
  `agentics/shared/gates/blocked-paths.ts`, `agentics/shared/gates/append-only-migrations.ts`.
- Slice rules apply only when `ctx.dispatch` is true. Config protection and `writes` apply always.

## Changing a gate

- `gate_get { "id": "write-scope" }`, then `gate_update { "id": "write-scope", "expectedVersion": "<version>",
  "content": "<whole file>" }` (or `edits`). `gate_create` for a new one, then add it to the agent.yml that needs it
  (`agent_update`).
- Validation loads the module in a process of its own and type-checks it. A change to a gate your own run, or a run
  above you, loads is refused, and so is dropping a gate from an agent.yml (E25): a gate is safety, and an agent never
  loosens its own.
- Test it: `test/unit/gates.test.ts` calls gates directly; `test/unit/gates-e2e.test.ts` runs them in real pi on the
  fake LLM.

## Gate, check or listener

- A gate stops a tool call while the agent works, and tells it why so it can do something else.
- A check runs after the agent, on what it produced: `agentics/builders/supabase-api/checks.ts` (the `done` tool and
  the `checks` step).
- A listener only observes journal events and can never block (`engine/listeners.ts`,
  `agentics/shared/listeners/metrics.ts`).
