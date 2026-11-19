# Recipe: Install

Install C4 Studio into the current project by running the skill's installer. The installer stamps files once; the project owns them afterwards. The app stays in the skill directory.

## Variables

- `SKILL_DIR` — absolute path of this skill directory
- `PROJECT` — the project root (the current directory; the git toplevel when the session started in a subdirectory)

## Instructions

- Run the installer from the project root, never from inside the skill directory (it refuses).
- The installer never overwrites and writes nothing outside the project. Do not edit what it stamped, and do not add other files.
- Do not create `.env` or copy keys. The user does that.

## Workflow

1. `cd` to `PROJECT`.
2. Run `bash "<skill-dir>/scripts/install.sh"`.
3. Read its output. Collect the lines starting `stamped`, `created`, `appended` and `kept`.
4. If node modules for the app are missing (`<skill-dir>/app/node_modules`), do not install them now: the first `just c4-studio` command or CLI run does it automatically.

## Report

- Stamped or created, appended, and kept (one short list each; omit empty ones).
- Next steps: copy `c4-studio/.env.example` to `c4-studio/.env` and add provider keys (the placeholder `agent-vault` is valid when the vault proxy is in use); then `just c4-studio serve`.
- Re-running `install` is safe: it reports anything missing and keeps everything else.
