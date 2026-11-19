# slice-lab data

Files slice-lab works with, found through the `data:` prefix. `data:<path>` is looked up here first, then in
`agentics/agents/dev/data/`, `agentics/agents/data/` and `agentics/shared/data/`; at each level `local/` comes before
the committed files.

- The sample dispatches are shared: `data:dispatches/createclient-new.json` and the others in
  `agentics/shared/data/dispatches/`. A dispatch placed here under `dispatches/` overrides the shared one of that name
  for slice-lab only.
- Results slice-lab collects (verdicts, run comparisons, notes on skill changes) go in `data/local/`, which is not
  committed (`agentics/**/data/local/` in builder/.gitignore).
