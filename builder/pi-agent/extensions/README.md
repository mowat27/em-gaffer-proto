# Extensions

Drop a `*.ts` file here (or `<name>/index.ts`) and it loads automatically on the next job — no setting to flip.
See `builder/tsf/pages/ai-docs/pi.md` section 8 for the extension API and recipes (gates, tool rewrites, custom
tools).

| Extension | What it adds |
|---|---|
| `dev-tools.ts` | `git` (read-only), `npm`, `npx` and `docker` (read-only) tools, run in pi's working directory |
| `done/` | The `done` tool: runs the slice commit-scope checks and writes `$BUILDER_DONE_FILE` when they pass |
| `halt.ts` | The `halt` tool: writes `$BUILDER_HALT_FILE` with a reason when the slice cannot be built |
| `job-context.ts` | Puts the job's facts (`BUILDER_*` variables) into the agent's system prompt |
| `learn.ts` | The `capture-learning` tool |
