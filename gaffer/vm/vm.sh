#!/usr/bin/env bash
# The gaffer's TSF on a persistent exe.dev VM. Run from the laptop.
#
#   vm.sh launch <vm> <builder-vm>   create the VM if it does not exist (pw-sandbox, base tsf-base-img), install the
#                                    gaffer's prerequisites, copy this folder to ~/gaffer, run its TSF as the systemd
#                                    unit tsf-gaffer.service on port 8000 (https://<vm>.exe.xyz) and point the gaffer at
#                                    the builder VM. Run it again to redeploy: the TSF's data on the VM is kept.
#   vm.sh key <vm> <owner/repo>      add the VM's deploy key to the target repository with write access (the gaffer
#                                    pushes the target branch). Needs gh signed in with admin rights on the repository.
#   vm.sh token <vm>                 store the board token on the VM through the gaffer's set_token action: from
#                                    $EVENTMODELERS_TOKEN, else this folder's tsf/data/layers/gaffer/board-token, else
#                                    the old single TSF's tsf/data/layers/gaffer/board-token.
#
# Only this folder goes to the VM, and only the files git tracks or would track (no tsf/data, no node_modules, no
# tsf/.env). The gaffer and the builder talk over the tailnet by MagicDNS name (<vm>.<tailnet>.ts.net): NO_PROXY in
# /etc/agent-vault.env keeps *.ts.net off the vault proxy, which a 100.x address would go through. The tailnet ACL
# must let tag:sandbox reach tag:sandbox on tcp 8787 (callback) and 8788 (builder). Nothing printed here is a secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOST_DIR="$(dirname "$HERE")"
FOLDER="$(basename "$HOST_DIR")"
BASE="${TSF_BASE:-tsf-base-img}"
SKILL="${TSF_SKILL_DIR:-$HOME/.claude/skills/tsf}"
SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { printf 'gaffer vm: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
on_vm() { local vm="$1"; shift; ssh -n "${SSH_OPTS[@]}" "$vm.exe.xyz" "$@"; }
vm_exists() { ssh -n exe.dev ls --json | jq -e --arg n "$1" '.vms[] | select(.vm_name == $n)' >/dev/null; }
check_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || die "invalid VM name: $1"; }
# The VM's MagicDNS name, from its own tailscale.
ts_name() { on_vm "$1" 'tailscale status --json' | jq -r '.Self.DNSName' | sed 's/\.$//'; }
# Run a gaffer layer action on the VM: action <vm> <name>, with the action's input as JSON on stdin. The input never
# appears in a command line, here or on the VM.
action() {
  local vm="$1" name="$2"
  jq -c '{input: .}' |
    ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "curl -fsS -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:8000/api/layers/gaffer/action/$name" >/dev/null
}

cmd_launch() {
  local vm="$1" builder="$2" self builder_name
  check_name "$vm"; check_name "$builder"
  command -v pw-sandbox >/dev/null || die "pw-sandbox is not on PATH"
  [ -f "$SKILL/scripts/vm-tsf.sh" ] || die "no tsf skill at $SKILL (set TSF_SKILL_DIR)"
  vm_exists "$builder" || die "builder VM $builder does not exist; launch it first (just builder vm launch $builder)"

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

  step "point the gaffer at the builder over the tailnet"
  self="$(ts_name "$vm")"
  builder_name="$(ts_name "$builder")"
  [ -n "$self" ] && [ "$self" != null ] || die "$vm is not on the tailnet"
  [ -n "$builder_name" ] && [ "$builder_name" != null ] || die "$builder is not on the tailnet"
  jq -cn --arg v "$self" '{key: "callbackHost", value: $v}' | action "$vm" set_setting
  jq -cn --arg v "$builder_name" '{key: "builderHost", value: $v}' | action "$vm" set_setting
  echo "callback  http://$self:<callbackPort>/jobs/<jobId>"
  echo "builder   http://$builder_name:<builderPort>/slices"

  step "done"
  echo "$vm  https://$vm.exe.xyz  ssh $vm.exe.xyz"
  echo "next: vm.sh key $vm <owner/repo> once per target repository, vm.sh token $vm, then set the board and"
  echo "      repository on the Gaffer screen and run Set up"
}

cmd_key() {
  local vm="$1" repo="$2" pub title
  check_name "$vm"
  pub="$(on_vm "$vm" 'cat ~/.ssh/gaffer_deploy.pub')" || die "$vm has no deploy key yet; run vm.sh launch first"
  title="gaffer $vm"
  if gh api "repos/$repo/keys" --jq '.[].key' | grep -qF "$(printf '%s' "$pub" | awk '{print $1" "$2}')"; then
    echo "$repo already has the deploy key of $vm"
  else
    printf '%s\n' "$pub" | gh repo deploy-key add - --repo "$repo" --title "$title" --allow-write
    echo "added deploy key \"$title\" to $repo with write access"
  fi
  on_vm "$vm" "git ls-remote --heads git@github.com:$repo.git >/dev/null && echo \"$vm can reach $repo\""
}

cmd_token() {
  local vm="$1" file token
  check_name "$vm"
  token="${EVENTMODELERS_TOKEN:-}"
  if [ -z "$token" ]; then
    for file in "$HOST_DIR/tsf/data/layers/gaffer/board-token" "$HOST_DIR/../tsf/data/layers/gaffer/board-token"; do
      [ -f "$file" ] && { token="$(tr -d '[:space:]' < "$file")"; break; }
    done
  fi
  [ -n "$token" ] || die "no board token: set EVENTMODELERS_TOKEN or store one in a local gaffer TSF first"
  printf '%s' "$token" | jq -Rc '{token: .}' | action "$vm" set_token
  echo "board token stored on $vm (mode 600, never shown)"
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  launch) [ $# -eq 2 ] || usage; cmd_launch "$1" "$2" ;;
  key) [ $# -eq 2 ] || usage; cmd_key "$1" "$2" ;;
  token) [ $# -eq 1 ] || usage; cmd_token "$1" ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
