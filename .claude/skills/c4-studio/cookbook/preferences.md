# Shared Rules

Rules every recipe in this skill follows. `<skill-dir>` is the directory holding `SKILL.md`; resolve it to an absolute path. The project root is the directory containing `c4-studio/` (the git toplevel when in doubt).

## Startup check

`c4-studio/` must exist in the project root. When it does not, say so in one line and offer `install`; stop unless the mode is `install`.

## CLI

Run from the project root:

```
node "<skill-dir>/app/bin/c4-studio.mjs" <command> ...
```

Commands: `list`, `create`, `reverse`, `import`, `update`, `ask`, `delete`, `branch`, `versions`, `rollback`, `snapshot`, `validate`, `serve`, `path`. `app/DESIGN.md` → CLI lists the arguments. Exit codes: 0 ok, 1 failure, 2 usage. The `just c4-studio <command>` mod recipes call the same CLI and install node modules first. The launcher installs the app's node modules itself on first run (Node >= 22.18 is required).

## Slugs, branches and paths

- Slugs and branch names match `[a-z0-9][a-z0-9-]*`. The default branch is `main`.
- Find a model's slug with `list` when the user gives a name. If several match or none do, report the candidates and stop.
- Resolve a branch's workspace file with `path <slug> [--branch b]`; it prints the absolute `workspace.dsl` path. Never build the path by hand.
- A model lives at `c4-studio/models/<slug>/`. ADRs are `branches/<branch>/adrs/NNNN-<slug>.md`.

## Writing ADRs

- An ADR records a decision: its context, what was decided and why, and the consequences that follow. It is not a work log or a to-do list.
- Do not record implementation status, progress, stubs, workarounds in place, outstanding work or next steps. For example, never write "Note: this is currently a stub (the cipher only base64-encodes), so real Vault encryption is still outstanding." State the decision and its consequences in terms that stay true while the decision stands.
- Do not refer to anything that changes independently of the decision, because the reference goes stale: files, paths, code (functions, classes, modules) or documents in the repository; ticket, issue or pull request numbers and links; commit hashes; branch names; release or app version numbers; people or teams as owners of follow-up work; exact dependency versions, configuration values, ports or environment variable names. Describe the idea itself.
- A value the decision itself chooses, for example "PostgreSQL 16" or "requests time out after 30 seconds", is part of the decision and belongs in it.
- Refer to elements of the model by name, not by identifier or view key. Refer to other ADRs by id, for example "supersedes 0003".
- You may cite published external standards, regulations and specifications with their version or clause, for example "RFC 9110", "PCI DSS 4.0" or "GDPR Article 17", and name who made the decision.

## Studio URL

Port: `C4_STUDIO_PORT` from the environment or `c4-studio/.env`, else `port` in `c4-studio/config.json`, else 47145. Model URL: `http://127.0.0.1:<port>/?model=<slug>&branch=<branch>`.

## Modelling with c4-modeller

Locate the c4-modeller skill: `<project>/.claude/skills/c4-modeller`, else `~/.claude/skills/c4-modeller`, else `<skill-dir>/../c4-modeller`. Read its `SKILL.md` and follow the requested mode yourself. Pass the exact workspace path from `path` as the output path so the workspace lands in the model's branch, not in `docs/` or `tmp/c4/`. JSON export is not needed. Do not spawn `claude`. After editing, always run `snapshot`.

## Recording a change

`snapshot <slug> -m "<one-line summary>" [--branch b]` records a version with source `cli`. When the studio server is running it has usually already recorded the edit as an automatic "Edited in file" version; `snapshot` then relabels that version with your message instead of adding one. It prints `no changes` and exits 0 only when nothing changed at all. Run it after every direct edit of a workspace or ADR file.

## Reports

Lead with the result. Name slug, branch, version id when known, workspace path and studio URL. Mention warnings from the CLI verbatim. No recap of steps.
