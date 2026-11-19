# This prototype

Read when: working in this repository. The design is in [design.md](design.md) and the HTTP contract is in [contract.md](contract.md). This file records what was built and where it deviates from them.

Both ends are in this repository: `gaffer/kit/templates/build-kit/gaffer.ts` (the gaffer) and `builder/server/` (the builder's side of the contract). Each runs on its own exe.dev VM. The gaffer runs in its own TSF: the layer in `gaffer/tsf/layers/gaffer/` runs it. The builder runs without a TSF: the build server is `builder server run`, under the systemd unit `builder-server` that `builder/vm/install.sh` installs. The builder's TSF is an optional client of its CLI. [hosting.md](hosting.md) covers the VMs and the TSFs. The builder's C4 model is [architecture/workspace.dsl](architecture/workspace.dsl).

## Deviations from the design

| Area | Design | Prototype |
|---|---|---|
| Transport | Tailscale between the gaffer and a builder VM | Tailscale between the gaffer VM and the builder VM, by MagicDNS name (`<vm>.<tailnet>.ts.net`), which keeps the traffic off the Agent Vault proxy. The build server listens on the machine config's `server.host` and `server.port` (default 127.0.0.1:8788; on a VM `install.sh` sets the host to the VM's tailnet name), and the callback URL is `http://<callbackHost>:<callbackPort>/jobs/<jobId>`. Both can also run on one machine on 127.0.0.1 |
| `--exec` command | `gaffer.js` | `gaffer.ts`, run on Node 24 type stripping |
| Kit source | A git repository fetched with `--git <kit-url>` | Built from `gaffer/kit` by the gaffer layer's `gaffer_setup` |
| Gaffer home | `~/.em/gaffers/<name>/` | `gaffer/tsf/data/layers/gaffer/gaffers/<name>/` (`~/gaffer/tsf/data/...` on the VM) |
| Gaffer CLI | `em gaffer create/start/stop/list` | None. The gaffer layer provides `gaffer_setup`, `gaffer_start` and `gaffer_stop`, and `just gaffer vm launch` creates the gaffer's host |
| Gaffer host | Runs the gate, so it has the app's full stack (Node, Docker, Supabase CLI) | The gaffer VM has Node, git and Docker from the base image, and no Supabase CLI. The gate is empty, so nothing needs them |
| Gate | The build, then the slice's tests | The `gate` setting, a shell command run in the clone. Empty (the default) passes |
| Builder time limit | Below the gaffer's timeout | The machine config's `server.jobTimeoutMinutes` (default 20), capped by the builder's own `budgetMinutes` (supabase-api 20, its implement step 10). The reason names the step: `job exceeded N min during <step>`. The gaffer waits `turnTimeoutMinutes` minus 2 minutes |
| Builder 400 | Malformed request | Also returned when `repo.base` is not a hex commit sha or `callback` does not end in `/jobs/<jobId>` |
| Builder 503 | `Retry-After` | `Retry-After: 15`. Also returned, as `{"error":"draining"}`, while the server is drained through its control inbox |
| Builder 422 `missing` | Unmet `requires` | The capabilities are the active builder's `provides`: supabase-api provides `stack:supabase` and `stack:stub` (the gaffer's default `requires`). Also lists `repo:<key>` when the repository cannot be reached with `git ls-remote` |
| Gaffer callback | 204 or 410 | Also 400 for a malformed body and 404 for any other path |
| `task.attempt` | Attempt number | From `$GAFFER_ATTEMPT`, default 1 |
| Builder extras | None | `GET /health`. There is no status endpoint: the builder's state is the machine feed, `builder/runs/index.jsonl`. The control inbox, `builder/control/`, drains, resumes and cancels |
| Builder restart and cancel | Not specified | A server that starts sends one `failed` callback, `builder restarted during <step>`, for each job a stopped server left behind. A cancel through the control inbox fails the job with `cancelled by operator` |
| Builder agent | A real build agent | Each job is a headless run of the active builder's workflow ([A job](#a-job)). Its implement step runs the `supabase-api` pi agent in the app directory (the prepare step's `appDir`, default `.` for the repository root), with read, write, edit, grep, find, ls, read-only git, npm, npx and read-only docker, done, halt, capture-learning and context_get. It has no shell and writes no logbook |
| Setup | Not specified | The workflow's prepare step runs `npm ci` and `npx tsc --noEmit` in the app directory before the agent starts. A base that is not set up fails the job with `target repository is not set up: ...` |
| Workspaces | Deleted after the job | Each job is a run, `builder/runs/<runId>/`, with its clone in `workspace/`. The newest `server.keepWorkspaces` (default 3) run trees keep their workspaces. Everything else under `builder/runs` (each run's `run.json`, log, journal and blobs, sessions, context store, pinned definitions and summary, snapshots, and the machine feed's lines) is kept for `server.retentionDays` (default 30), then deleted; a tree with a live run is never touched `.slice.json`, `node_modules/` and `.scratch/` are excluded from the patch |

## The builder

The builder is split into a contract adapter, a runtime and a workflow engine. Every agent is a directory in one tree, and every capability is a tool that an agent, the CLI or an agent's HTTP API reaches equally.

| Path | What |
|---|---|
| `builder/server/` | The contract: `POST /slices`, `GET /health`, one job at a time, the callback, the control inbox. It knows nothing about pi, agents or workspaces |
| `builder/runtime/` | Runs. Every run is its own process (`node runtime/main.ts <runId>`), registered in `runs/<runId>/run.json`. It resolves the agent's `agent.yml`, prepares the workspace, starts pi, owns the journal, serves an agent's API, arms triggers and relays messages |
| `builder/engine/` | Workflows: the step walker, the steps (`clone`, `prepare`, `classify`, `checks`, `commit`, `verify`), the Handlebars renderer, listeners, sidecars and the context store |
| `builder/ops/` | The tool core (`core/`, one module per tool group), its pi adapter (`pi-extension.ts`), the process adapter (`process.ts`) and the machine config (`config.ts`, packaged `config.yml`) |
| `builder/cli/` | The `builder` CLI, a thin wrapper over the tools |
| `builder/agentics/` | `agents/` (one directory per agent), `builders/` (workflow modules, templates and `active.yml`), `shared/` (skills, extensions, gates, listeners, partials, agent templates, sample dispatches in `data/dispatches/`), `history/` (previous versions of changed definitions) and `changesets/` |
| `builder/runs/`, `builder/control/` | Runtime state (gitignored): one folder per run, the machine feed `runs/index.jsonl`, the server's control inbox and outbox, and `control/notifications.jsonl` |
| `builder/vm/` | `vm.sh`, `setup.sh`, `install.sh` and the systemd units `builder-server.service` and `builder-ops.service` |
| `builder/tsf/` | The optional TSF. Its `builder` layer calls the CLI with `--json` and keeps no settings |

### A job

The server starts each accepted dispatch as a headless run of the active builder's workflow, in an empty workspace. The active builder is `agentics/builders/active.yml` (`supabase-api`), unless the machine config's `server.builder` names another. The first step that fails fails the job, with no partial patch.

| Step | Kind | Does |
|---|---|---|
| clone | code | Clones `repo.url` at `repo.base` |
| prepare | code | Branch `job`, the patch excludes, `npm ci`, `npx tsc --noEmit`, `.slice.json` |
| classify | code | The slice kind (state-change, state-view, automation, webhook or translation) and the verdict (`changes.verdict`, NEW or CHANGED) |
| scaffold | template | Renders the kind's Handlebars set into the app, with `BUILD:` markers for the agent. Only state-change and state-view have a set. A kind with no set, or a render error, skips it |
| implement | agent | The `supabase-api` agent fills the markers, runs the build and the slice tests, and calls `done`, which runs the commit-scope checks |
| checks | code | The commit-scope checks again, including that no `BUILD:` marker is left |
| commit | code | One commit with the job's trailers, then `git format-patch base..HEAD` as the patch |

A `tool-summariser` sidecar summarises every 10 tool calls in two lines, journaled as `sidecar.output`, off the step path. `supabase-api-verified` runs the same build, then a `verify` step: the verifier's code checks and Jev questions. `dev/slice-lab` runs it.

### Agents

An agent is a directory under `agentics/agents/` with an `agent.yml`, at any depth. Its id is its path: `supabase-api`, `verifier`, `ops`, `tool-summariser`, `dev/slice-lab`. `agent.yml` says what the agent loads (prompt, skills, extensions, prompt templates), its gates, its tools, what it may write, its areas, what it may start, and optionally an `api:` and `triggers:`. A folder's `defaults.yml` applies to the agents beneath it. The model is pi's own `settings.json` beside `agent.yml`.

- Any agent or workflow runs with `builder run <id>` (`just builder run <id>`), in the mode its `agent.yml` gives or `--mode headless|interactive|rpc|durable`, in an `empty`, `none`, `dir` or `snapshot` workspace.
- pi starts with discovery off and gets every resource as an explicit, pinned path, so a definition changed while a run works never reaches it.
- Definitions change through the definitions tools, which validate each change, refuse a stale `expectedVersion`, keep the previous version in `history/` and refuse to widen the caller's tools.
- A child run never gets more tools than its parent.

### Journal and machine feed

- Every run with a journal has `runs/<runId>/journal.jsonl`: every tool call (input and output), gate decision, step and outcome, and the model's side (`model.select`: model and thinking level; `model.system`: the prompt sections; `model.prompt`: each prompt; `model.message`: each response's thinking, text and tool calls, with its `model.usage`), with payloads over 8 KB in `blobs/` and a `summary.json` at the end. The journal is the source of truth for a run: `run_story` reads a job's whole tree of runs from the journals as one story, which the builder TSF's Sessions tab shows. Server jobs, workflow runs, their child runs, durable runs and named runs always have one. Any other run started directly has one with `--journal`.
- The machine feed, `runs/index.jsonl`, is the one monitoring source: server state, run and step start and end, job results, callback outcomes, notifications and definition changes. `builder events [--since] [-f]` replays and follows it.
- Secrets are redacted in the journal, not in a run's raw `log` or pi's session files. `run_log` (the TSF's Logs tab) hides them when it reads a log.

### Machine config

One layered YAML config per machine, lowest first: built-in defaults, `builder/ops/config.yml` (packaged), `~/.gaffer/config.yml`, `$GAFFER_CONFIG`, `--config`. Maps merge, lists replace, and a broken layer stops the runtime. It holds the tool limit every agent runs within, the server settings (`host`, `port`, `jobTimeoutMinutes`, `callbackRetries`, `keepWorkspaces`, `retentionDays`, `builder`, `runsDir`), the `pi` command and the notify sinks. The packaged layer sets no limit. Only the operator edits it: no tool writes a layer. `builder config` shows the merged config and the layer of each value, and `builder config reload` tells live runs.

### Ops agent

`agentics/agents/ops` is an ordinary agent run in durable mode. A turn starts when the operator writes to it (its API on 127.0.0.1:8090, `POST /messages`, or `builder attach`), when a job fails (the `job.failed` trigger, which follows the feed) and once a day (cron). It reads journals and context from files, writes the control inbox, changes definitions through the definitions tools, fixes the builder's code on a git branch, checks a fix with a child run and ends each investigation with `notify_operator`. It never connects to the build server or a running job. On a VM it is the optional `builder-ops` unit (`vm.sh launch --ops`): `vm/ops-tmux.sh` runs it in interactive mode (pi's TUI) in a detached tmux session (`tmux -L ops`, session `ops`), and `just builder ops` from `~` attaches to it. In that mode its triggers are not armed and each start is a new session; its API still listens on 127.0.0.1:8090, so it and a durable ops run cannot run together. On the laptop, from the repository root: `OPS_API_TOKEN=... just builder run ops --dir builder --journal`.

`~/builder` on a VM is a copy, not a git repository, so the ops agent's git tools fail there. Pushing a fix from a VM needs the repository cloned there with a write key.

## Target repository and board

- Target repository: `git@github.com:mowat27/invoice-lite.git`, the default of the gaffer's `repoUrl` setting. The gaffer clones the target, merges patches into it and pushes them back, with a deploy key that has write access. The builder fetches base commits from it with a read-only deploy key. The app is at its root (the prepare step's `appDir` is `.`). It contains no `.build-kit/` or `.eventmodelers/`.
- Board: Invoice Lite (see [design.md](design.md), section 9). The gaffer changes only slice statuses and comments on it. The model is left alone, except for one addition: a second chapter, Reporting, holds the STATE_VIEW slice ClientDirectory (status Created), whose read model projects `ClientCreated` through a linked copy. `ClientCreated` is owned by CreateClient in the Invoicing chapter, so ClientDirectory tests `sourceEvents` for an event owned in another scope ([contract.md](contract.md), "Source events"). Set it to Planned to build it.
