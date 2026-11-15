# Gaffer / Builder prototype factory

A Tiny Software Factory (TSF) that prototypes the gaffer / builder architecture. A gaffer takes Planned slices from the Invoice Lite board and dispatches each one over HTTP to a build server. The build server runs a `pi` agent in a fresh clone and returns a patch. The gaffer applies, merges and pushes the patch, then settles the slice on the board.

The default `pi` agent is a stub: it appends one line to `LOGBOOK.md`. The `pi` invocation and the agent files are meant to be rebuilt from inside the factory.

```
Eventmodelers board <-platform contract-> shared runner --spawns--> gaffer.ts --POST /slices--> builder/server.ts
                                          (gaffer kit, in the gaffer's clone)      ^                  |
                                                                                   +---POST callback--+
```

## Design docs

Use these to prime agents building tooling for the architecture.

- [docs/design.md](docs/design.md): layers, runner, platform contract, gaffer kit and CLI, `gaffer.js`, builder.
- [docs/contract.md](docs/contract.md): the gaffer / builder HTTP contract. Both ends are in `gaffer/kit/templates/build-kit/gaffer.ts` and `builder/server.ts`.
- [docs/prototype.md](docs/prototype.md): what this repository built and how it deviates from the design (no Tailscale or VM, `gaffer.ts`, a locally built kit, the factory layer in place of the `em gaffer` CLI).
- [docs/hosting.md](docs/hosting.md): the gaffer and the builder each in their own TSF, locally or on separate exe.dev VMs, with the feature map and the features curtailed by the split.

## Layout

| Path | What |
|---|---|
| `docs/` | `design.md`, `contract.md`, `prototype.md`, and `reference/stub-harness.sh` (the original spike's `--exec` script) |
| `gaffer/kit/` | The gaffer build kit (a custom eventmodelers stack): `stack.json`, `templates/build-kit/gaffer.ts` (the runner's `--exec` command), empty `CLAUDE.md` and `AGENTS.md`. `gaffer_setup` turns it into a git repository and installs it with `eventmodelers init --stack gaffer --git` |
| `builder/server.ts` | The build server: `POST /slices`, one job at a time, a fresh clone per job, the `pi` agent, `git format-patch` back to the gaffer's callback |
| `builder/pi-agent/` | The builder's `pi` agent directory (`PI_CODING_AGENT_DIR`): `settings.json`, `AGENTS.md`, `prompts/build.md`, `extensions/`, `skills/`. Plain Pi files, edited directly. The next job picks up changes |
| `gaffer/tsf/`, `gaffer/vm/` | The gaffer's own TSF (project root `gaffer/`) and its VM scripts: `just gaffer tsf start`, `just gaffer vm launch\|key\|token`. See [docs/hosting.md](docs/hosting.md) |
| `builder/tsf/`, `builder/vm/` | The builder's own TSF (project root `builder/`) and its VM scripts: `just builder tsf start`, `just builder vm launch\|key`. See [docs/hosting.md](docs/hosting.md) |
| `tsf/layers/gaffer/` | Factory layer: runs the gaffer (runner + gaffer.ts), settings, board slice listing and planning, events, the Gaffer page |
| `tsf/layers/builder/` | Factory layer: runs the build server, settings including the full `pi` invocation, events, the Builder page |
| `tsf/layers/titlebar/` | Factory layer: titlebar |
| `tsf/pages/` | Factory pages kept in the repository: `ai-docs/pi.md` (Pi reference) and `builder/pi-agent.md` (how the builder's agent is configured). The Gaffer and Builder progress pages are rewritten by the layers as events arrive and live in the factory's page store, not here |
| `tsf/data/layers/{gaffer,builder}/` | Runtime state (gitignored): settings, events, logs, pids, the board token, the gaffer home (`gaffers/<name>/repo`) |
| `examples/` | A sample `slice.json` (CreateInvoice) |
| `LOGBOOK.md` | The target of the stub agent's entries |
| `.claude/skills/hosts/` | Skill for launching the gaffer's or the builder's TSF locally or on a VM |
| `.claude/skills/import-from-build-kit/` | Skill for porting `@eventmodelers/cli` and build-kit behaviour into the builder's `pi` agent |

## Running

```
av just tsf start          # the factory, at http://127.0.0.1:8010 (port set in tsf/.env)
```

Then in the factory (Settings > Advanced > Gaffer / Builder, or ask the agent):

1. `builder_start`
2. `gaffer_setup` (once, and after changing the board, repository or name), then `gaffer_start`
3. `gaffer_plan_slice CreateClient` and watch the two pages.

To try the builder's `pi` agent by hand with its own settings:

```
just pi [pi args]
```

## Customising the builder's agent

- **Files.** Edit `builder/pi-agent/` directly (instructions, prompt template, extensions, skills).
- **Invocation.** The `pi_*` builder settings (`pi_command`, `pi_agentDir`, `pi_provider`, `pi_model`, `pi_thinking`, `pi_args`, `pi_timeoutMinutes`) set the command line. Use the Builder panel or `builder_set_setting`.
- **Model.** The live provider, model and thinking level come from `builder/pi-agent/settings.json`, falling back to the `pi_*` settings.
- Changes apply to the next job.

## Secrets

- `tsf/.env` holds only the placeholder `set-in-agent-vault`. The `av` wrapper routes provider calls through the vault proxy.
- The board token is read from `EVENTMODELERS_TOKEN`, else from `tsf/data/layers/gaffer/board-token` (mode 600). It goes only into the gaffer clone's `.eventmodelers/config.json` and is never shown or logged.
