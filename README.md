# Gaffer / Builder prototype

Prototypes the gaffer / builder architecture on two exe.dev VMs. A gaffer takes Planned slices from the Invoice Lite board and dispatches each one over HTTP, across the tailnet, to a build server on its own VM. The build server runs a `pi` agent in a fresh clone of the target repository and returns a patch. The gaffer applies, merges and pushes the patch, then settles the slice on the board.

Each system runs in its own Tiny Software Factory (TSF): a web app with an agent that starts, stops, configures and monitors it.

```
gaffer VM (gaffer TSF)                                                         builder VM (builder TSF)
board <-platform contract-> shared runner --spawns--> gaffer.ts --POST /slices--> server.ts --> pi agent
                            (gaffer kit, in the gaffer's clone)    ^     tailnet       |
                                                                   +--POST callback----+
```

## Design docs

Use these to prime agents building tooling for the architecture.

- [docs/design.md](docs/design.md): layers, runner, platform contract, gaffer kit and CLI, `gaffer.js`, builder.
- [docs/contract.md](docs/contract.md): the gaffer / builder HTTP contract. Both ends are in `gaffer/kit/templates/build-kit/gaffer.ts` and `builder/server.ts`.
- [docs/prototype.md](docs/prototype.md): what this repository built and how it deviates from the design (`gaffer.ts`, a locally built kit, factory layers in place of the `em gaffer` CLI, the gate, builder extras).
- [docs/hosting.md](docs/hosting.md): the two TSFs, locally or on their exe.dev VMs: launching, network, the feature map and the features curtailed by the split.

## Layout

| Path | What |
|---|---|
| `docs/` | `design.md`, `contract.md`, `prototype.md`, `hosting.md`, and `reference/stub-harness.sh` (the original spike's `--exec` script) |
| `gaffer/kit/` | The gaffer build kit (a custom eventmodelers stack): `stack.json`, `templates/build-kit/gaffer.ts` (the runner's `--exec` command), empty `CLAUDE.md` and `AGENTS.md`. `gaffer_setup` turns it into a git repository and installs it with `eventmodelers init --stack gaffer --git` |
| `gaffer/tsf/` | The gaffer's TSF (project root `gaffer/`). The `gaffer` layer runs the runner with `gaffer.ts` and covers settings, board slices and planning, and events. The `theme` layer installs the Ember colour theme. The app has the Overview and Gaffer screens |
| `gaffer/vm/` | `vm.sh` (laptop side: launch, key, token) and `setup.sh` (VM side: eventmodelers CLI, deploy key) |
| `builder/server.ts` | The build server: `POST /slices`, one job at a time, a fresh clone per job, the `pi` agent, `git format-patch` back to the gaffer's callback |
| `builder/pi-agent/` | The builder's `pi` agent directory (`PI_CODING_AGENT_DIR`): `settings.json`, `AGENTS.md`, `prompts/build.md`, `extensions/`, `skills/`. Plain Pi files, edited directly. The next job picks up changes. `sessions/` (gitignored) holds every job's pi session log |
| `builder/tsf/` | The builder's TSF (project root `builder/`). The `builder` layer runs the build server and covers settings (including the `pi` invocation), events and pi sessions. The app has the Builder screen and the Pi agent file tree. Pages: `ai-docs/pi.md` (Pi reference) and `builder/pi-agent.md` |
| `builder/vm/` | `vm.sh` (laptop side: launch, key) and `setup.sh` (VM side: pi, deploy key, docker check) |
| `builder/jobs/` | Job workspaces (the newest 3 are kept) and every job's log (gitignored) |
| `gaffer/tsf/data/`, `builder/tsf/data/` | Runtime state (gitignored): settings, events, logs, pids, the board token (gaffer only) and the gaffer home (`layers/gaffer/gaffers/<name>/repo`) |
| `examples/` | Sample `slice.json` files for the Invoice Lite slices, and `em-skills/` (eventmodelers skills kept for reference) |
| `.claude/skills/hosts/` | Skill for launching the gaffer's or the builder's TSF locally or on a VM |
| `.claude/skills/import-from-build-kit/` | Skill for porting `@eventmodelers/cli` and build-kit behaviour into the builder's `pi` agent |

## Running

On exe.dev, builder first ([docs/hosting.md](docs/hosting.md) has the details):

```
just builder vm launch <builder-vm>
just builder vm key <builder-vm> <owner/repo>
just gaffer vm launch <gaffer-vm> <builder-vm>
just gaffer vm key <gaffer-vm> <owner/repo>
just gaffer vm token <gaffer-vm>
```

Then:

1. On `https://<builder-vm>.exe.xyz`, Start the build server.
2. On `https://<gaffer-vm>.exe.xyz`, set the board, repository and branch, then Set up and Start.
3. Plan a slice from the Gaffer screen or the top bar, and watch both screens.

Each TSF's agent can do the same with its `builder_*` or `gaffer_*` tools. Run `launch` again to redeploy changed code.

Locally, both TSFs default to 127.0.0.1 (builder 8788, callback 8787), so they work together on one machine:

```
av just builder tsf start --port 8012
av just gaffer tsf start --port 8013
```

To try the builder's `pi` agent by hand with its own settings:

```
just pi [pi args]
```

## Customising the builder's agent

- **Files.** Edit `builder/pi-agent/` (instructions, prompt template, extensions, skills), then run `just builder vm launch <builder-vm>` to deploy. A redeploy copies the laptop's tracked files over the VM's, so edits made on the VM in the Pi agent tree, including model picks saved to `settings.json`, are overwritten.
- **Invocation.** The `pi_*` builder settings (`pi_command`, `pi_agentDir`, `pi_provider`, `pi_model`, `pi_thinking`, `pi_args`, `pi_timeoutMinutes`) set the command line. Use the Builder screen or `builder_set_setting`.
- **Model.** The live provider, model and thinking level come from `builder/pi-agent/settings.json`, falling back to the `pi_*` settings. The Builder screen and the top bar's Model and Effort pickers write both.
- Changes apply to the next job.

## Secrets

- **Provider keys.** Each TSF's `tsf/.env` holds only placeholders. On a VM, `/etc/agent-vault.env` routes provider calls through the Agent Vault proxy and the TSF's systemd unit reads it. `launch` writes `tsf/.env` with the placeholder `agent-vault`. Locally, the `av` wrapper does the same.
- **Board token.** Gaffer only. Read from `EVENTMODELERS_TOKEN`, else from `gaffer/tsf/data/layers/gaffer/board-token` (mode 600). `just gaffer vm token <gaffer-vm>` stores it on the gaffer VM through `gaffer_set_token`. It goes only into the gaffer clone's `.eventmodelers/config.json` and is never shown or logged. The builder VM never holds it.
- **Repository access.** `vm key` adds each VM's deploy key to the target repository: read-only for the builder, with write access for the gaffer.
