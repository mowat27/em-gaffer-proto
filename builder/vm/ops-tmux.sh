#!/usr/bin/env bash
# The ops agent in pi's TUI, inside a detached tmux session, for builder-ops.service. Runs ON the VM.
#
#   ops-tmux.sh run    start `builder run ops --mode interactive --dir <builder> --journal` in a new tmux session
#                      (its own socket: tmux -L ops, session ops), wait until that command exits, and exit with its
#                      code. The unit's ExecStart.
#   ops-tmux.sh stop   stop the live interactive ops run through the builder (run_stop: it records how it ended), then
#                      end the tmux session. The unit's ExecStop.
#
# Attach with `just builder ops` (tmux -L ops attach -t ops) after `ssh -t <vm>.exe.xyz`; Ctrl-b d detaches and the
# agent keeps running. tmux does not pass a command's exit code on, so the command writes it to a file this script
# reads once the session has ended. The tmux server is started fresh by `run`, so the session has the unit's
# environment (the vault's proxy variables and OPS_API_TOKEN).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BUILDER="$(dirname "$HERE")"
NODE="${NODE:-$(command -v node)}"
SOCKET=ops
SESSION=ops
STATUS_DIR="${RUNTIME_DIRECTORY:-${TMPDIR:-/tmp}}"
STATUS="$STATUS_DIR/builder-ops.exit"

say() { printf 'builder ops: %s\n' "$*"; }
# The server's own config (extended keys for pi's editor): it applies when `run` starts the server.
tm() { tmux -L "$SOCKET" -f "$HERE/ops.tmux.conf" "$@"; }

# The ids of the ops agent's live interactive runs.
live_ops_runs() {
  "$NODE" "$BUILDER/cli/builder.ts" runs --target agent:ops --state live --limit 50 --json 2>/dev/null |
    "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const r of JSON.parse(s).runs??[])if(r.mode==="interactive")console.log(r.id)}catch{}})'
}

cmd_run() {
  command -v tmux >/dev/null || { say "tmux is not installed"; exit 1; }
  # A session left by a previous start (the unit was killed) would hold the name: start clean.
  tm kill-server 2>/dev/null || true
  rm -f "$STATUS"
  local inner
  inner="cd $(printf %q "$BUILDER") && $(printf %q "$NODE") cli/builder.ts run ops --mode interactive --dir $(printf %q "$BUILDER") --journal; echo \$? > $(printf %q "$STATUS")"
  tm new-session -d -s "$SESSION" -x 200 -y 50 "bash -c $(printf %q "$inner")"
  say "started in tmux (tmux -L $SOCKET attach -t $SESSION, or: just builder ops)"
  # On SIGTERM (systemd's stop, after ExecStop) end the session and finish with what the command reported.
  trap 'tm kill-server 2>/dev/null || true' TERM INT
  while tm has-session -t "$SESSION" 2>/dev/null; do
    sleep 2 &
    wait $! || true
  done
  local code=1
  [ -s "$STATUS" ] && code="$(cat "$STATUS")"
  rm -f "$STATUS"
  say "the ops run ended (exit $code)"
  exit "$code"
}

cmd_stop() {
  local id
  for id in $(live_ops_runs); do
    "$NODE" "$BUILDER/cli/builder.ts" tool run_stop "{\"run\":\"$id\",\"reason\":\"builder-ops.service stopped\"}" >/dev/null 2>&1 || true
    say "stopped run $id"
  done
  # The run ending ends the session; give it a moment, then end it regardless.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    tm has-session -t "$SESSION" 2>/dev/null || break
    sleep 1
  done
  tm kill-server 2>/dev/null || true
}

case "${1:-}" in
  run) cmd_run ;;
  stop) cmd_stop ;;
  *) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
