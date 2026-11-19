# Hosting: one VM per system

Read when: running, launching or changing the gaffer's TSF or the builder, locally or on an exe.dev VM. The design is in [design.md](design.md), the contract in [contract.md](contract.md) and the deviations from the design in [prototype.md](prototype.md). The gaffer runs in its own TSF. The builder runs on its own: the build server is `builder server run`, a systemd unit on its VM, and the builder's TSF is an optional client of its CLI. These replaced a single TSF that ran both systems from the repository root.

## Layout

Each system folder is self-contained, and a VM receives only its own folder. Each TSF was made with the `tsf` skill's `install`.

| Path | What |
|---|---|
| `gaffer/kit/` | The gaffer build kit |
| `gaffer/tsf/` | The gaffer's TSF: `app/` (the skill's app plus the factory screens), `layers/gaffer/`, `layers/theme/` (the Ember colour theme), `pages/`, `mod.just`, `permissions.json` |
| `gaffer/vm/` | `vm.sh` (laptop side: launch, key, token) and `setup.sh` (VM side: eventmodelers CLI, deploy key) |
| `builder/server/`, `runtime/`, `engine/`, `ops/`, `cli/` | The builder: the build server, runs, workflows, the tools and the `builder` CLI ([prototype.md](prototype.md), "The builder") |
| `builder/agentics/` | Every agent and builder definition |
| `builder/tsf/` | The builder's optional TSF: `app/` (the skill's app plus the Builder screen and a read-only agent tree), `layers/builder/` (a client of the CLI), `pages/` |
| `builder/vm/` | `vm.sh` (laptop side: launch, key), `setup.sh` (VM side: pi 1.5.2, github.com's host keys, docker check), `repo-key.sh` (VM side: one target repository's deploy key), `install.sh` (VM side: `npm ci`, the machine config, the systemd units, the server restart) and the units `builder-server.service` and `builder-ops.service` |

Paths are relative to each folder: the gaffer layer builds the kit from `kit/`, and the builder keeps its runs in `runs/` and its control inbox in `control/`.

## Run locally

```
just builder server start
av just gaffer tsf start --port 8013
```

`just builder server start` starts the build server as a detached run (`builder server run`, its log in `builder/runs/<runId>/log`). `just builder server stop` and `restart` drain first: a running job finishes, and `--force` cancels it. The build server and the gaffer default to 127.0.0.1 (the server on 8788, the callback on 8787), so the two work together on one machine. Locally the builder runs the laptop's pi (`~/.pi/agent/bin/pi`, the machine config's `pi.command`). Follow the server and its jobs with `node builder/cli/builder.ts events -f`.

The builder's TSF is optional: `av just builder tsf start --port 8012`. Or set `TSF_PORT` in each `tsf/.env` (copy `tsf/.env.example`).

## Run on exe.dev

```
just builder vm launch <builder-vm> [--config <file>] [--ops] [--tsf] [--keep]
just builder vm key <builder-vm> <owner/repo>
just builder vm rejoin <builder-vm> [--keep]
just gaffer vm launch <gaffer-vm> <builder-vm>
just gaffer vm key <gaffer-vm> <owner/repo>
just gaffer vm token <gaffer-vm>
```

The build server is running once `launch` ends. On the Gaffer screen (`https://<gaffer-vm>.exe.xyz`) set the board, repository and branch, Set up and Start. Run `launch` again to redeploy changed code: the gaffer TSF's data, the builder's machine config and its runs on the VM are kept.

The builder's `launch` does this:

1. Creates the VM with `pw-sandbox new <vm> --base tsf-base-img` when it does not exist: an ephemeral tailnet node, which Tailscale removes once the VM has been offline for a while, so a deleted builder VM leaves the tailnet by itself and its name is free for the next one. `--keep` makes a persistent node instead (`pw-sandbox new --keep`), which stays listed after the VM is gone until it is removed in the Tailscale admin console. The base has node, git, docker, just and the tsf skill.
2. Runs `vm/setup.sh` on the VM: pi 1.5.2 in `~/.local/share/builder-pi`, github.com's host keys and a docker check. It makes no deploy key: `key` makes one per target repository.
3. Copies the folder's files that git tracks or would track to `~/builder`. No `runs/`, `control/`, `node_modules`, `tsf/data` or `tsf/.env`.
4. Runs `vm/install.sh` on the VM: `npm ci`; the machine config `~/.gaffer/config.yml`, written once with the server on the VM's MagicDNS name, port 8788, and the pi from step 2 (`--config <file>` replaces it and keeps the old one as `config.yml.bak`), checked before anything starts; the systemd unit `builder-server.service` (`builder server run`, reading `/etc/agent-vault.env`, restarted on failure and at boot); then `builder server restart`, which lets a running job finish first (up to 600 s). `--ops` adds `builder-ops.service`, the ops agent in pi's TUI inside a detached tmux session (`vm/ops-tmux.sh`), and writes `~/.gaffer/ops.env` with a new `OPS_API_TOKEN` (mode 600) when it does not exist. Every install writes `~/justfile` (`mod builder`) when it does not exist, so `just builder <recipe>` works from `~`.
5. With `--tsf`, installs the builder's TSF with the tsf skill's `vm-tsf.sh install`: `tsf-builder.service` on port 8000.

The gaffer's `launch` does this:

1. Creates the VM as above.
2. Runs `vm/setup.sh` on the VM: the eventmodelers CLI 2.0.57, a deploy key and a systemd drop-in (`KillMode=process`), so a TSF restart leaves the gaffer runner running, as it does on the laptop.
3. Copies the folder's files that git tracks or would track to `~/gaffer`. No `tsf/data`, `tsf/.env` or `node_modules`.
4. Installs the TSF with the tsf skill's `vm-tsf.sh install`: the systemd unit `tsf-gaffer.service` on port 8000, reading `/etc/agent-vault.env`, restarted on failure and at boot.
5. Sets the host-specific layer settings through the TSF API: `callbackHost` (its own MagicDNS name) and `builderHost` (the builder's).

`key` gives a VM access to a target repository with `gh`: read-only for the builder, with write access for the gaffer. GitHub accepts a deploy key on one repository only, so the builder's `key` makes the VM a key of its own for each repository (`vm/repo-key.sh`: `~/.ssh/builder_deploy_<owner>_<repo>`, an ssh host alias that uses only that key, and git `insteadOf` rewrites from the repository's GitHub URLs to the alias) and adds it read-only. Run it once per target repository; git on the VM then picks the key by the dispatch's repository URL, and nothing in the builder chooses keys. `gh` needs admin rights on the repository (`gh auth refresh -h github.com -s repo`). Without them, set the key up on the VM and add it by hand: `ssh <vm>.exe.xyz 'bash -s -- <owner/repo>' < builder/vm/repo-key.sh` prints its public key, which goes in the repository's Settings > Deploy keys, read-only. A builder VM set up before keys were per repository has one key, `~/.ssh/builder_deploy`; `key` adopts it for the repository it is already registered on. `token` stores the board token on the gaffer VM through `gaffer_set_token`, from `EVENTMODELERS_TOKEN` or a local `board-token` file. The builder VM never holds the token.

On the builder VM: `systemctl status builder-server`, `journalctl -u builder-server`, and `node ~/builder/cli/builder.ts events -f` (or `runs`, `logs <run>`, `config`). With `--ops`, `ssh -t <vm>.exe.xyz`, then `just builder ops` attaches to the ops agent; Ctrl-b d detaches and the agent keeps running. To change a server setting, edit `~/.gaffer/config.yml`, then run `builder config reload` and `builder server restart`.

### Network

- The contract runs over the tailnet by MagicDNS name, for example `http://<builder-vm>.<tailnet>.ts.net:8788/slices`. `NO_PROXY` in `/etc/agent-vault.env` lists `.ts.net`, so these requests bypass the vault proxy. A `100.x` address would go through it.
- The tailnet ACL lets `tag:sandbox` reach `tag:sandbox` on tcp 8787 (callback) and 8788 (builder). It applies to every sandbox VM.
- The build server listens on the builder's tailnet name (the machine config's `server.host`) and the callback listener on the gaffer's, so neither port is open on any other interface.
- The ops agent's API listens on 127.0.0.1:8090 only.

## Current VMs

| VM | Runs | URL |
|---|---|---|
| `pw-gaffer-1` | The gaffer TSF (`tsf-gaffer.service`) and the gaffer runner | https://pw-gaffer-1.exe.xyz |
| `pw-builder-1` | The build server (`builder-server.service`) and, when launched with `--tsf`, the builder TSF (`tsf-builder.service`) | https://pw-builder-1.exe.xyz (TSF only) |

Both have deploy keys on `mowat27/invoice-lite`. Redeploy them with `just builder vm launch pw-builder-1 --tsf` and `just gaffer vm launch pw-gaffer-1 pw-builder-1`. A builder VM launched before the server became a unit runs the build server from its TSF until it is launched again; `install.sh` then stops that server and starts the unit.

## Feature map

Every feature of the former single TSF, and where it lives now.

| Single TSF feature | Gaffer TSF | Builder TSF | Notes |
|---|---|---|---|
| gaffer layer: 12 tools, Settings > Advanced > Gaffer panel, status widget, rules section | Yes | | Kit path now `kit/` |
| builder layer: 13 tools, Settings > Advanced > Builder panel, status widget, rules section | | Reworked | 11 tools, each a builder CLI call with `--json`; status widget and rules section kept. No settings panel: server settings are machine config, an agent's model is its `settings.json` |
| titlebar layer (agent model and effort in the title bar) | | | Superseded. The tsf skill's built-in `model_controls` layer now provides the same pickers in both TSFs, so keeping it duplicated them |
| Left pane Factory nav with status dots | Overview, Gaffer | Builder | Pi terminal entry dropped |
| Left pane Pi agent tree and file editor | | Read only | Now the `builder/agentics` tree. Definitions change only through the builder's versioned definitions tools |
| Left pane Files tree, page selection switches to the page view | Yes | Yes | |
| Top bar: title, restart-factory button | "Gaffer" | "Builder" | |
| Top bar strip: Board, Gaffer, Repo dots, latest commit, Plan a slice | Yes | | |
| Top bar strip: Builder dot, builder Model and Effort | | Yes | The dot follows the machine feed. A pick is a versioned `agent_update` of an agent's `settings.json` (default `supabase-api`) |
| Overview: Board, Gaffer and Repository stages | Yes | | |
| Overview: Getting started (connect board, set up, start gaffer, plan a slice), Latest builds | Yes | | |
| Overview: Builder stage, "Start the build server" step, builder events in the timeline | | | Curtailed: C1 to C3 |
| Gaffer screen: token, Restart & set up, set up, start/stop, Blocked banner, slices table, board connection, builder link and build rules, addresses, timeline, runner log | Yes | | |
| Builder screen: current job, server, pi agent (with Refresh models), timeline, job and server logs | | Reworked | From the machine feed: server state and start, stop and restart, current and last job, an agent's model, timeline (with the model and thinking level, pi's last line and the commit count). Tabs Logs (the latest job's log and the server log, secrets hidden), Sessions, Ops (operator notifications) and Config (the merged machine config) |
| Builder screen: Sessions tab, including the duration histogram and period filter | | Yes | From the journals (`run_story`), not pi's session files: one entry per job or direct run, with its whole tree of runs in one list |
| Builder screen: Target branch card | | | Curtailed: C6 |
| `/api/builder-agent/*` routes (files, read, write, sessions, session) | | files, read | Read only, over `builder/agentics` |
| Pi terminal (`/api/pi-terminal`, xterm, node-pty) | | | Not ported: it never worked |
| Responsive top bar and workbench, navbar wrapping, chat code-block fix | Yes | Yes | |
| Model panel sorted by name | Yes | Yes | Now built into the skill's Model panel |
| Pages `ai-docs/pi.md`, `builder/pi-agent.md` | | Yes | Paths made relative to `builder/` |
| Ember colour theme, dark mode (runtime data in the single TSF) | Yes | | Kept in git as `layers/theme/`. At every start it creates Ember or refreshes its colours from `theme.ts`, and makes it active in dark mode while the factory is on the default theme. The surface tokens are pinned so it renders exactly as the original |

## Curtailed features

The two systems cannot see each other and nothing links them except the contract, so these are gone rather than worked around.

| Code | Feature | Was in | Why it cannot work | Where the information is now |
|---|---|---|---|---|
| C1 | Builder stage: status, current or last job, pi model, Start/Stop | Overview | Reads the builder's status and controls its server | Builder screen, builder TSF, or the builder CLI |
| C2 | "Start the build server" getting-started step | Overview | Starts the builder's server | `builder server start`, or Start on the Builder screen |
| C3 | Builder events in the merged timeline and Recent events | Overview | Reads the builder's machine feed | `builder events`, or the Builder screen timeline |
| C4 | Builder dot in the gaffer's top bar, and Board, Gaffer, Repo dots and the latest commit in the builder's | Top bar strip | Each reads the other system | Each TSF shows its own |
| C5 | Builder Model and Effort pickers in the gaffer's top bar | Top bar strip | Change an agent's `settings.json` through the builder CLI | Builder TSF top bar |
| C6 | Target branch card | Builder screen | Reads the gaffer's `branch` setting | Gaffer screen, Board connection |

Each TSF's agent also has only its own system's tools.

## Operating notes

- Do not use `just gaffer tsf push` or `just builder tsf push`. The tsf skill's push copies the whole repository to one VM: both systems, and any local `tsf/data`, including the local gaffer's board token.
- `launch` copies one way. Edits made on a VM, for example by its TSF agent or the ops agent, are not copied back, and a redeploy overwrites the files git tracks, definitions included.
- On a VM, `~/builder` is a copy, not a git repository, so the builder's git tools fail there.
- GitHub accepts a deploy key on one repository only. A builder VM gets one key per target repository from `just builder vm key <vm> <owner/repo>`. The gaffer's `key` still gives its VM a single key (`~/.ssh/gaffer_deploy`), so a gaffer VM reaches one target repository.
- `just builder vm rejoin <vm>` puts a builder VM back on the tailnet: `tailscale logout`, then pw-sandbox's `first-boot.sh` again (ephemeral, or persistent with `--keep`). Use it for an ephemeral VM that was paused or stopped long enough to be dropped, or for one that joined as `<vm>-1` because a stale machine held its name (remove that machine in the admin console first; `launch` warns when the names differ). When the tailnet name changes, the machine config's `server.host` follows and the build server restarts after any running job; run `just gaffer vm launch <gaffer-vm> <vm>` so the gaffer's `builderHost` follows too.
- systemd restarts each TSF, the build server and the ops agent on failure and at boot. Quitting pi in the ops session ends the unit (exit 0): `sudo systemctl start builder-ops` starts it again. After a VM reboot, start the gaffer runner again from the Gaffer screen, as after a laptop restart.
- A new gaffer VM starts from the gaffer layer's default settings: the Invoice Lite board and `mowat27/invoice-lite` on `main`. Change them on the Gaffer screen. A new builder VM gets the machine config `install.sh` writes and each agent's model from its `settings.json` in the repository.
- The ops agent's API token is in `~/.gaffer/ops.env` on the VM (`OPS_API_TOKEN=...`), never in YAML. `install.sh --ops` generates it once and keeps it.
- Run data is kept for 30 days (`server.retentionDays`), clones for the newest 3 jobs (`server.keepWorkspaces`). `builder tool runs_prune '{"dryRun":true}'` shows what the next pass deletes.
