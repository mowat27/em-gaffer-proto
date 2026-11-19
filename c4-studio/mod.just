# C4 Studio: C4 models as Structurizr DSL (serve, create, reverse, update, ask, delete, branch, versions)

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := ".."

skill := env("C4_STUDIO_SKILL", "/Users/adrian/code/precision-weave/event-models/gaffer/.claude/skills/c4-studio")
cli := 'node "' + skill + '/app/bin/c4-studio.mjs"'

# List c4-studio commands
[default]
default:
    @just --list c4-studio

# Install the app's node modules on first use
install-deps:
    @cd "{{skill}}/app" && npm install --no-audit --no-fund

# Install node modules when missing (runs before every command)
_deps:
    @test -d "{{skill}}/app/node_modules" || (cd "{{skill}}/app" && npm install --no-audit --no-fund)

# Start the studio server: serve [--port n] [--open]
serve *ARGS: _deps
    @{{cli}} serve "$@"

# Create a model: create <name> [--description d] [--prompt "..."] [--branch main]
create *ARGS: _deps
    @{{cli}} create "$@"

# Reverse engineer the codebase into a model: reverse <name|slug> [--into] [--path dir] [--branch b]
reverse *ARGS: _deps
    @{{cli}} reverse "$@"

# Import an existing Structurizr DSL file as a new model: import <file.dsl> [--name n] [--description d]
import *ARGS: _deps
    @{{cli}} import "$@"

# Update a model with headless claude: update <slug> "<prompt>" [--branch b]
update *ARGS: _deps
    @{{cli}} update "$@"

# Ask a question about a model with headless claude: ask <slug> "<question>" [--branch b]
ask *ARGS: _deps
    @{{cli}} ask "$@"

# Delete a model or one branch: delete <slug> [--branch b] [--yes]
delete *ARGS: _deps
    @{{cli}} delete "$@"

# Fork a branch: branch <slug> <new> [--from branch[@version]]
branch *ARGS: _deps
    @{{cli}} branch "$@"

# List the versions of a branch: versions <slug> [--branch b]
versions *ARGS: _deps
    @{{cli}} versions "$@"

# Roll a branch back to a version: rollback <slug> <version> [--branch b]
rollback *ARGS: _deps
    @{{cli}} rollback "$@"

# Record the branch's current DSL as a version: snapshot <slug> -m "<message>" [--branch b]
snapshot *ARGS: _deps
    @{{cli}} snapshot "$@"

# Validate a branch's workspace with the Structurizr CLI: validate <slug> [--branch b]
validate *ARGS: _deps
    @{{cli}} validate "$@"

# List models, branches and heads
list: _deps
    @{{cli}} list

# Print the absolute workspace.dsl path: path <slug> [--branch b]
path *ARGS: _deps
    @{{cli}} path "$@"
