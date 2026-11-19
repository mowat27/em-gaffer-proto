# Gaffer / Builder prototype

Prototypes the gaffer / builder architecture on two exe.dev VMs. A gaffer takes Planned slices from the Invoice Lite board and dispatches each one over HTTP, across the tailnet, to a build server on its own VM. The build server runs a `pi` agent in a fresh clone of the target repository and returns a patch. The gaffer applies, merges and pushes the patch, then settles the slice on the board.

The gaffer runs in its own Tiny Software Factory (TSF): a web app with an agent that starts, stops, configures and monitors it. The builder runs on its own, under systemd on its VM, and its TSF is an optional client of its CLI.

```
gaffer VM (gaffer TSF)                                                         builder VM (systemd)
board <-platform contract-> shared runner --spawns--> gaffer.ts --POST /slices--> build server --> job run --> pi agent
                            (gaffer kit, in the gaffer's clone)    ^     tailnet       |
                                                                   +--POST callback----+
```

## Design docs

Use these to prime agents building tooling for the architecture.

- [docs/design.md](docs/design.md): layers, runner, platform contract, gaffer kit and CLI, `gaffer.js`, builder.
- [docs/contract.md](docs/contract.md): the gaffer / builder HTTP contract. Both ends are in `gaffer/kit/templates/build-kit/gaffer.ts` and `builder/server/`.
- [docs/prototype.md](docs/prototype.md): what this repository built and how it deviates from the design (`gaffer.ts`, a locally built kit, factory layers in place of the `em gaffer` CLI, the gate, builder extras).
- [docs/hosting.md](docs/hosting.md): the gaffer's TSF and the builder, locally or on their exe.dev VMs: launching, network, the feature map and the features curtailed by the split.

## Layout

| Path | What |
|---|---|
| `docs/` | `design.md`, `contract.md`, `prototype.md`, `hosting.md`, and `reference/stub-harness.sh` (the original spike's `--exec` script) |
| `gaffer/kit/` | The gaffer build kit (a custom eventmodelers stack): `stack.json`, `templates/build-kit/gaffer.ts` (the runner's `--exec` command), empty `CLAUDE.md` and `AGENTS.md`. `gaffer_setup` turns it into a git repository and installs it with `eventmodelers init --stack gaffer --git` |
| `gaffer/tsf/` | The gaffer's TSF (project root `gaffer/`). The `gaffer` layer runs the runner with `gaffer.ts` and covers settings, board slices and planning, and events. The `theme` layer installs the Ember colour theme. The app has the Overview and Gaffer screens |
| `gaffer/vm/` | `vm.sh` (laptop side: launch, key, token) and `setup.sh` (VM side: eventmodelers CLI, deploy key) |
| `builder/server/` | The build server: `POST /slices`, one job at a time, each job a run of the active builder's workflow, the patch back to the gaffer's callback. It runs as `builder server run` (a run of kind `server`), under systemd's `builder-server` unit on a VM or detached on the laptop |
| `builder/runtime/`, `builder/engine/`, `builder/ops/`, `builder/cli/` | Runs (one process per run, its journal, workspaces, pi), workflows (steps, Handlebars scaffold, sidecars), the tool core and the machine config, and the `builder` CLI ([docs/prototype.md](docs/prototype.md), "The builder") |
| `builder/agentics/` | Every agent and builder definition: `agents/` (one directory per agent with an `agent.yml` and pi's `settings.json`: `supabase-api`, `verifier`, `ops`, `tool-summariser`, `dev/slice-lab`), `builders/` (the `supabase-api` workflows and their templates), `shared/` (skills, extensions, gates, sample dispatches), `history/` |
| `builder/tsf/` | The builder's optional TSF (project root `builder/`), a client of the builder CLI. The `builder` layer calls the CLI with `--json` and keeps no settings. The app has the Builder screen (server, runs and journals, notifications, machine config) and a read-only agent tree. Pages: `ai-docs/pi.md` (Pi reference) and `builder/pi-agent.md` |
| `builder/vm/` | `vm.sh` (laptop side: launch, key), `setup.sh` (VM side: pi, github.com's host keys, docker check), `repo-key.sh` (VM side: a target repository's deploy key), `install.sh` (VM side: `npm ci`, the machine config, the systemd units) and the unit files `builder-server.service`, `builder-ops.service` |
| `builder/runs/`, `builder/control/` | Runtime state (gitignored): one folder per run (`run.json`, log, journal, context store, workspace; the newest 3 run trees keep their workspaces), the machine feed `runs/index.jsonl`, the server's control inbox and the operator's notifications |
| `builder/agentics/agents/dev/slice-lab/` | The dev loop as an agent: builds sample dispatches with the verified workflow, diagnoses failures and tunes the skills (`just builder run dev/slice-lab`) |
| `builder/agentics/agents/verifier/` | The verifier: code checks and Jev decide whether a build passes. Launched directly it takes `/verify`, `/list-rules` and `/change-rules`. The verified workflow's `verify` step runs the same checks |
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

1. `just builder vm launch` has started the build server (the systemd unit `builder-server`). Its TSF runs only with `--tsf`.
2. On `https://<gaffer-vm>.exe.xyz`, set the board, repository and branch, then Set up and Start.
3. Plan a slice from the Gaffer screen or the top bar, and watch both screens.

Each TSF's agent can do the same with its `builder_*` or `gaffer_*` tools. Run `launch` again to redeploy changed code.

Locally, the build server and the gaffer's TSF default to 127.0.0.1 (builder 8788, callback 8787), so they work together on one machine:

```
just builder server start
av just gaffer tsf start --port 8013
```

The builder's TSF is optional: `av just builder tsf start --port 8012`.

To run any of the builder's agents or workflows by hand (`builder run`; an interactive agent runs pi in the terminal):

```
just builder run supabase-api --mode interactive --dir .   # the build agent, in this repository
just builder run verifier --mode interactive --dir .       # the verifier: /verify, /list-rules, /change-rules
just builder run dev/slice-lab                             # build sample dispatches, verify them, tune the skills
```

The build server runs under systemd on a VM (`builder-server.service`) and as a detached run on the laptop:

```
just builder server start
just builder server restart [--force]   # drains first: a running job finishes (--force cancels it)
just builder server stop [--force]
```

## Customising the builder's agent

- **Files.** The build agent is `builder/agentics/agents/supabase-api/` (`agent.yml`, `APPEND_SYSTEM.md`, `prompts/implement.md`), its skills, extensions and gates are in `builder/agentics/shared/`, and its workflow and templates are in `builder/agentics/builders/supabase-api/`. Change them with the definitions tools (`builder tool agent_update`, `skill_update`, ...), which validate each change and keep the previous version, or edit the files. Run `just builder vm launch <builder-vm>` to deploy. A redeploy copies the laptop's tracked files over the VM's, so definitions changed on the VM, including model picks, are overwritten.
- **Server settings.** Host, port, job time limit, callback retries, workspaces kept, the active builder and the `pi` command are machine config: `builder/ops/config.yml`, `~/.gaffer/config.yml`, `GAFFER_CONFIG` or `--config`. `builder config` shows each value and its layer. After an edit, run `builder config reload`, and `builder server restart` for the server keys.
- **Model.** Each agent's provider, model and thinking level are in its `settings.json`. The builder TSF's Model and Effort pickers change it as a versioned definition change.
- Changes apply to the next run: a run pins its definitions when it starts.

## Secrets

- **Provider keys.** Each TSF's `tsf/.env` holds only placeholders. On a VM, `/etc/agent-vault.env` routes provider calls through the Agent Vault proxy, and the TSFs' and the builder's systemd units read it. `launch` writes `tsf/.env` with the placeholder `agent-vault`. Locally, the `av` wrapper does the same.
- **Board token.** Gaffer only. Read from `EVENTMODELERS_TOKEN`, else from `gaffer/tsf/data/layers/gaffer/board-token` (mode 600). `just gaffer vm token <gaffer-vm>` stores it on the gaffer VM through `gaffer_set_token`. It goes only into the gaffer clone's `.eventmodelers/config.json` and is never shown or logged. The builder VM never holds it.
- **Repository access.** `vm key` adds a VM's deploy key to a target repository: read-only for the builder, with write access for the gaffer. GitHub accepts a deploy key on one repository only, so a builder VM gets a key of its own per target repository: run `just builder vm key <vm> <owner/repo>` once for each.
