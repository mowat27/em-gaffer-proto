#!/usr/bin/env bash
# Install C4 Studio into the project in the current directory.
# Stamps c4-studio/ (mod.just, config.json, .env.example), appends ignore rules
# to .gitignore and registers `mod c4-studio` in the root justfile.
# Never overwrites existing files. Safe to re-run: it reports what it kept.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="$(pwd -P)"
TEMPLATE="$SKILL_DIR/template"
DIR="c4-studio"

case "$TARGET/" in
    "$SKILL_DIR"/*) echo "refusing to install inside the skill directory ($SKILL_DIR); run from the project root" >&2; exit 1 ;;
esac
for f in mod.just config.json .env.example; do
    [ -f "$TEMPLATE/$f" ] || { echo "missing template file: $TEMPLATE/$f" >&2; exit 1; }
done

echo "Installing C4 Studio into $TARGET"

# Append a line to a file when no identical line exists; create the file if absent.
append_line() { # file line
    if [ -f "$1" ] && grep -Fxq -- "$2" "$1"; then
        echo "kept     $1 ($2)"
        return
    fi
    if [ -s "$1" ] && [ -n "$(tail -c1 "$1")" ]; then echo >> "$1"; fi
    echo "$2" >> "$1"
    echo "appended $1 ($2)"
}

# Directories
for d in "$DIR" "$DIR/models"; do
    if [ -d "$d" ]; then echo "kept     $d/"; else mkdir -p "$d"; echo "created  $d/"; fi
done

# Stamped files (never overwritten)
for f in mod.just config.json .env.example; do
    if [ -e "$DIR/$f" ]; then
        echo "kept     $DIR/$f"
        continue
    fi
    cp "$TEMPLATE/$f" "$DIR/$f"
    if [ "$f" = "mod.just" ]; then
        content="$(cat "$DIR/mod.just")"
        printf '%s\n' "${content%%__SKILL_DIR__*}$SKILL_DIR${content#*__SKILL_DIR__}" > "$DIR/mod.just"
    fi
    echo "stamped  $DIR/$f"
done

# Ignore rules
# Models, branches, ADRs and history are project content and stay tracked.
# Only secrets and transient runtime files are ignored.
append_line .gitignore "$DIR/.env"
append_line .gitignore "$DIR/models/.jobs/"
append_line .gitignore "$DIR/models/*/branches/*/.job.lock"

# Root justfile registration
JUSTFILE=""
for j in justfile Justfile .justfile; do
    if [ -f "$j" ]; then JUSTFILE="$j"; break; fi
done
COMMENT="# C4 Studio: C4 models as Structurizr DSL (serve, create, reverse, update, ask, delete, branch, versions)"
if [ -z "$JUSTFILE" ]; then
    printf '%s\n' 'set shell := ["zsh", "-cu"]' '' '# List recipes' 'default:' '    @just --list' '' "$COMMENT" "mod $DIR" > justfile
    echo "stamped  justfile (new, with mod $DIR)"
elif grep -Eq "^[[:space:]]*mod[[:space:]]+\??$DIR([[:space:]]|\$)" "$JUSTFILE"; then
    echo "kept     $JUSTFILE (mod $DIR already registered)"
else
    if [ -s "$JUSTFILE" ] && [ -n "$(tail -c1 "$JUSTFILE")" ]; then echo >> "$JUSTFILE"; fi
    printf '\n%s\nmod %s\n' "$COMMENT" "$DIR" >> "$JUSTFILE"
    echo "appended $JUSTFILE (mod $DIR)"
fi

cat <<NEXT

Next steps
  1. cp $DIR/.env.example $DIR/.env and add your provider keys
  2. just $DIR serve
Node modules for the app install automatically on the first run.
NEXT
