# TSF: Tiny Software Factory, an Empty Factory with a durable agent (start, stop, restart, status, logs, push)

set shell := ["bash", "-cu"]
set positional-arguments
set working-directory := ".."

export TSF_PROJECT := parent_directory(source_directory())
skill := env("TSF_SKILL_DIR", "/Users/adrian/.claude/skills/tsf")
# The project's own copy of the app (tsf/app, made by install.sh) when it exists, else the shared app in the skill.
own := source_directory() / "app" / "bin" / "tsf.mjs"
launcher := if path_exists(own) == "true" { own } else { skill + "/app/bin/tsf.mjs" }
cli := 'node "' + launcher + '"'

# List tsf commands
[default]
default:
    @just --list tsf

# Start the factory server: start [--tools a,b] [--port n] [--host h] [--dev]
start *ARGS:
    @{{cli}} start "$@"

# Stop the running factory: stop [--force]
stop *ARGS:
    @{{cli}} stop "$@"

# Restart the factory (through its API when it runs, else start it): restart [--tools a,b] [--port n] [--host h]
restart *ARGS:
    @{{cli}} restart "$@"

# Show whether the factory is running, with its URL: status [--json]
[no-exit-message]
status *ARGS:
    @{{cli}} status "$@"

# Show the factory log: logs [-f] [-n N]
logs *ARGS:
    @{{cli}} logs "$@"

# Launch this project in a persistent exe.dev VM running its TSF: push [vm] [--force]
push *ARGS:
    @bash "{{skill}}/scripts/push.sh" "$@"
