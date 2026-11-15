# The builder's pi agent, the idiomatic way

The build server runs one `pi` process per job with an isolated agent directory, `pi-agent/`
(`PI_CODING_AGENT_DIR`). Its configuration is plain Pi files, not a settings blob, and every one of them is
edited directly — real files, with `read`/`edit`/`write`, no page indirection:

| File | What it is |
|---|---|
| `pi-agent/settings.json` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `defaultTools`, `defaultProjectTrust` |
| `pi-agent/AGENTS.md` | standing instructions, always in context |
| `pi-agent/prompts/build.md` | the per-job prompt template, invoked as `/build <args>` |
| `pi-agent/extensions/*.ts` | hooks (gates, tool rewrites, custom tools), auto-discovered — drop one in and it loads, no setting to flip |
| `pi-agent/skills/<name>/SKILL.md` | procedures with bundled scripts, loaded on demand |

Edit any of these in place and the next build picks it up — no restart (the build server doesn't cache their
content, `pi` reads them fresh each job), no separate "apply" step, no page to keep in sync.

Everything else is a plain CLI invocation, built from `builder_get_settings`/`builder_set_setting`
(`pi_command`, `pi_agentDir`, `pi_provider`, `pi_model`, `pi_thinking`, `pi_args`, `pi_timeoutMinutes`) exactly
as `pi --provider … --model … --thinking … <flags> -p -- "/build …"` would be typed by hand. There is no
`pi_prompt` template string and no `pi_extensions` list: the prompt is a real prompt template file and
extensions are real files in `extensions/`, both loaded the way Pi loads them for anyone.

`pi_args` still carries real flags that are not a file: `--no-session` (a one-shot job needs no persisted
session), `--no-mcp --no-themes` (not used here). Context files, prompt templates, skills and extensions are
left on so the files above are actually read.

The build server also writes the full slice spec it was dispatched with to `.slice.json` in the job's own
workspace (next to the clone) before running `pi`, and passes that filename as `prompts/build.md`'s 9th
argument — `pi`'s cwd is the workspace, so the agent reads it as a plain relative path.

See [`ai-docs/pi.md`](../../ai-docs/pi.md) for the full picture (sections 2, 6, 7 and 8 are the relevant ones).
