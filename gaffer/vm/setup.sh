#!/usr/bin/env bash
# The gaffer VM's prerequisites. Runs ON the VM, piped over ssh by vm.sh launch. Safe to run again.
#   - the eventmodelers CLI (the shared runner), pinned to the version the gaffer was proven with
#   - a systemd drop-in so a TSF restart leaves the gaffer runner running
#   - an ssh deploy key for the target repository (~/.ssh/gaffer_deploy), used for github.com
# The base image (tsf-base-img) already has node, git and just.
set -euo pipefail

EM_VERSION=2.0.57

if [ "$(eventmodelers --version 2>/dev/null || true)" != "$EM_VERSION" ]; then
  sudo npm install -g --silent --no-fund --no-audit "@eventmodelers/cli@$EM_VERSION"
fi
echo "eventmodelers $(eventmodelers --version) at $(command -v eventmodelers)"

# The layer starts the gaffer runner detached so it outlives a TSF restart, as on the laptop. systemd's default
# KillMode (control-group) would stop it with tsf-gaffer.service, so only the TSF's own process is stopped.
sudo mkdir -p /etc/systemd/system/tsf-gaffer.service.d
printf '[Service]\nKillMode=process\n' | sudo tee /etc/systemd/system/tsf-gaffer.service.d/keep-children.conf >/dev/null
sudo systemctl daemon-reload
echo "tsf-gaffer.service stops only the TSF process (KillMode=process)"

mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/gaffer_deploy ] || ssh-keygen -q -t ed25519 -N "" -C "gaffer@$(hostname)" -f ~/.ssh/gaffer_deploy
if ! grep -q "gaffer_deploy" ~/.ssh/config 2>/dev/null; then
  printf '\nHost github.com\n  IdentityFile ~/.ssh/gaffer_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
  chmod 600 ~/.ssh/config
fi
grep -q "^github.com " ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null >> ~/.ssh/known_hosts
echo "deploy key ~/.ssh/gaffer_deploy ($(cut -d' ' -f1 ~/.ssh/gaffer_deploy.pub)) for github.com"
echo "node $(node --version), git $(git --version | cut -d' ' -f3)"
