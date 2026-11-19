#!/usr/bin/env bash
# The builder's install on an exe.dev VM. Runs ON the VM, in the copy of builder/ that vm.sh launch made:
#   bash ~/builder/vm/install.sh [--host <name>] [--port <n>] [--config <file>] [--ops]
#
#   - npm ci in builder/ (the runtime's own dependencies)
#   - the machine config ~/.gaffer/config.yml: --config <file> replaces it (the previous one is kept as
#     config.yml.bak); without --config an existing one is kept, and a missing one is written: the server on
#     <host>:<port> (default 127.0.0.1:8788) with the pi setup.sh installed. It is checked before anything starts.
#   - the systemd units from vm/*.service, filled in: builder-server always, builder-ops with --ops (the ops agent,
#     agentics/agents/ops, in pi's TUI inside tmux: vm/ops-tmux.sh), enabled so they start at boot
#   - with --ops, ~/.gaffer/ops.env (mode 600) with a new OPS_API_TOKEN, only when the file does not exist yet
#   - ~/justfile (`mod builder`), only when it does not exist yet, so `just builder <recipe>` works from ~, and
#     `just builder ops` attaches to the ops agent
#   - the build server started, or restarted through `builder server restart`: a running job finishes first (E19),
#     waiting up to $BUILDER_DRAIN_SECONDS (default 600). A job still running then leaves the server as it is.
#
# Units go to $BUILDER_UNIT_DIR (default /etc/systemd/system), written with sudo. Safe to run again.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BUILDER="$(dirname "$HERE")"
UNIT_DIR="${BUILDER_UNIT_DIR:-/etc/systemd/system}"
CONFIG="$HOME/.gaffer/config.yml"
PI_COMMAND='~/.local/share/builder-pi/node_modules/.bin/pi'

say() { printf '%s\n' "$*"; }
die() { printf 'builder install: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,3p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

host=127.0.0.1 port=8788 config="" ops=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2:?--host needs a name}"; shift 2 ;;
    --port) port="${2:?--port needs a number}"; shift 2 ;;
    --config) config="${2:?--config needs a file}"; shift 2 ;;
    --ops) ops=1; shift ;;
    *) usage ;;
  esac
done
[[ "$port" =~ ^[0-9]+$ ]] || die "--port $port: a number"
[ -z "$config" ] || [ -f "$config" ] || die "no config file $config"
[ "$ops" = 0 ] || [ -f "$BUILDER/agentics/agents/ops/agent.yml" ] || die "--ops: there is no ops agent (agentics/agents/ops/agent.yml)"
[ "$ops" = 0 ] || command -v tmux >/dev/null || die "--ops: tmux is not installed (the ops agent runs in a tmux session)"
NODE="$(command -v node)" || die "node is not on PATH"
cli() { "$NODE" "$BUILDER/cli/builder.ts" "$@"; }

(cd "$BUILDER" && npm ci --no-audit --no-fund --loglevel=error)
say "deps     npm ci in $BUILDER"

mkdir -p "$(dirname "$CONFIG")"
if [ -n "$config" ]; then
  [ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.bak"
  install -m 0600 "$config" "$CONFIG"
  say "config   $CONFIG from $config"
elif [ -f "$CONFIG" ]; then
  say "config   $CONFIG kept (edit it, then: builder config reload; builder server restart for server keys)"
else
  cat > "$CONFIG" <<YAML
# The machine config of this VM (layer 3 in builder/ops/config.ts), written by vm/install.sh. It belongs to the
# operator: vm.sh launch keeps it unless given --config. After an edit run builder config reload, and
# builder server restart for the server keys. Secrets are env:NAME references, never values.
builder:
  server: { host: $host, port: $port }
  pi: { command: $PI_COMMAND }
  # A production VM can narrow what every agent may use, for example without the runs group:
  # limit: { tools: { enable: [observe, operate, process, definitions, files, project, outcome, verify, git, notify] } }
YAML
  say "config   $CONFIG written (server on $host:$port)"
fi
cli config >/dev/null || die "the machine config does not load (above): nothing was started"

# The ops agent's API token: generated once and kept (a redeploy never changes it).
if [ "$ops" = 1 ]; then
  OPS_ENV="$HOME/.gaffer/ops.env"
  if [ -f "$OPS_ENV" ]; then
    say "ops env  $OPS_ENV kept"
  else
    (umask 077 && printf 'OPS_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$OPS_ENV")
    chmod 600 "$OPS_ENV"
    say "ops env  $OPS_ENV written (a new OPS_API_TOKEN)"
  fi
fi

# ~/justfile, so `just builder <recipe>` (and `just builder ops`) work from ~. One that exists is the user's: kept.
if [ -f "$HOME/justfile" ]; then
  say "justfile $HOME/justfile kept"
else
  printf '# Written by builder/vm/install.sh: `just builder <recipe>` from ~ (`just builder ops` attaches to the ops agent).\nset shell := ["bash", "-cu"]\n\nmod builder\n' > "$HOME/justfile"
  say "justfile $HOME/justfile written (just builder ...)"
fi

# Each unit from its template, with this VM's user, node, PATH and builder/ filled in.
path="$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"
render() { sed -e "s|@USER@|$(id -un)|g" -e "s|@HOME@|$HOME|g" -e "s|@BUILDER@|$BUILDER|g" -e "s|@NODE@|$NODE|g" -e "s|@PATH@|$path|g" "$HERE/$1" | sudo tee "$UNIT_DIR/$1" >/dev/null; }
units=(builder-server.service)
[ "$ops" = 0 ] || units+=(builder-ops.service)
for u in "${units[@]}"; do render "$u"; done
sudo systemctl daemon-reload
sudo systemctl enable --quiet "${units[@]}"
say "units    ${units[*]} in $UNIT_DIR, enabled"

# A build server the builder TSF started before the server became a unit holds the port: stop it.
pkill -TERM -f "$BUILDER/server.ts" 2>/dev/null && say "stopped  the build server the TSF had started (server.ts)" || true

if cli server restart --timeout "${BUILDER_DRAIN_SECONDS:-600}"; then
  :
elif [ $? -eq 3 ]; then
  # The machine limit leaves out the process tools: systemd itself, without the drain.
  sudo systemctl restart builder-server.service
  say "server   restarted with systemctl (the machine limit has no process tools)"
else
  say "server   not restarted (above): run builder server restart once its job is done" >&2
fi
if [ "$ops" = 1 ]; then sudo systemctl restart builder-ops.service; say "ops      builder-ops.service restarted"; fi
