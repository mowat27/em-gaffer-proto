#!/usr/bin/env bash
# The builder on an exe.dev VM. Run from the laptop.
#
#   vm.sh launch <vm> [--config <file>] [--ops] [--tsf] [--keep]
#                                    create the VM if it does not exist (pw-sandbox, base tsf-base-img; an ephemeral
#                                    tailnet node, so a deleted or long-stopped VM leaves the tailnet by itself, or a
#                                    persistent one with --keep, which stays listed until removed by hand), install the
#                                    builder's prerequisites (pi, Flyway, docker check, github.com's host keys), copy
#                                    this folder to ~/builder and run vm/install.sh there: npm ci, the machine config
#                                    ~/.gaffer/config.yml (--config <file> replaces it; otherwise one is written once,
#                                    with the server on the VM's tailnet name, port 8788), and the systemd unit
#                                    builder-server.service, started (a running job finishes first). --ops adds the
#                                    ops agent's unit, --tsf runs the builder's TSF as before (https://<vm>.exe.xyz).
#                                    Run it again to redeploy: the machine config and the runs on the VM are kept.
#   vm.sh key <vm> <owner/repo>      give the VM read access to a target repository (the builder fetches base commits
#                                    and never pushes): a deploy key of its own for that repository, made on the VM
#                                    (vm/repo-key.sh) and added to the repository read-only. GitHub accepts a deploy key
#                                    on one repository only, so run it once per target repository; each gets its own
#                                    key, and git on the VM picks it by the repository's URL. Needs gh signed in with
#                                    admin rights on the repository (gh auth refresh -h github.com -s repo).
#   vm.sh rejoin <vm> [--keep]       put the VM back on the tailnet (ephemeral, or persistent with --keep): tailscale
#                                    logout, then pw-sandbox's first-boot.sh again. For an ephemeral VM that was stopped
#                                    long enough to be dropped, or a VM named <vm>-1 because a stale machine held its
#                                    name (remove that one first). When the tailnet name changes, the machine config's
#                                    server.host follows and the build server restarts (a running job finishes first).
#
# Only this folder goes to the VM, and only the files git tracks or would track (no runs/, no node_modules, no tsf
# data or .env). The builder has no board token and no repository write access. The gaffer reaches it by MagicDNS name
# (<vm>.<tailnet>.ts.net:8788), which NO_PROXY in /etc/agent-vault.env keeps off the vault proxy. The tailnet ACL must
# let tag:sandbox reach tag:sandbox on tcp 8787 and 8788. On the VM: systemctl status builder-server, journalctl -u
# builder-server, and node ~/builder/cli/builder.ts (server, events, runs ...). Nothing printed is a secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOST_DIR="$(dirname "$HERE")"
FOLDER="$(basename "$HOST_DIR")"
BASE="${TSF_BASE:-tsf-base-img}"
SKILL="${TSF_SKILL_DIR:-$HOME/.claude/skills/tsf}"
SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { printf 'builder vm: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
on_vm() { local vm="$1"; shift; ssh -n "${SSH_OPTS[@]}" "$vm.exe.xyz" "$@"; }
vm_exists() { ssh -n exe.dev ls --json | jq -e --arg n "$1" '.vms[] | select(.vm_name == $n)' >/dev/null; }
check_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || die "invalid VM name: $1"; }
# The VM's tailnet name, or nothing when it is not on the tailnet.
ts_name() { { on_vm "$1" 'tailscale status --json 2>/dev/null' | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//'; } || true; }
# pw-sandbox's first boot (joins the tailnet, routes through Agent Vault): next to pw-sandbox, or $PW_FIRST_BOOT.
first_boot() {
  local f="${PW_FIRST_BOOT:-}"
  if [ -z "$f" ]; then
    local bin
    bin="$(command -v pw-sandbox)" || die "pw-sandbox is not on PATH (or set PW_FIRST_BOOT to its first-boot.sh)"
    bin="$(readlink -f "$bin" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$bin")"
    f="$(cd "$(dirname "$bin")/.." && pwd)/skills/agent-vault/scripts/first-boot.sh"
  fi
  [ -f "$f" ] || die "no first-boot.sh at $f (set PW_FIRST_BOOT)"
  printf '%s' "$f"
}

cmd_launch() {
  local vm="$1" config="" ops=0 tsf=0 keep=0 self args
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --config) config="${2:-}"; [ -f "$config" ] || die "--config: no file ${config:-given}"; shift 2 ;;
      --ops) ops=1; shift ;;
      --tsf) tsf=1; shift ;;
      --keep) keep=1; shift ;;
      *) usage ;;
    esac
  done
  check_name "$vm"
  command -v pw-sandbox >/dev/null || die "pw-sandbox is not on PATH"
  [ "$tsf" = 0 ] || [ -f "$SKILL/scripts/vm-tsf.sh" ] || die "no tsf skill at $SKILL (set TSF_SKILL_DIR)"

  if vm_exists "$vm"; then
    step "$vm exists: redeploying"
  else
    step "create $vm from $BASE (pw-sandbox)"
    if [ "$keep" = 1 ]; then pw-sandbox new "$vm" --keep --base "$BASE"; else pw-sandbox new "$vm" --base "$BASE"; fi
  fi

  step "prerequisites"
  ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" 'bash -s' < "$HERE/setup.sh"

  step "copy $FOLDER/ to $vm:~/$FOLDER"
  on_vm "$vm" "mkdir -p ~/$FOLDER"
  (cd "$HOST_DIR" && git ls-files -z --cached --others --exclude-standard | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf -) |
    ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "tar -xf - -C ~/$FOLDER"
  echo "copied the files git tracks or would track"

  step "install: npm ci, the machine config, the systemd units, the build server"
  self="$(ts_name "$vm")"
  [ -n "$self" ] && [ "$self" != null ] || die "$vm is not on the tailnet: vm.sh rejoin $vm"
  [ "${self%%.*}" = "$vm" ] || echo "note: $vm is on the tailnet as ${self%%.*} (a stale machine holds the name $vm: remove it in the Tailscale admin console, then vm.sh rejoin $vm)"
  args=(--host "$self")
  if [ -n "$config" ]; then
    ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "umask 077 && cat > ~/builder-config.upload.yml" < "$config"
    args+=(--config "/home/exedev/builder-config.upload.yml")
  fi
  [ "$ops" = 0 ] || args+=(--ops)
  on_vm "$vm" "bash ~/$FOLDER/vm/install.sh $(printf '%q ' "${args[@]}"); s=\$?; rm -f ~/builder-config.upload.yml; exit \$s"

  if [ "$tsf" = 1 ]; then
    step "run the TSF (the first start installs node modules and builds the web app)"
    ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "bash -s -- install /home/exedev/$FOLDER ." < "$SKILL/scripts/vm-tsf.sh"
  fi

  step "done"
  echo "$vm  ssh $vm.exe.xyz"
  [ "$tsf" = 0 ] || echo "tsf  https://$vm.exe.xyz"
  echo "the gaffer dispatches to http://$self:8788/slices (unless the VM's machine config sets another server.port)"
  echo "next: vm.sh key $vm <owner/repo> for each target repository (each gets its own deploy key)"
}

cmd_key() {
  local vm="$1" repo="${2%.git}" keys legacy pub adopt="" title
  check_name "$vm"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid repository: $repo (owner/repo)"
  fp() { awk '{print $1" "$2}'; }
  keys="$(gh api "repos/$repo/keys" --jq '.[].key')" ||
    die "gh cannot read the deploy keys of $repo: it needs admin rights on the repository (gh auth refresh -h github.com -s repo)"
  # A VM set up before keys were per repository has one key, ~/.ssh/builder_deploy: where that key is already on this
  # repository, it becomes this repository's key instead of a new one.
  legacy="$(on_vm "$vm" 'cat ~/.ssh/builder_deploy.pub 2>/dev/null' || true)"
  if [ -n "$legacy" ] && grep -qxF "$(printf '%s' "$legacy" | fp)" <<<"$keys"; then adopt="--adopt"; fi
  pub="$(ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "bash -s -- $(printf '%q' "$repo") $adopt" < "$HERE/repo-key.sh")" || die "could not make the deploy key for $repo on $vm"
  title="builder $vm"
  if grep -qxF "$(printf '%s' "$pub" | fp)" <<<"$keys"; then
    echo "$repo already has $vm's deploy key for it"
  else
    printf '%s\n' "$pub" | gh repo deploy-key add - --repo "$repo" --title "$title"
    echo "added deploy key \"$title\" to $repo, read-only"
  fi
  on_vm "$vm" "git ls-remote --heads git@github.com:$repo.git >/dev/null && echo \"$vm can reach $repo\""
}

cmd_rejoin() {
  local vm="$1" keep="${2:-}" old new fb ephemeral=true
  check_name "$vm"
  [ -z "$keep" ] || [ "$keep" = --keep ] || usage
  [ "$keep" = --keep ] && ephemeral=false
  fb="$(first_boot)"
  old="$(ts_name "$vm")"
  step "leave the tailnet${old:+ ($old)}"
  on_vm "$vm" 'sudo tailscale logout 2>/dev/null || true'
  step "join it again ($([ "$ephemeral" = true ] && echo ephemeral || echo persistent))"
  ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "EPHEMERAL=$ephemeral bash -s" < "$fb" || die "first-boot.sh failed on $vm"
  new="$(ts_name "$vm")"
  [ -n "$new" ] || die "$vm did not rejoin the tailnet (tailscale status on the VM)"
  echo "$vm is on the tailnet as $new"
  [ "${new%%.*}" = "$vm" ] || echo "note: still not $vm: a machine named $vm is on the tailnet; remove it in the Tailscale admin console and run this again"
  if [ -n "$old" ] && [ "$old" != "$new" ]; then
    step "the build server on $new"
    on_vm "$vm" "if grep -qF $(printf '%q' "$old") ~/.gaffer/config.yml; then sed -i.rejoin 's/$old/$new/g' ~/.gaffer/config.yml && rm -f ~/.gaffer/config.yml.rejoin && echo 'server.host: $new (was $old)' && node ~/builder/cli/builder.ts server restart; else echo 'the machine config does not name $old: server.host left as it is'; fi"
    echo "the gaffer reaches this builder at $new now: just gaffer vm launch <gaffer-vm> $vm sets its builderHost"
  fi
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  launch) cmd_rejoin() {
  local vm="$1" keep="${2:-}" old new fb ephemeral=true
  check_name "$vm"
  [ -z "$keep" ] || [ "$keep" = --keep ] || usage
  [ "$keep" = --keep ] && ephemeral=false
  fb="$(first_boot)"
  old="$(ts_name "$vm")"
  step "leave the tailnet${old:+ ($old)}"
  on_vm "$vm" 'sudo tailscale logout 2>/dev/null || true'
  step "join it again ($([ "$ephemeral" = true ] && echo ephemeral || echo persistent))"
  ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "EPHEMERAL=$ephemeral bash -s" < "$fb" || die "first-boot.sh failed on $vm"
  new="$(ts_name "$vm")"
  [ -n "$new" ] || die "$vm did not rejoin the tailnet (tailscale status on the VM)"
  echo "$vm is on the tailnet as $new"
  [ "${new%%.*}" = "$vm" ] || echo "note: still not $vm: a machine named $vm is on the tailnet; remove it in the Tailscale admin console and run this again"
  if [ -n "$old" ] && [ "$old" != "$new" ]; then
    step "the build server on $new"
    on_vm "$vm" "if grep -qF $(printf '%q' "$old") ~/.gaffer/config.yml; then sed -i.rejoin 's/$old/$new/g' ~/.gaffer/config.yml && rm -f ~/.gaffer/config.yml.rejoin && echo 'server.host: $new (was $old)' && node ~/builder/cli/builder.ts server restart; else echo 'the machine config does not name $old: server.host left as it is'; fi"
    echo "the gaffer reaches this builder at $new now: just gaffer vm launch <gaffer-vm> $vm sets its builderHost"
  fi
}

[ $# -ge 1 ] || usage; cmd_launch "$@" ;;
  key) [ $# -eq 2 ] || usage; cmd_key "$1" "$2" ;;
  rejoin) [ $# -ge 1 ] && [ $# -le 2 ] || usage; cmd_rejoin "$@" ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
