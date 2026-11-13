# Gaffer kit: build turn

This kit does not build slices itself. The runner's `--exec` command, `.build-kit/gaffer.ts`, reads the task request
below, dispatches the slice to the build server, applies and merges the patch it returns, and records the outcome with
`eventmodelers slice-status`. There are no skills and no instructions for a model here: everything before the task
request is ignored by gaffer.ts.
