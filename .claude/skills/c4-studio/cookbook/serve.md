# Recipe: Serve

Start the studio server as a background task, wait until it reports its URL, open the browser and report. The server serves the UI and API on 127.0.0.1.

## Variables

- `PORT` — optional port from the prompt; default per `cookbook/preferences.md` → Studio URL
- `OPEN` — whether to open the browser; default yes

## Instructions

- Run from the project root as a background task (`run_in_background`); never in the foreground, it does not exit.
- Prefer `just c4-studio serve`; fall back to the CLI when `just` is missing.
- First use installs node modules and builds the web bundle, so allow up to two minutes.
- If the port is already serving C4 Studio (`curl -s http://127.0.0.1:<port>/api/status` succeeds), do not start a second server; report the running one.
- Leave the server running at the end. This is the one recipe that does.

## Workflow

1. Startup check.
2. Check for a running server on `PORT` as above.
3. Start, as a background task:
   - `just c4-studio serve` (add `--port <n>` when `PORT` was given), or
   - `node "<skill-dir>/app/bin/c4-studio.mjs" serve [--port <n>]`
4. Poll the task output until a line containing `http://127.0.0.1:` appears. If the task exits or 2 minutes pass, report the output tail and stop.
5. Open the URL: `open <url>` on macOS, `xdg-open <url>` on Linux. Skip if `OPEN` is no.
6. If `c4-studio/.env` is missing, mention that chat needs keys (copy `.env.example`).

## Report

The URL, that the server runs as a background task (give its task id so it can be stopped), and the key warning if any.
