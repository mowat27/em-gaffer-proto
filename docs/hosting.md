# Hosting: one TSF per system

Read when: running, launching or changing the gaffer's or the builder's own TSF, locally or on an exe.dev VM. The design is in [design.md](design.md) and the contract in [contract.md](contract.md). The old single TSF in `tsf/` still runs both systems from the repository root and is unchanged.

## Layout

Each system folder is the project root of its own TSF, made with the `tsf` skill's `install`. A VM receives only its own folder.

| Path | What |
|---|---|
| `gaffer/kit/` | The gaffer build kit (unchanged) |
| `gaffer/tsf/` | The gaffer's TSF: `app/` (the skill's app plus the factory screens), `layers/gaffer/`, `layers/theme/` (the Ember colour theme), `pages/`, `mod.just`, `permissions.json` |
| `gaffer/vm/` | `vm.sh` (laptop side: launch, key, token) and `setup.sh` (VM side: eventmodelers CLI, deploy key) |
| `builder/server.ts`, `builder/pi-agent/` | The build server and its pi agent (unchanged) |
| `builder/tsf/` | The builder's TSF: `app/` (the skill's app plus the factory screens and the pi agent routes), `layers/builder/`, `pages/` (`ai-docs/pi.md`, `builder/pi-agent.md`) |
| `builder/vm/` | `vm.sh` (laptop side: launch, key) and `setup.sh` (VM side: pi 1.5.2, deploy key, docker check) |

Inside each TSF, paths are relative to its folder: the gaffer layer builds the kit from `kit/`, and the builder layer runs `server.ts` with `pi-agent/` and `jobs/`.

## Run locally

```
av just gaffer tsf start --port 8013
av just builder tsf start --port 8012
```

Or set `TSF_PORT` in each `tsf/.env` (copy `tsf/.env.example`). Both layers default to the same addresses as the old TSF (builder `127.0.0.1:8788`, callback `127.0.0.1:8787`), and the local builder shares `builder/jobs/` and `builder/pi-agent/sessions/` with it. Do not run the new builder's server and the old TSF's at the same time.

## Run on exe.dev

```
just builder vm launch <builder-vm>
just builder vm key <builder-vm> <owner/repo>
just gaffer vm launch <gaffer-vm> <builder-vm>
just gaffer vm key <gaffer-vm> <owner/repo>
just gaffer vm token <gaffer-vm>
```

Then Start on the Builder screen (`https://<builder-vm>.exe.xyz`), and on the Gaffer screen (`https://<gaffer-vm>.exe.xyz`) set the board, repository and branch, Set up and Start. Run `launch` again to redeploy changed code: the TSF's data on the VM is kept.

`launch` does this:

1. Creates the VM with `pw-sandbox new <vm> --keep --base tsf-base-img` when it does not exist. The base has node, git, docker, just and the tsf skill.
2. Runs the folder's `vm/setup.sh` on the VM: the gaffer gets the eventmodelers CLI 2.0.57 and the builder gets pi 1.5.2 and a docker check. Both get a deploy key and a systemd drop-in (`KillMode=process`), so a TSF restart leaves the gaffer runner or build server running, as it does on the laptop.
3. Copies the folder's files that git tracks or would track to `~/gaffer` or `~/builder`. No `tsf/data`, `tsf/.env`, `node_modules`, `jobs/` or pi sessions.
4. Installs the TSF with the tsf skill's `vm-tsf.sh install`: the systemd unit `tsf-gaffer.service` or `tsf-builder.service` on port 8000, reading `/etc/agent-vault.env`, restarted on failure and at boot.
5. Sets the host-specific layer settings through the TSF API. The builder gets `host` (its MagicDNS name) and `pi_command`. The gaffer gets `callbackHost` (its own MagicDNS name) and `builderHost` (the builder's).

`key` adds the VM's deploy key to the repository with `gh`: read-only for the builder, with write access for the gaffer. `token` stores the board token on the gaffer VM through `gaffer_set_token`, from `EVENTMODELERS_TOKEN` or a local `board-token` file. The builder VM never holds the token.

### Network

- The contract runs over the tailnet by MagicDNS name, for example `http://<builder-vm>.<tailnet>.ts.net:8788/slices`. `NO_PROXY` in `/etc/agent-vault.env` lists `.ts.net`, so these requests bypass the vault proxy. A `100.x` address would go through it.
- The tailnet ACL lets `tag:sandbox` reach `tag:sandbox` on tcp 8787 (callback) and 8788 (builder). It applies to every sandbox VM.
- The build server listens on the builder's tailnet name and the callback listener on the gaffer's, so neither port is open on any other interface.

## Feature map

Every feature of the old single TSF, and where it lives now.

| Old TSF feature | Gaffer TSF | Builder TSF | Notes |
|---|---|---|---|
| gaffer layer: 12 tools, Settings > Advanced > Gaffer panel, status widget, rules section | Yes | | Kit path now `kit/` |
| builder layer: 13 tools, Settings > Advanced > Builder panel, status widget, rules section | | Yes | Defaults `workspaceDir` `jobs`, `pi_agentDir` `pi-agent` |
| titlebar layer (agent model and effort in the title bar) | | | Superseded. The tsf skill's built-in `model_controls` layer now provides the same pickers in both TSFs, so keeping it duplicated them |
| Left pane Factory nav with status dots | Overview, Gaffer | Builder | Pi terminal entry dropped |
| Left pane Pi agent tree and file editor | | Yes | |
| Left pane Files tree, page selection switches to the page view | Yes | Yes | |
| Top bar: title, restart-factory button | "Gaffer" | "Builder" | |
| Top bar strip: Board, Gaffer, Repo dots, latest commit, Plan a slice | Yes | | |
| Top bar strip: Builder dot, builder Model and Effort (also written to `pi-agent/settings.json`) | | Yes | |
| Overview: Board, Gaffer and Repository stages | Yes | | |
| Overview: Getting started (connect board, set up, start gaffer, plan a slice), Latest builds | Yes | | |
| Overview: Builder stage, "Start the build server" step, builder events in the timeline | | | Curtailed: C1 to C3 |
| Gaffer screen: token, Restart & set up, set up, start/stop, Blocked banner, slices table, board connection, builder link and build rules, addresses, timeline, runner log | Yes | | |
| Builder screen: current job, server, pi agent (with Refresh models), timeline, job and server logs | | Yes | |
| Builder screen: Sessions tab, including the duration histogram and period filter | | Yes | |
| Builder screen: Target branch card | | | Curtailed: C6 |
| `/api/builder-agent/*` routes (files, read, write, sessions, session) | | Yes | |
| Pi terminal (`/api/pi-terminal`, xterm, node-pty) | | | Not ported: it never worked |
| Responsive top bar and workbench, navbar wrapping, chat code-block fix | Yes | Yes | |
| Model panel sorted by name | Yes | Yes | Now built into the skill's Model panel |
| Pages `ai-docs/pi.md`, `builder/pi-agent.md` | | Yes | Paths made relative to `builder/` |
| Ember colour theme, dark mode (runtime data in the old TSF) | Yes | | Kept in git as `layers/theme/`. At every start it creates Ember or refreshes its colours from `theme.ts`, and makes it active in dark mode while the factory is on the default theme. The surface tokens are pinned so it renders exactly as the original |

## Curtailed features

The two TSFs cannot see each other and nothing links them except the contract, so these are gone rather than worked around.

| Code | Feature | Was in | Why it cannot work | Where the information is now |
|---|---|---|---|---|
| C1 | Builder stage: status, current or last job, pi model, Start/Stop | Overview | Reads the builder layer's status and health | Builder screen, builder TSF |
| C2 | "Start the build server" getting-started step | Overview | Reads the builder layer's status and runs its start action | Builder screen Start, builder TSF |
| C3 | Builder events in the merged timeline and Recent events | Overview | Reads the builder layer's event log | Builder screen timeline, builder TSF |
| C4 | Builder dot in the gaffer's top bar, and Board, Gaffer, Repo dots and the latest commit in the builder's | Top bar strip | Each reads the other system's layer | Each TSF shows its own |
| C5 | Builder Model and Effort pickers in the gaffer's top bar | Top bar strip | Write the builder's settings and `pi-agent/settings.json` | Builder TSF top bar |
| C6 | Target branch card | Builder screen | Reads the gaffer's `branch` setting | Gaffer screen, Board connection |

Each TSF's agent also has only its own system's tools.

## Operating notes

- Do not use `just gaffer tsf push` or `just builder tsf push`. The tsf skill's push copies the whole repository to the VM, including the old TSF's `tsf/data` and its board token.
- `launch` copies one way. Edits made on a VM, for example by its TSF agent, are not copied back, and a redeploy overwrites the files git tracks.
- GitHub accepts a deploy key on one repository only. A VM that must reach a second target repository needs another key.
- systemd restarts each TSF on failure and at boot. After a VM reboot, start the build server and the gaffer runner again from their screens, as after a laptop restart.
- A VM starts from the layers' default settings. The settings in use on the first VMs were copied from the old TSF.
