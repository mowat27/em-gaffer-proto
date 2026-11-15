# This prototype

Read when: working in this repository. The design is in [design.md](design.md) and the HTTP contract is in [contract.md](contract.md). This file records what was built and where it deviates from them.

Both ends are in this repository: `gaffer/kit/templates/build-kit/gaffer.ts` (the gaffer) and `builder/server.ts` (the builder). Each runs in its own TSF on its own exe.dev VM: the layer in `gaffer/tsf/layers/gaffer/` runs the gaffer and the layer in `builder/tsf/layers/builder/` runs the build server. [hosting.md](hosting.md) covers the TSFs and the VMs.

## Deviations from the design

| Area | Design | Prototype |
|---|---|---|
| Transport | Tailscale between the gaffer and a builder VM | Tailscale between the gaffer VM and the builder VM, by MagicDNS name (`<vm>.<tailnet>.ts.net`), which keeps the traffic off the Agent Vault proxy. The build server listens on its `host` and `port`, and the callback URL is `http://<callbackHost>:<callbackPort>/jobs/<jobId>`. Both can also run on one machine on 127.0.0.1 |
| `--exec` command | `gaffer.js` | `gaffer.ts`, run on Node 24 type stripping |
| Kit source | A git repository fetched with `--git <kit-url>` | Built from `gaffer/kit` by the gaffer layer's `gaffer_setup` |
| Gaffer home | `~/.em/gaffers/<name>/` | `gaffer/tsf/data/layers/gaffer/gaffers/<name>/` (`~/gaffer/tsf/data/...` on the VM) |
| Gaffer CLI | `em gaffer create/start/stop/list` | None. The gaffer layer provides `gaffer_setup`, `gaffer_start` and `gaffer_stop`, and `just gaffer vm launch` creates the gaffer's host |
| Gaffer host | Runs the gate, so it has the app's full stack (Node, Docker, Supabase CLI) | The gaffer VM has Node, git and Docker from the base image, and no Supabase CLI. The gate is empty, so nothing needs them |
| Gate | The build, then the slice's tests | The `gate` setting, a shell command run in the clone. Empty (the default) passes |
| Builder time limit | Below the gaffer's timeout | `jobTimeoutMinutes`, default 20. The gaffer waits `turnTimeoutMinutes` minus 2 minutes |
| Builder 400 | Malformed request | Also returned when `repo.base` is not a hex commit sha or `callback` does not end in `/jobs/<jobId>` |
| Builder 503 | `Retry-After` | `Retry-After: 15` |
| Builder 422 `missing` | Unmet `requires` | Also lists `repo:<key>` when the repository cannot be reached with `git ls-remote` |
| Gaffer callback | 204 or 410 | Also 400 for a malformed body and 404 for any other path |
| `task.attempt` | Attempt number | From `$GAFFER_ATTEMPT`, default 1 |
| Builder extras | None | `GET /health` and `GET /status`, used by the builder's TSF. `/status` reports the `pi` configuration the next job will use |
| Builder agent | A real build agent | The `pi` agent builds the slice in the app directory (`appDir`, the builder setting, default `.` for the repository root), with read, write, edit, grep, find, ls and read-only git, npm, npx and docker tools. It has no shell and writes no logbook |
| Setup | Not specified | Before `pi` starts the builder runs `setupCommands` (`npm ci`) and `baseCheckCommands` (`npx tsc --noEmit`) in the app directory. A base that is not set up fails the job with `target repository is not set up: ...` |
| Workspaces | Deleted after the job | The newest `keepWorkspaces` (default 3) are kept for debugging. `.slice.json`, `node_modules/` and `.scratch/` are excluded from the patch |

## Target repository and board

- Target repository: `git@github.com:mowat27/invoice-lite.git`, the default of the gaffer's `repoUrl` setting. The gaffer clones the target, merges patches into it and pushes them back, with a deploy key that has write access. The builder fetches base commits from it with a read-only deploy key. The app is at its root (the builder's `appDir` is `.`). It contains no `.build-kit/` or `.eventmodelers/`.
- Board: Invoice Lite (see [design.md](design.md), section 9). Only slice statuses and comments are changed on it. The model itself is left alone.
