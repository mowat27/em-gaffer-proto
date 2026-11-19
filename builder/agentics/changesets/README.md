# Change sets

An agent whose agent.yml has `definitions: { changes: propose }` (or that runs below one) does not write definitions:
each change tool it calls is validated and saved here instead, for the operator.

    <id>/changeset.json   { id, state, by, tool, args, kind, defId, baseVersion, version, diff, affects, reason }
    <id>/change.diff      the change as a unified diff

Review with `builder tool changeset_list` (or `'{"id":"<id>"}'` for one), apply with
`builder tool changeset_apply '{"id":"<id>"}'`. Applying calls the tool again with the same arguments, so a change set
whose definition has changed since is refused (re-propose it).
