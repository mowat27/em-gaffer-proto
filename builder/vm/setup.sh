#!/usr/bin/env bash
# The builder VM's prerequisites. Runs ON the VM, piped over ssh by vm.sh launch. Safe to run again.
#   - pi, pinned to the version the builder's agent (pi-agent/) was proven with, in ~/.local/share/builder-pi
#   - a systemd drop-in so a TSF restart leaves the build server running
#   - an ssh deploy key for the target repository (~/.ssh/builder_deploy), used for github.com
#   - checks that docker, git and node work (the base image, tsf-base-img, installs them)
set -euo pipefail

PI_VERSION=1.5.2
PI_DIR="$HOME/.local/share/builder-pi"

if [ "$("$PI_DIR/node_modules/.bin/pi" --version 2>/dev/null || true)" != "$PI_VERSION" ]; then
  mkdir -p "$PI_DIR"
  npm install --silent --no-fund --no-audit --prefix "$PI_DIR" "@earendil-works/pi-coding-agent@$PI_VERSION"
fi
echo "pi $("$PI_DIR/node_modules/.bin/pi" --version) at $PI_DIR/node_modules/.bin/pi"

# The layer starts the build server detached so it outlives a TSF restart, as on the laptop. systemd's default
# KillMode (control-group) would stop it with tsf-builder.service, so only the TSF's own process is stopped.
sudo mkdir -p /etc/systemd/system/tsf-builder.service.d
printf '[Service]\nKillMode=process\n' | sudo tee /etc/systemd/system/tsf-builder.service.d/keep-children.conf >/dev/null
sudo systemctl daemon-reload
echo "tsf-builder.service stops only the TSF process (KillMode=process)"

mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/builder_deploy ] || ssh-keygen -q -t ed25519 -N "" -C "builder@$(hostname)" -f ~/.ssh/builder_deploy
if ! grep -q "builder_deploy" ~/.ssh/config 2>/dev/null; then
  printf '\nHost github.com\n  IdentityFile ~/.ssh/builder_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
  chmod 600 ~/.ssh/config
fi
grep -q "^github.com " ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null >> ~/.ssh/known_hosts
echo "deploy key ~/.ssh/builder_deploy ($(cut -d' ' -f1 ~/.ssh/builder_deploy.pub)) for github.com"

docker run --rm hello-world >/dev/null 2>&1 || { echo "docker cannot run containers as $(id -un)" >&2; exit 1; }
echo "docker $(docker version --format '{{.Server.Version}}') runs containers as $(id -un)"
echo "git $(git --version | cut -d' ' -f3), node $(node --version), npm $(npm --version)"
