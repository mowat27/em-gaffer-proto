# Recipe: User Guide

Start a local web server for the skill's user guide (`guide/index.html`) and open it in the browser. The guide covers how to use the skill, C4 basics and the shape gallery, in the Precision Weave glass theme with a light, dark and system mode selector.

## Variables

- `USER_PROMPT` — optional port ("user-guide 5050", "on port 5050")
- `PORT` — the port from the prompt, else `47144`
- `SKILL_DIR` — the absolute path of this skill's directory

## Instructions

- Serve `SKILL_DIR`, not `guide/`: the gallery loads the shapes from `../references/shapes/`.
- Use `npx serve`. When `PORT` is taken it picks a free port and prints it, so always take the URL from its output, never from `PORT`.
- Leave the server running when you report. It stops when the session ends or its background task is stopped.

## Workflow

1. Start the server as a background task:
   ```
   npx --yes serve --no-clipboard --no-request-logging --listen tcp://127.0.0.1:<PORT> <SKILL_DIR>
   ```
2. Wait up to 15 seconds for the line `Accepting connections at <url>` in its output. Take `<url>` from that line.
3. Open `<url>/guide/` in the browser (`open` on macOS, `xdg-open` on Linux).
4. When no URL appears, or the output shows an error, stop the task and report the output verbatim. When `npx` itself is missing, report that Node.js is needed, and that `guide/index.html` can also be opened directly as a file.

## Report

```
C4 Modeller guide: <url>/guide/
Serving <SKILL_DIR> in the background<, on <port> because <PORT> was in use>.
```
