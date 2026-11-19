# System design: gaffer and builder

Read when: building tooling for the gaffer, the gaffer kit, the gaffer CLI, the builder, or anything that integrates with the eventmodelers runner. The transport between gaffer and builder is in [contract.md](contract.md). What this repository actually built is in [prototype.md](prototype.md).

Slices are built by a specialised builder agent on a separate VM. A gaffer connects the board, the builder and the repository. The gaffer is our own eventmodelers build kit. It takes the place of stack kits such as the Supabase kit, which are not used.

## 1. Layers and components

| Layer | Contains | Knows about eventmodelers kits |
|---|---|---|
| Gaffer | The gaffer kit installed in the gaffer's own clone of the target repository: the shared eventmodelers runner plus `gaffer.js` | Yes. Every kit-specific part lives here, including the files the kit format requires but the gaffer doesn't use (an empty `CLAUDE.md` and `AGENTS.md`) |
| Builder | A service on a separate VM that implements one slice per job | No |
| Target repository | The application code, and the gaffer's build baselines in `.gaffer/slices/` | No. It never contains `.build-kit/` or `.eventmodelers/` |

```
Eventmodelers board <--platform contract--> shared runner --spawns--> gaffer.js --POST /slices--> builder (VM)
                                            \---------- gaffer kit, in the gaffer's clone ----------/    |
                                                                       ^                                  |
                                                                       +-----------POST callback----------+
```

| Component | Responsibility |
|---|---|
| Shared runner (`ralph.js`, `ralph-exec.js`) | The platform contract: identity, heartbeat, discovery, claim, slice fetch, status push, retries, Blocked after 5 failed attempts |
| `gaffer.js` | The runner's `--exec` command. Turns a build turn into a builder job, then applies, gates, merges, pushes and records the outcome |
| Builder | Implements exactly one slice per job and returns the commits as a patch |

## 2. System rules

- Networking between the gaffer and the builder runs over Tailscale.
- The system is fully AFK. No component ever asks a human a question.
- The runner blocks while a slice is being built. A turn is limited to 60 minutes (`turnTimeoutMinutes`).
- Several gaffers can work the same board. The board's atomic claim hands each slice to exactly one of them.
- The target repository never contains kit files. It holds the gaffer's build baselines in `.gaffer/slices/`, written only by the gaffer.
- Every change to a slice goes through the board.
- The builder has no board access and no write access to the target repository.
- The board token is never shown in a UI or written to a log.

## 3. The eventmodelers runner

Facts established for CLI 2.0.10 (`ralph-exec.js`).

- **Inputs.** The `--exec` command gets the prompt as its last argument and in the file named by `$RALPH_PROMPT_FILE`. Its working directory is the project directory. `EVENTMODELERS_TOKEN` and `EVENTMODELERS_AGENT_ID` are in its environment. The `RALPH_*` and `EVENTMODELERS_*` variables are the runner's environment for the command.
- **Build turns.** A build turn's prompt ends with `Your task now: build the <status> slice "<title>" (id=<sliceId>, context="<context>")`, followed by a `Handover: on|off` line. Board-connected runs start the prompt with `board=<boardId> token=$EVENTMODELERS_TOKEN org=<orgId> baseUrl=<url>`.
- **Slice definition.** Before each build turn the runner writes the slice to `.build-kit/.slices/<contextSlug>/<folder>/slice.json`. `.build-kit/.slices/<ctx>/index.json` maps slice ids to folders.
- **Other turns.** The same command is also called for board-change task turns and learnings-cleanup turns.
- **Outcome.** A build turn that exits without recording a status through `eventmodelers slice-status <status>` is a failed attempt. The runner retries it and sets the slice to Blocked after 5 attempts. If the tree was clean at claim time, it also resets uncommitted changes and deletes new `feature/*` branches.
- **Timeout.** A turn is killed after `turnTimeoutMinutes`, 60 by default.
- **Configuration.** `localAi.exec` in `.eventmodelers/config.json` persists the `--exec` command.
- **Build kits.** The format is documented in the "Build Your Own Build Kit" section of https://app.eventmodelers.ai/llms-full.txt. A custom kit is installed with `eventmodelers init --stack <name> --git <url>`. With `useShared: true` in its `stack.json`, the installer copies the shared runner over the kit's files.

[reference/stub-harness.sh](reference/stub-harness.sh) is a working `--exec` command from the original spike. It shows how to read the prompt, find a slice's `slice.json` through `index.json`, and record an outcome with `eventmodelers slice-status`.

## 4. Platform contract (board, handled by the shared runner)

The runner behaves as a BUILD agent. Every board call sends `x-token` and `x-agent-id`. Base path: `/api/org/{org}/boards/{board}`.

| # | Purpose | Call |
|---|---|---|
| B1 | Discover slices in the pickup status (`Planned`) | `GET …/slicedata/slices` |
| B2 | Claim a slice (atomic move to InProgress; 409 means another agent holds it) | `POST …/slices/{sliceId}/claim` with `{"fromStatus":"Planned"}` |
| B3 | Fetch the full slice definition into `.build-kit/.slices/` | `GET …/slicedata?contextName={ctx}&sliceId={id}` |
| B4 | Push the slice status | `POST …/nodes/events` with a `node:changed` event that sets `sliceStatus` on the slice's `SLICE_BORDER` node |
| B5 | Comment on a slice | `POST …/nodes/{sliceId}/comments` |
| B6 | Heartbeat every 15 seconds with a stable agent id | `POST /api/agent-alive`, with a JWT from `GET /api/org/{org}/prompts/realtime-token` |

Outcomes:

- **Recorded outcome.** The status `gaffer.js` records with `eventmodelers slice-status` is pushed to the board when the turn ends.
- **No recorded outcome.** A turn that ends without one is a failed attempt. If the working tree was clean at claim time, the runner resets uncommitted changes and deletes any `feature/*` branches created since the claim.
- **5th failed attempt.** The runner sets the slice to `Blocked` and comments with the reason.

## 5. Gaffer kit

A custom stack in its own git repository, installed with `eventmodelers init --stack gaffer --git <kit-url>`.

```
stack.json                       {"label":"Gaffer","kitSubdir":"build-kit","useShared":true,"needsBoardId":true}
templates/build-kit/gaffer.js    the --exec command
templates/build-kit/CLAUDE.md    empty
templates/build-kit/AGENTS.md    empty
templates/root/                  empty: the kit installs into an existing repository
```

- **Shared runner.** With `useShared: true` the installer copies the shared runner over the kit's own files. The platform contract therefore always comes from the eventmodelers CLI, and `eventmodelers re-init` keeps it current.
- **No build skills.** The kit ships none. Slices are built by the builder.
- **Not the Supabase kit.** The gaffer must not use or reuse the Supabase kit or any other stack kit.

## 6. Gaffer CLI

The CLI does all the work and never prompts. The `/em gaffer` skill is a thin wrapper that collects missing values and calls the CLI.

```
em gaffer create <name> --board <id> --org <id> --token <token> --base-url <url> --repo <git-url> --builder <url> [--requires stack:supabase ...]
em gaffer start <name>
em gaffer stop <name>
em gaffer list
```

`create` sets up `~/.em/gaffers/<name>/`:

1. Clones `--repo` into `repo/`.
2. Adds `.build-kit/` and `.eventmodelers/` to `repo/.git/info/exclude`.
3. Runs `eventmodelers init --stack gaffer --git <kit-url>` in `repo/`.
4. Writes `repo/.eventmodelers/config.json` with the board credentials (token, organization id, board id, base URL), `localAi.exec: "node .build-kit/gaffer.js"` and `turnTimeoutMinutes: 60`.
5. Writes `gaffer.json` with the name, the builder URL and `requires`. `repo:<url>` is always included in `requires`.

`start` runs `eventmodelers run --exec` in `repo/`.

## 7. `gaffer.js`

Inputs come from the runner (section 3).

- A build turn is recognised by the task line. Look up the slice id in `.build-kit/.slices/*/index.json` to find the folder holding `slice.json`.
- Board-change task turns and learnings-cleanup turns are ignored: exit 0 without doing anything.

Build turn:

1. Load the full slice from the board. For a read model (`STATE_VIEW`) slice, also load the definition of each event its read models project from the slice that owns it, in any scope on the board ([contract.md](contract.md), "Source events"). When the slice or a source event cannot be loaded, fail the turn.
2. When the slice is empty (a `STATE_CHANGE` slice with no command or no event, a `STATE_VIEW` slice with no read model), post the reason on the slice, run `eventmodelers slice-status Blocked` and exit 0.
3. Record `base` as `git rev-parse HEAD` on main.
4. Compare the slice and its source events with the baseline at `base` (see "Baselines" below). The verdict is `NEW`, `CHANGED` or `UNCHANGED`.
5. On `UNCHANGED`, dispatch nothing: run the gate on `base`, run `eventmodelers slice-status Done` (or `Waiting` when `Handover: on`) and exit 0.
6. Start the callback listener on the Tailscale address and create a new `jobId`.
7. POST `/slices` with `changes` and handle the response as [contract.md](contract.md) describes.
8. Wait for the callback with a timeout just under the 60-minute turn limit. When the timeout is reached, fail the turn (see below).
9. Accept only the callback for the current `jobId`.
10. On `done`:
    1. Apply the patch on a `feature/<slice>` branch with `git am -3`.
    2. Fail the turn when the patch touches `.gaffer/`.
    3. Commit the new baseline on the feature branch.
    4. Run the gate: the build, then the slice's tests.
    5. Fast-forward main and push it.
    6. Run `eventmodelers slice-status Done`, or `Waiting` when `Handover: on`.
    7. Exit 0.
11. On `failed`:
    1. Post the reason on the slice with `eventmodelers info "<reason>" --kind note`.
    2. Fail the turn.
12. When `git am` or the gate fails, fail the turn.

Baselines:

- After every successful build the gaffer commits `.gaffer/slices/<sliceId>.json` with the code, as a separate commit `gaffer: record <slice> baseline`. It holds the `slice` and `sourceEvents` that were dispatched, as JSON with sorted keys.
- The next build reads the baseline from `base`. Each branch therefore carries its own baselines, a merge brings them with the code, and two branches that rebuilt the same slice conflict on its baseline as they do on its code.
- Only the gaffer writes `.gaffer/`. A failed turn leaves the previous baseline in place.
- This replaces the build kits' `eventmodelers build-baseline check|record`, which records board node hashes in `.build-kit/`. The gaffer compares content, keeps the previous definitions so the builder can see what changed, and keeps kit files out of the target repository.

A failed turn exits 0 without recording a status. The shared runner retries a non-zero exit in place for ever, without counting it, so the slice would never reach Blocked. An exit 0 without a status is a failed attempt: the runner puts the slice back to Planned and sets it to Blocked, with a comment, after 5.

Repository and host:

- The target repository has a GitHub remote. Main is pushed before the first dispatch, and after every merge, so each new base commit is on GitHub.
- The gaffer host runs the gate, so it has the app's full stack. For the Supabase app that means Node, Docker for the Postgres test container, and the Supabase CLI.

## 8. Builder

- Exposes `POST /slices` on its Tailscale address. Dispatch handling is in [contract.md](contract.md).
- Runs each job in a fresh clone or worktree named after its `jobId`. The workspace is deleted after the job whatever the outcome, including when the callback returns 410.
- Implements only the slice in the request, with `slice.json` as the spec. When a detail is unclear it makes the most sensible assumption, builds the slice and records each assumption as a one-line code comment.
- Commits on top of `base` and returns `git format-patch <base>..HEAD` in a `done` callback.
- Enforces its own time limit, below the gaffer's timeout. When the limit is reached it sends a `failed` callback.
- Has read access to the repository only. It has no repository write credentials and no board access.
- Building the same slice twice is acceptable. Workspace isolation keeps the VM consistent.
- The VM setup provides the tools the slice tests need, which include Node and Docker for the Postgres test container.

## 9. Example board

"Invoice Lite", board id `fe92ad7f-3eba-4a40-8528-d2f16d6081a3`, has the chapter Invoicing with four slices, plus a Reporting chapter added to test cross-scope source events ([prototype.md](prototype.md)):

| Slice | Type |
|---|---|
| CreateClient | STATE_CHANGE |
| Clients | STATE_VIEW |
| CreateInvoice | STATE_CHANGE |
| Invoices | STATE_VIEW |

[examples/createinvoice-slice.json](../examples/createinvoice-slice.json) is a real `slice.json` for CreateInvoice.
