set shell := ["zsh", "-cu"]
set positional-arguments

# List recipes
default:
    @just --list

# Gaffer host: its own TSF (gaffer tsf start|stop|status|logs) and its exe.dev VM (gaffer vm launch|key|token)
mod gaffer

# Builder host: its own TSF (builder tsf start|stop|status|logs) and its exe.dev VM (builder vm launch|key)
mod builder

# Start an interactive Pi coding agent with the builder's settings (builder/pi-agent): pi [pi args]
pi *ARGS:
    PI_CODING_AGENT_DIR="{{justfile_directory()}}/builder/pi-agent" pi "$@"

# Check built slices on invoice-lite's origin/test/run-1 with the verify-slice skill: verify-slice [options] <slice.json>...
verify-slice *ARGS:
    av node .claude/skills/verify-slice/verify-slice.ts --repo ../invoice-lite --ref origin/test/run-1 "$@"
