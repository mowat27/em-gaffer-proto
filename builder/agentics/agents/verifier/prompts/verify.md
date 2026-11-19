---
description: Verify a build and report the verdict
argument-hint: "<workspace> [slice] [base]"
---
Verify the build in the workspace `${1:-the last build verified in this session}`.

Call the `verify` tool once with:

- `workspace`: `$1`. When it is empty, the workspace of the last build verified in this session (the `verifier`
  section of your instructions names it), with its slice and base unless they are given below
- `slice`: `$2` (leave it out when it is empty: the workspace's `.slice.json`)
- `base`: `$3` (leave it out when it is empty: HEAD, a build that is not committed)

Then report the verdict exactly as the tool returned it: `PASS` or `FAIL` with the summary, then one line per failed
finding (`- FAIL <id>: <detail>`) and per unsure finding (`- UNSURE <id>: <detail>`). Change nothing.
