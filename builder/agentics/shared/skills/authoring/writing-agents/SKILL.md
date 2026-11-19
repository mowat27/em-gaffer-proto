---
name: writing-agents
description: How agents (folders with an agent.yml in agentics/agents) are defined, created, changed and checked in this builder, and what each agent.yml key does. Use before you create or change an agent, its tools, areas, gates, prompt, mode, API or triggers.
---

# Writing agents

Paths below are relative to `builder/`.

Every agent is a folder under `agentics/agents/` that holds an `agent.yml`, at any depth. Its id is its path:
`supabase-api`, `verifier`, `ops`, `dev/slice-lab`. No agent is special in the code: they differ only in their
agent.yml.

## agent.yml

The keys and their rules are at the top of `runtime/resolve.ts`. An unknown key is an error.

| Key | Holds |
|---|---|
| `description` | Required: what it does |
| `mode` | `headless` (pi `-p`, one task), `interactive` (pi's TUI), `rpc` (steered over its control socket), `durable` (rpc, long-lived, its session resumed after a restart) |
| `prompt` | `own:SYSTEM.md` or `own:APPEND_SYSTEM.md` (the system prompt), or a prompt template that a headless run starts with |
| `extends` | Another agent whose prompt, skills, extensions and gates it reuses |
| `uses` | `skills`, `extensions`, `prompts`: `shared:`, `own:` or `builder:` references, globs allowed |
| `gates` | Gates in the order they run (see the writing-gates skill) |
| `tools` | `enable` and `disable`: groups or tool names (`ops/groups.ts`; the core groups in `ops/core/index.ts`) |
| `writes` | Globs it may write, relative to the workspace, or `own:<glob>`, `~/...`, absolute |
| `areas` | Named folders (`{ path, write }`, relative to the agent's folder), used as `area:<name>` in run specs |
| `runs` | `may_start`: `agent:<glob>`, `workflow:<glob>` or `*` (E8) |
| `api` | `{ listen: <host:port>, token: env:<NAME> }`: its runs serve the HTTP API (`runtime/api.ts`) |
| `triggers` | For durable runs: `{ on: job.failed }`, `{ cron: <daily, hourly or 5 fields>, prompt }` |
| `definitions` | `{ changes: propose }`: its change tools save change sets for the operator instead of writing |

- `defaults.yml` in a folder above merges under each agent.yml: maps merge, lists replace
  (`agentics/agents/dev/defaults.yml`).
- Model, provider and thinking are pi's own `settings.json` (and `models.json`) beside the agent.yml.
- `writes` and writable `areas` are enforced by the `shared:write-scope` gate. Machine config is never writable.
- What a run gets: what the agent.yml asks for, within the machine limit and, for a child run, within its parent's
  tools. A tool outside that is never registered.
- Not part of the definition, and left alone by every change: `data/`, `state/`, `work/`, `sessions/`, `bin/`,
  `auth.json`, `models-store.json`.

## Examples

- `agentics/agents/supabase-api/agent.yml`: headless, a workflow's implement step, writes limited to the slice.
- `agentics/agents/verifier/agent.yml`: interactive, its own extension and prompt templates, `writes: [own:checks.ts]`.
- `agentics/agents/dev/slice-lab/agent.yml`: areas, `runs.may_start`, the tools of the runs it starts.
- `agentics/agents/ops/agent.yml`: durable, an API and triggers.

## Creating and changing one

- Create: `agent_create { "path": "dev/my-agent", "template": "basic", "description": "..." }` from
  `agentics/shared/agent-templates/` (`basic` is interactive, `headless` runs one task), then adjust it.
- See what a run would load before starting one: `config_resolve { "agent": "<id>" }` (tools, skills with hashes,
  pi's arguments). `agent_get { "id": "<id>" }` gives the files, the version and the resolved run.
- Change: `agent_update { "id": "<id>", "expectedVersion": "<version>", "edits": [...] }` or `files`. Validation
  checks the agent.yml and that every reference resolves. A change that widens the calling agent or a run above it is
  refused (E25): more tools, more `runs.may_start`, more `writes` or writable areas, dropping a gate, propose to write.
  Only the operator widens an agent, by editing it.
- Run it: `run_start { "agent": "<id>", "mode": "headless", "input": { "message": "..." } }`, or from the terminal
  `builder run <id>`. A run pins its agent.yml, skills and prompts when it starts, so a change applies from the next
  run.
