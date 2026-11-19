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
  "sourceEvents": [
    {
      "owner": { "sliceId": "…", "title": "CreateClient", "status": "Done", "sliceType": "STATE_CHANGE", "chapterId": "…" },
      "event": { "…": "the event element, verbatim from the owner's events[]" }
    }
  ],
  "changes": {
    "verdict": "CHANGED",
    "since": { "commit": "<sha>", "recordedAt": "…" },
    "slice": { "changed": ["title"] },
    "elements": {
      "changed": [{ "kind": "events", "id": "…", "title": "InvoiceCreated", "before": { "…": "the element as last built" } }],
      "added": [{ "kind": "specifications", "id": "…", "title": "…" }],
      "removed": [{ "kind": "commands", "id": "…", "title": "…", "before": { "…": "…" } }]
    },
    "sourceEvents": {
      "changed": [{ "id": "…", "title": "ClientCreated", "owner": "CreateClient", "before": { "…": "…" } }],
      "added": [],
      "removed": []
    }
  },
  "callback": "http://<gaffer-host>:<port>/jobs/<jobId>"
}
```

[reference/dispatch.schema.json](reference/dispatch.schema.json) is the JSON Schema for this body. It uses [reference/slice.schema.json](reference/slice.schema.json) for `slice` and the source event elements.

- `requires` lists the capabilities the builder must have. `repo:` includes being able to fetch `repo.base`.
- `base` is the commit the builder must build on.
- `jobId` is new for every attempt. It is the last path segment of `callback`.
- `sourceEvents` is sent only for a read model (`STATE_VIEW`) slice. It has one entry per event the slice's read models project, which they name as `INBOUND` `EVENT` dependencies. `event` is that event's element exactly as it appears in the `events[]` of the slice that owns it, which can be in any chapter or context on the board. `owner` names that slice and its status at dispatch time. The list is empty when the read models project no events.

## Source events

A read model slice's own `events` is always empty, so `sourceEvents` gives the builder the definitive definition of each event it projects. The slice that owns an event carries the same element in its own `slice.events`. Both slices are therefore built from one definition, whichever is built first.

- Each definition comes from the board, never from the read model.
- The gaffer dispatches a read model slice whatever the status of its source events' owners. It never holds it back until they are Done.
- When a source event is owned by no slice on the board, the gaffer does not dispatch. The turn fails with a note on the slice that names the event.
- `STATE_CHANGE` dispatches have no `sourceEvents`. A builder that ignores the field works as before.

## Changes

`changes` is in every dispatch. It says what changed in the slice since it was last built on the branch `repo.base` is on. The gaffer computes it by comparing `slice` and `sourceEvents` with the baseline committed at `repo.base` (design.md, section 7).

- `verdict` is `NEW` (no baseline: build the whole slice) or `CHANGED` (rework only what is listed). An unchanged slice is never dispatched.
- `since` is the commit that recorded the baseline, and when. It is `null` for `NEW`. `git diff <since.commit>..<repo.base>` shows the code changes made since that build.
- `slice.changed` names the slice's own fields that changed, such as `title`, `actors` or `aggregates`.
- `elements` lists every element of the slice (any list of objects with an id: commands, events, read models, screens, specifications, tables, ...) that changed, was added or was removed. `kind` is the slice key that holds it.
- `sourceEvents` lists the source events that changed, were added or were removed. `owner` is the title of the slice that owns the event.
- `before` is the element as last built, on changed and removed entries. The current definition of a changed or added element is in `slice` or `sourceEvents`.
- For `NEW` every list is empty.
- Elements are compared by content. The slice's `status`, `comments` and `index`, each element's `comments`, and a source event owner's `status` are not part of the comparison.

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
