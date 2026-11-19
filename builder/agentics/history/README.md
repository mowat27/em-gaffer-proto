# Definition history

Previous versions of every definition the definitions tools changed (ops/core/definitions.ts), kept before each change:

    <kind>/<id>/<stamp>-<version12>/       the files exactly as they were
    <kind>/<id>/<stamp>-<version12>.json   { kind, id, version, savedAt, by, change: { tool, op, next }, reason }

Kinds: builder, agent, skill, template, gate, listener, prompt, active (builders/active.yml). A version is the sha256 of
the definition's files. `builder tool history_list '{"kind":"skill","id":"build/build-state-change"}'` lists them,
history_diff compares two, history_rollback restores one. The build server falls back to the newest valid builder
version here when the active builder does not load (E2).
