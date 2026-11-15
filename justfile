set shell := ["zsh", "-cu"]
set positional-arguments

# List recipes
default:
    @just --list

# TSF: Tiny Software Factory, an Empty Factory with a durable agent (start, stop, status, logs, push)
mod tsf

# Gaffer host: its own TSF (gaffer tsf start|stop|status|logs) and its exe.dev VM (gaffer vm launch|key|token)
mod gaffer

# Builder host: its own TSF (builder tsf start|stop|status|logs) and its exe.dev VM (builder vm launch|key)
mod builder

# Start an interactive Pi coding agent with the builder's settings (builder/pi-agent): pi [pi args]
pi *ARGS:
    PI_CODING_AGENT_DIR="{{justfile_directory()}}/builder/pi-agent" pi "$@"
