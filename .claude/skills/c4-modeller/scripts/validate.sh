#!/usr/bin/env bash
# Validate a Structurizr DSL workspace: parse it, run the C4 inspections, and
# optionally export the parsed workspace (with every view resolved) as JSON.
#
# Usage: validate.sh <workspace.dsl> [--json <out.json>]
#
# Exit codes:
#   0  parses and passes inspections (errors and warnings)
#   1  does not parse
#   2  parses but inspections report errors or warnings
#   3  no Structurizr tooling available (neither a structurizr CLI nor Docker)
set -uo pipefail

usage() { echo "usage: validate.sh <workspace.dsl> [--json <out.json>]" >&2; exit 64; }

[ $# -ge 1 ] || usage
WORKSPACE="$1"; shift
JSON_OUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --json) [ $# -ge 2 ] || usage; JSON_OUT="$2"; shift 2 ;;
        *) usage ;;
    esac
done

[ -f "$WORKSPACE" ] || { echo "workspace not found: $WORKSPACE" >&2; exit 64; }

DIR="$(cd "$(dirname "$WORKSPACE")" && pwd)"
FILE="$(basename "$WORKSPACE")"
IMAGE="${STRUCTURIZR_IMAGE:-structurizr/structurizr}"

# Prefer a native CLI; fall back to the official Docker image. The workspace
# directory is mounted so relative !include and `workspace extends` paths resolve.
if command -v structurizr >/dev/null 2>&1; then
    run() { (cd "$DIR" && structurizr "$@"); }
elif command -v structurizr.sh >/dev/null 2>&1; then
    run() { (cd "$DIR" && structurizr.sh "$@"); }
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    run() { docker run --rm -v "$DIR":/w -w /w "$IMAGE" "$@"; }
else
    echo "NO_TOOLING: install the Structurizr CLI or start Docker to validate" >&2
    exit 3
fi

strip() { sed -E 's/^.*(Command|Parser)[^-]* -- //'; }

echo "== validate"
VALIDATE_OUT="$(run validate -w "$FILE" 2>&1)"
if [ $? -ne 0 ]; then
    echo "$VALIDATE_OUT" | strip
    echo "RESULT: parse failed"
    exit 1
fi
echo "parse ok"

echo "== inspect (errors and warnings)"
INSPECT_OUT="$(run inspect -w "$FILE" -s error,warning 2>&1)"
INSPECT_RC=$?
[ -n "$INSPECT_OUT" ] && echo "$INSPECT_OUT" | strip

if [ -n "$JSON_OUT" ]; then
    echo "== export json"
    TMP_REL=".c4-export-$$"
    run export -w "$FILE" -f json -o "$TMP_REL" >/dev/null 2>&1
    EXPORTED="$(ls "$DIR/$TMP_REL"/*.json 2>/dev/null | head -n 1)"
    if [ -n "$EXPORTED" ]; then
        mkdir -p "$(dirname "$JSON_OUT")"
        mv "$EXPORTED" "$JSON_OUT"
        echo "wrote $JSON_OUT"
    else
        echo "json export failed" >&2
    fi
    rm -rf "${DIR:?}/$TMP_REL"
fi

if [ $INSPECT_RC -ne 0 ]; then
    echo "RESULT: inspections failed"
    exit 2
fi
echo "RESULT: ok"
exit 0
