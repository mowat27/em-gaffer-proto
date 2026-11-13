set shell := ["zsh", "-cu"]

# List recipes
default:
    @just --list

# TSF: Tiny Software Factory, an Empty Factory with a durable agent (start, stop, status, logs, push)
mod tsf
