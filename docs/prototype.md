# This prototype

Read when: working in this repository. The design is in [design.md](design.md) and the HTTP contract is in [contract.md](contract.md). This file records what was built and where it deviates from them.

Both ends are in this repository: `gaffer/kit/templates/build-kit/gaffer.ts` (the gaffer) and `builder/server.ts` (the builder). The factory layers in `tsf/layers/gaffer/` and `tsf/layers/builder/` run them.

## Deviations from the design

| Area | Design | Prototype |
|---|---|---|
| Transport | Tailscale between the gaffer and a builder VM | Both run locally on configured hosts and ports. The callback URL is `http://<callbackPublicHost or callbackHost>:<callbackPort>/jobs/<jobId>` |
| `--exec` command | `gaffer.js` | `gaffer.ts`, run on Node 24 type stripping |
| Kit source | A git repository fetched with `--git <kit-url>` | Built locally from `gaffer/kit` by the factory's `gaffer_setup` |
| Gaffer home | `~/.em/gaffers/<name>/` | `tsf/data/layers/gaffer/gaffers/<name>/` |
| Gaffer CLI | `em gaffer create/start/stop/list` | None. The gaffer layer provides `gaffer_setup`, `gaffer_start`, `gaffer_stop` |
| Gate | The build, then the slice's tests | The `gate` setting, a shell command run in the clone. Empty (the default) passes |
| Builder time limit | Below the gaffer's timeout | `jobTimeoutMinutes`, default 20. The gaffer waits `turnTimeoutMinutes` minus 2 minutes |
| Builder 400 | Malformed request | Also returned when `repo.base` is not a hex commit sha or `callback` does not end in `/jobs/<jobId>` |
| Builder 503 | `Retry-After` | `Retry-After: 15` |
| Builder 422 `missing` | Unmet `requires` | Also lists `repo:<key>` when the repository cannot be reached with `git ls-remote` |
| Gaffer callback | 204 or 410 | Also 400 for a malformed body and 404 for any other path |
| `task.attempt` | Attempt number | From `$GAFFER_ATTEMPT`, default 1 |
| Builder extras | None | `GET /health` and `GET /status`, used by the factory. `/status` reports the `pi` configuration the next job will use |
| Builder agent | A real build agent | The default `pi` agent only appends one line to the logbook file (`builder/pi-agent/prompts/build.md`) |

## Target repository and board

- Target repository: `git@github.com:mowat27/em-gaffer-proto.git`. The gaffer clones it, merges patches into it and pushes them back. The builder fetches base commits from it. It contains no `.build-kit/` or `.eventmodelers/`.
- Board: Invoice Lite (see [design.md](design.md), section 9). Only slice statuses and comments are changed on it. The model itself is left alone.
