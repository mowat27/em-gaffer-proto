# Gaffer / builder HTTP contract

Read when: building or changing either end of the gaffer to builder transport. Design context is in [design.md](design.md).

The gaffer dispatches one slice per job to the builder with `POST /slices`. The builder returns the result by calling back to the gaffer.

## Dispatch: `POST /slices`

```json
{
  "requires": ["repo:github.com/<org>/<app>", "stack:supabase"],
  "repo": { "url": "git@github.com:<org>/<app>.git", "base": "<sha>" },
  "task": { "sliceId": "…", "title": "CreateClient", "context": "Invoicing", "handover": false, "attempt": 1 },
  "slice": { "…": "slice.json, verbatim" },
  "callback": "http://<gaffer-host>:<port>/jobs/<jobId>"
}
```

- `requires` lists the capabilities the builder must have. `repo:` includes being able to fetch `repo.base`.
- `base` is the commit the builder must build on.
- `jobId` is new for every attempt. It is the last path segment of `callback`.

Builder responses:

| Status | Meaning | Gaffer action |
|---|---|---|
| 202 `{"jobId":"…"}` | Accepted, build started | Wait for the callback |
| 400 | Malformed request | Exit non-zero |
| 422 `{"missing":[…]}` | Requirements not met | Exit non-zero (fail fast) |
| 503 + `Retry-After` | Busy with another job | Wait `Retry-After`, then POST again within the same turn |

## Result: `POST <callback>`

| Body | Meaning |
|---|---|
| `{"outcome":"done","patch":"<git format-patch mbox>"}` | Slice built. The patch is `git format-patch <base>..HEAD` |
| `{"outcome":"failed","reason":"…"}` | Slice not built |

Gaffer responses:

| Status | Meaning |
|---|---|
| 204 | Result accepted |
| 410 Gone | `jobId` is unknown or stale. The builder discards the result |

## Rules

- The gaffer accepts only the callback for the current `jobId` and answers 410 to any other.
- The builder retries the callback with backoff and stops on 204 or 410.
- The builder runs one job at a time and answers 503 with `Retry-After` while busy.
- The builder checks `requires` before accepting and lists everything it cannot meet in the 422 body, including being unable to fetch `repo.base`.
