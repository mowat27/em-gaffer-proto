# The builder's agents and how this factory reaches them

The builder runs on its own. This factory is a client of the builder CLI (`node builder/cli/builder.ts <command> --json`):
the Builder screen and the `builder_*` tools call it, the same way a terminal does.

| What | Where it lives | How to change it |
|---|---|---|
| Agents | `builder/agentics/agents/<id>/`: `agent.yml` (what it loads, its tools, areas and writes), `settings.json` (provider, model, thinking), prompts, `SYSTEM.md` or `APPEND_SYSTEM.md` | the definitions tools (`agent_update`, `skill_update`, ...), which validate and version every change. The model picker is `agent_update` of `settings.json` |
| Shared skills, extensions, gates, templates | `builder/agentics/shared/` | the definitions tools |
| Builders (workflows) | `builder/agentics/builders/<id>/builder.ts` | the definitions tools; the active one is `builder_activate` |
| Server settings (host, port, job timeout, callback retries, workspaces kept, active builder, runs directory, pi command) | the machine config: `builder/ops/config.yml`, `~/.gaffer/config.yml`, `$GAFFER_CONFIG`, `--config` | the operator edits a layer, then `builder config reload`. No tool changes them |
| Status | the machine feed, `builder/runs/index.jsonl` | read with `builder events` (`builder_status`, `builder_events`) |
| Runs | `builder/runs/<id>/`: `run.json`, `journal.jsonl`, `log`, `sessions/`, `context/` | read with `builder runs`, `builder logs <run>`, `builder tool journal_query` |

Each run pins the definitions it starts with, so a change applies from the next run. `builder tools` lists every tool
the machine allows; `builder_tool` calls any of them by name.
