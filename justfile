set shell := ["zsh", "-cu"]
set positional-arguments

# List recipes
default:
    @just --list

# Gaffer host: its own TSF (gaffer tsf start|stop|status|logs) and its exe.dev VM (gaffer vm launch|key|token)
mod gaffer

# Builder host: agents and workflows (builder run <agent>), the build server (builder server start|stop|restart), new agents (builder agent new), the ops agent on a VM (builder ops), its TSF and its exe.dev VM (builder vm launch|key|rejoin)
mod builder

# Check built slices on invoice-lite's origin/test/run-1 with the verify-slice skill: verify-slice [options] <slice.json>...
verify-slice *ARGS:
    av node .claude/skills/verify-slice/verify-slice.ts --repo ../invoice-lite --ref origin/test/run-1 "$@"

# C4 Studio: C4 models as Structurizr DSL (serve, create, reverse, update, ask, delete, branch, versions)
mod c4-studio
