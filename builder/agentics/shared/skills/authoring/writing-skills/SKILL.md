---
name: writing-skills
description: How skills are written, loaded, changed and versioned in this builder's agent tree (agentics/shared/skills). Use before you create or change a skill, or when you decide whether guidance belongs in a skill, a prompt template or an agent's SYSTEM.md.
---

# Writing skills

Paths below are relative to `builder/`.

A skill is a folder holding a `SKILL.md`: YAML front matter with `name` and `description`, then the instructions. pi
lists every loaded skill's name and description in the agent's system prompt and reads the whole file only when a task
calls for it. So the description says what the skill covers and when to use it.

## Where skills live and how agents load them

- Shared skills: `agentics/shared/skills/<group>/<name>/SKILL.md`. A skill's id is its path below `shared/skills/`,
  e.g. `build/build-state-change` (`agentics/shared/skills/build/build-state-change/SKILL.md`).
- An agent loads skills by reference in its agent.yml: `uses: { skills: [shared:build/*] }` loads a group,
  `shared:build/build-state-change` one skill, `own:skills/<name>` one in the agent's own folder. Nothing is found
  implicitly: pi starts with discovery off and gets each skill by path (`runtime/resolve.ts`, `runtime/paths.ts`).
- Supporting files sit beside `SKILL.md`. Refer to them by a path relative to the skill, as the build skills do with
  `../emmett-reference/SKILL.md`.

## Changing one

- Read it: `skill_get { "id": "build/build-state-change" }` gives its files, its content and its `version`.
- Change it: `skill_update { "id": "...", "expectedVersion": "<version>", "edits": [{ "find": "...", "replace": "..." }],
  "reason": "..." }`. `find` must occur exactly once. Or replace the file: `"files": { "SKILL.md": "<whole file>" }`. A
  stale `expectedVersion` is refused: read again and redo the change.
- Create one: `skill_create { "id": "<group>/<name>", "files": { "SKILL.md": "..." } }`. An agent loads it once its
  agent.yml names it (`agent_update`), or when a group glob such as `shared:build/*` already covers it.
- Validation (`ops/definitions/validate.ts`) refuses a SKILL.md without front matter and a description, and a change
  that breaks something that was valid (deleting a skill an agent loads). The result's `affects` lists the agents and
  builders that load the skill.
- A run pins the skills it starts with (`runtime/pin.ts`), so a change reaches the next run, not a running one. Each
  run's `agent.start` journal event records the hash of every skill it loaded: compare two runs (`journal_query`,
  `metrics`) to see whether a change helped. `history_list`, `history_diff` and `history_rollback` show and undo it.

## Writing a good one

- One kind of work per skill. Give the steps in the order the agent takes them, and say what is already done for it
  (the scaffold, the checks) so it does not redo it.
- Name real files and real tools. Do not paste an API the agent can read: the build skills share
  `agentics/shared/skills/build/emmett-reference/SKILL.md` for that.
- Code before the model: a rule that code can check belongs in a gate, a check
  (`agentics/builders/supabase-api/checks.ts`) or a template, not in prose.
- Skill, prompt template or SYSTEM.md: a skill is guidance loaded when a task matches it. A prompt template
  (`agentics/agents/supabase-api/prompts/implement.md`, the `prompt_*` tools) is the message that starts a run
  (`/implement ...`). SYSTEM.md (or APPEND_SYSTEM.md) is who the agent is and what it always does.
