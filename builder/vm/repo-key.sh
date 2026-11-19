#!/usr/bin/env bash
# The deploy key of one target repository on a builder VM. Runs ON the VM, piped over ssh by vm.sh key; prints the
# key's public half on stdout (everything else goes to stderr). Safe to run again.
#
#   repo-key.sh <owner/repo> [--adopt]
#
# GitHub accepts a deploy key on one repository only, so the VM keeps one key per target repository:
#   - the key ~/.ssh/builder_deploy_<owner>_<repo>, made once (--adopt: a copy of the key setup.sh used to make,
#     ~/.ssh/builder_deploy, which vm.sh found already registered on this repository)
#   - an ssh host alias, github.com-builder-<owner>_<repo>, that reaches github.com with that key only
#   - git url rewrites (insteadOf, in ~/.gitconfig) from the repository's GitHub URLs (git@github.com:<owner>/<repo>,
#     ssh://git@github.com/<owner>/<repo>, https://github.com/<owner>/<repo>) to the alias, so a dispatch's repo URL
#     clones with the right key and nothing in the builder chooses keys
# git uses the longest matching rewrite, so a repository whose name starts with another's (app, app-admin) gets its
# own key once it has run here too.
set -euo pipefail

repo="${1:-}"
adopt="${2:-}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repo-key: <owner/repo>, not '$repo'" >&2; exit 2; }
repo="${repo%.git}"
slug="${repo//\//_}"
key="$HOME/.ssh/builder_deploy_$slug"
alias="github.com-builder-$slug"

mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$key" ]; then
  if [ "$adopt" = --adopt ] && [ -f "$HOME/.ssh/builder_deploy" ]; then
    install -m 600 "$HOME/.ssh/builder_deploy" "$key"
    install -m 644 "$HOME/.ssh/builder_deploy.pub" "$key.pub"
    echo "repo-key: ~/.ssh/builder_deploy_$slug from ~/.ssh/builder_deploy (already registered on $repo)" >&2
  else
    ssh-keygen -q -t ed25519 -N "" -C "builder@$(hostname) $repo" -f "$key"
    echo "repo-key: made ~/.ssh/builder_deploy_$slug" >&2
  fi
fi

if ! grep -qx "Host $alias" "$HOME/.ssh/config" 2>/dev/null; then
  printf '\n# %s (builder/vm/repo-key.sh)\nHost %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$repo" "$alias" "$key" >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
fi
grep -q "^github.com " "$HOME/.ssh/known_hosts" 2>/dev/null || ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null >> "$HOME/.ssh/known_hosts"

base="git@$alias:$repo"
have="$(git config --global --get-all "url.$base.insteadOf" 2>/dev/null || true)"
for from in "git@github.com:$repo" "ssh://git@github.com/$repo" "https://github.com/$repo"; do
  grep -qxF "$from" <<<"$have" || git config --global --add "url.$base.insteadOf" "$from"
done

cat "$key.pub"
