#!/usr/bin/env bash
# The builder's TSF on a persistent exe.dev VM. Run from the laptop.
#
#   vm.sh launch <vm>                create the VM if it does not exist (pw-sandbox, base tsf-base-img), install the
#                                    builder's prerequisites (pi, docker check, deploy key), copy this folder to
#                                    ~/builder, run its TSF as the systemd unit tsf-builder.service on port 8000
#                                    (https://<vm>.exe.xyz) and make the build server listen on the VM's tailnet name.
#                                    Run it again to redeploy: the TSF's data on the VM is kept.
#   vm.sh key <vm> <owner/repo>      add the VM's deploy key to the target repository, read-only (the builder fetches
#                                    base commits and never pushes). Needs gh signed in with admin rights on the
#                                    repository.
#
# Only this folder goes to the VM, and only the files git tracks or would track (no tsf/data, no jobs/, no pi
# sessions, no node_modules, no tsf/.env). The builder has no board token and no repository write access. The gaffer
# reaches it by MagicDNS name (<vm>.<tailnet>.ts.net:8788), which NO_PROXY in /etc/agent-vault.env keeps off the vault
# proxy. The tailnet ACL must let tag:sandbox reach tag:sandbox on tcp 8787 and 8788. Nothing printed is a secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOST_DIR="$(dirname "$HERE")"
FOLDER="$(basename "$HOST_DIR")"
BASE="${TSF_BASE:-tsf-base-img}"
SKILL="${TSF_SKILL_DIR:-$HOME/.claude/skills/tsf}"
SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
# The pi the builder runs, installed by setup.sh (the base image's own pi is an older version).
PI_COMMAND='~/.local/share/builder-pi/node_modules/.bin/pi'

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { printf 'builder vm: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
on_vm() { local vm="$1"; shift; ssh -n "${SSH_OPTS[@]}" "$vm.exe.xyz" "$@"; }
vm_exists() { ssh -n exe.dev ls --json | jq -e --arg n "$1" '.vms[] | select(.vm_name == $n)' >/dev/null; }
check_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || die "invalid VM name: $1"; }
ts_name() { on_vm "$1" 'tailscale status --json' | jq -r '.Self.DNSName' | sed 's/\.$//'; }
# Run a builder layer action on the VM: action <vm> <name>, with the action's input as JSON on stdin.
action() {
  local vm="$1" name="$2"
  jq -c '{input: .}' |
    ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "curl -fsS -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:8000/api/layers/builder/action/$name" >/dev/null
}

cmd_launch() {
  local vm="$1" self
  check_name "$vm"
  command -v pw-sandbox >/dev/null || die "pw-sandbox is not on PATH"
  [ -f "$SKILL/scripts/vm-tsf.sh" ] || die "no tsf skill at $SKILL (set TSF_SKILL_DIR)"

  if vm_exists "$vm"; then
    step "$vm exists: redeploying"
  else
    step "create $vm from $BASE (pw-sandbox)"
    pw-sandbox new "$vm" --keep --base "$BASE"
  fi

  step "prerequisites"
  ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" 'bash -s' < "$HERE/setup.sh"

  step "copy $FOLDER/ to $vm:~/$FOLDER"
  on_vm "$vm" "mkdir -p ~/$FOLDER"
  (cd "$HOST_DIR" && git ls-files -z --cached --others --exclude-standard | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf -) |
    ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "tar -xf - -C ~/$FOLDER"
  echo "copied the files git tracks or would track"

  step "run the TSF (the first start installs node modules and builds the web app)"
  ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "bash -s -- install /home/exedev/$FOLDER ." < "$SKILL/scripts/vm-tsf.sh"

  step "build server on the tailnet"
  self="$(ts_name "$vm")"
  [ -n "$self" ] && [ "$self" != null ] || die "$vm is not on the tailnet"
  jq -cn --arg v "$self" '{key: "host", value: $v}' | action "$vm" set_setting
  jq -cn --arg v "$PI_COMMAND" '{key: "pi_command", value: $v}' | action "$vm" set_setting
  echo "listen    http://$self:<port>/slices (start it on the Builder screen; host changes need a stop and start)"
  echo "pi        $PI_COMMAND"

  step "done"
  echo "$vm  https://$vm.exe.xyz  ssh $vm.exe.xyz"
  echo "next: vm.sh key $vm <owner/repo> once per target repository, then Start on the Builder screen"
}

cmd_key() {
  local vm="$1" repo="$2" pub title
  check_name "$vm"
  pub="$(on_vm "$vm" 'cat ~/.ssh/builder_deploy.pub')" || die "$vm has no deploy key yet; run vm.sh launch first"
  title="builder $vm"
  if gh api "repos/$repo/keys" --jq '.[].key' | grep -qF "$(printf '%s' "$pub" | awk '{print $1" "$2}')"; then
    echo "$repo already has the deploy key of $vm"
  else
    printf '%s\n' "$pub" | gh repo deploy-key add - --repo "$repo" --title "$title"
    echo "added deploy key \"$title\" to $repo, read-only"
  fi
  on_vm "$vm" "git ls-remote --heads git@github.com:$repo.git >/dev/null && echo \"$vm can reach $repo\""
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  launch) [ $# -eq 1 ] || usage; cmd_launch "$1" ;;
  key) [ $# -eq 2 ] || usage; cmd_key "$1" "$2" ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
