# Gaffer / Builder prototype factory

A Tiny Software Factory (TSF) that prototypes the gaffer / builder architecture: a gaffer takes Planned slices from the
Invoice Lite board, dispatches each one over HTTP to a build server, the build server runs a stub `pi` agent that adds
an entry to a logbook, and the gaffer applies, merges, pushes and settles the slice.

```
Eventmodelers board <-platform contract-> shared runner --spawns--> gaffer.ts --POST /slices--> builder/server.ts
                                          (gaffer kit, in the gaffer's clone)      ^                  |
                                                                                   +---POST callback--+
```

## Layout

| Path | What |
|---|---|
| `gaffer/kit/` | The gaffer build kit (a custom eventmodelers stack): `stack.json`, `templates/build-kit/gaffer.ts` (the runner's `--exec` command), empty `CLAUDE.md` and `AGENTS.md`. `gaffer_setup` turns it into a git repository and installs it with `eventmodelers init --stack gaffer --git` |
| `builder/server.ts` | The build server: `POST /slices`, one job at a time, a fresh clone per job, the `pi` agent, `git format-patch` back to the gaffer's callback |
| `tsf/layers/gaffer/` | Factory layer: runs the gaffer (runner + gaffer.ts), settings, board slice listing and planning, events, the Gaffer page |
| `tsf/layers/builder/` | Factory layer: runs the build server, settings including the full `pi` invocation, events, the Builder page |
| `tsf/pages/Gaffer.md`, `tsf/pages/Builder.md` | Progress pages, rewritten by the layers as events arrive |
| `tsf/data/layers/{gaffer,builder}/` | Runtime state (gitignored): settings, events, logs, pids, the gaffer home (`gaffers/<name>/repo`) |
| `tmp/briefs/` | The brief this was built from |

## Running

```
av just tsf start          # the factory, at http://127.0.0.1:8010 (tsf/.env)
```

Then in the factory (Settings > Advanced > Gaffer / Builder, or ask the agent):

1. `builder_start`
2. `gaffer_setup` (once, and after changing the board, repository or name), then `gaffer_start`
3. `gaffer_plan_slice CreateClient` and watch the two pages.

## Secrets

- `tsf/.env` holds only the placeholder `set-in-agent-vault`; the `av` wrapper routes provider calls through the vault proxy.
- The board token is read from `EVENTMODELERS_TOKEN`, else from `tsf/data/layers/gaffer/board-token` (mode 600). It goes only into the gaffer clone's `.eventmodelers/config.json` and is never shown or logged.

## Contract

The gaffer <-> builder HTTP contract is Appendix A of the brief: `POST /slices` (202 / 400 / 422 `{missing}` / 503 + `Retry-After`) and the callback `POST <callback>` with `{outcome: "done", patch}` or `{outcome: "failed", reason}` (204 accepted, 410 stale). Both ends are in `gaffer/kit/templates/build-kit/gaffer.ts` and `builder/server.ts`.

Differences from Appendix A in this prototype: both servers run locally (no Tailscale, no VM); the `--exec` command is `gaffer.ts` (TypeScript on Node 24, not `gaffer.js`); the kit repository is built locally from `gaffer/kit` instead of being fetched from GitHub; the gaffer home lives under `tsf/data/layers/gaffer/gaffers/<name>` instead of `~/.em/gaffers/<name>`; there is no `em gaffer` CLI, the factory layer plays that role.
