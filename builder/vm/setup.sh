#!/usr/bin/env bash
# The builder VM's prerequisites. Runs ON the VM, piped over ssh by vm.sh launch. Safe to run again.
#   - pi, pinned to the version the builder's agents (agentics/agents/) were proven with, in ~/.local/share/builder-pi
#   - Flyway (with its bundled JRE), pinned, in ~/.local/share/flyway-<version>, as /usr/local/bin/flyway: the target
#     repositories' projection tests shell out to it
#   - github.com's host keys in ~/.ssh/known_hosts. Deploy keys are per target repository, made by vm.sh key
#     (vm/repo-key.sh): GitHub accepts a deploy key on one repository only. A VM set up before that keeps its
#     ~/.ssh/builder_deploy, which vm.sh key adopts for the repository it is already registered on.
#   - checks that docker, git and node work (the base image, tsf-base-img, installs them)
set -euo pipefail

PI_VERSION=1.5.2
PI_DIR="$HOME/.local/share/builder-pi"
FLYWAY_VERSION=13.12.2
FLYWAY_SHA1=33613f4468cb486cb48a04a9f5a59944676bcdf5
FLYWAY_DIR="$HOME/.local/share/flyway-$FLYWAY_VERSION"

if [ "$("$PI_DIR/node_modules/.bin/pi" --version 2>/dev/null || true)" != "$PI_VERSION" ]; then
  mkdir -p "$PI_DIR"
  npm install --silent --no-fund --no-audit --prefix "$PI_DIR" "@earendil-works/pi-coding-agent@$PI_VERSION"
fi
echo "pi $("$PI_DIR/node_modules/.bin/pi" --version) at $PI_DIR/node_modules/.bin/pi"

# Flyway, with the JRE its tarball bundles: a target repository's projection tests run runFlywayMigrations()
# (src/common/testHelpers.ts), which runs `flyway` from PATH. Linked into /usr/local/bin, which is on the build
# server's PATH (vm/install.sh). ~/.local/bin/flyway is replaced too: tests written on a VM that had a stand-in there
# put ~/.local/bin first on PATH.
if [ "$("$FLYWAY_DIR/flyway" --version 2>/dev/null | grep -o "$FLYWAY_VERSION" | head -1)" != "$FLYWAY_VERSION" ]; then
  tgz="$(mktemp)"
  curl -fsSL -o "$tgz" "https://download.red-gate.com/maven/release/com/redgate/flyway/flyway-commandline/$FLYWAY_VERSION/flyway-commandline-$FLYWAY_VERSION-linux-x64.tar.gz"
  echo "$FLYWAY_SHA1  $tgz" | sha1sum -c --quiet - || { rm -f "$tgz"; echo "flyway $FLYWAY_VERSION: the download does not match its checksum" >&2; exit 1; }
  rm -rf "$FLYWAY_DIR" && mkdir -p "$FLYWAY_DIR"
  tar xzf "$tgz" -C "$FLYWAY_DIR" --strip-components=1
  rm -f "$tgz"
fi
sudo ln -sfn "$FLYWAY_DIR/flyway" /usr/local/bin/flyway
mkdir -p ~/.local/bin && ln -sfn "$FLYWAY_DIR/flyway" ~/.local/bin/flyway
echo "flyway $FLYWAY_VERSION at /usr/local/bin/flyway"

# The build server is its own unit now (builder-server.service, vm/install.sh): the drop-in that kept a TSF-started
# server alive across TSF restarts is no longer needed.
if [ -f /etc/systemd/system/tsf-builder.service.d/keep-children.conf ]; then
  sudo rm -f /etc/systemd/system/tsf-builder.service.d/keep-children.conf
  sudo systemctl daemon-reload
fi

mkdir -p ~/.ssh && chmod 700 ~/.ssh
grep -q "^github.com " ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null >> ~/.ssh/known_hosts
# The deploy keys vm.sh key has made so far (none on a new VM).
keys=""
for k in ~/.ssh/builder_deploy_*; do
  case "$k" in *.pub | *"*"*) continue ;; esac
  keys="$keys ${k##*/builder_deploy_}"
done
echo "deploy keys:${keys:- none yet (vm.sh key <vm> <owner/repo> for each target repository)}"

docker run --rm hello-world >/dev/null 2>&1 || { echo "docker cannot run containers as $(id -un)" >&2; exit 1; }
echo "docker $(docker version --format '{{.Server.Version}}') runs containers as $(id -un)"
echo "git $(git --version | cut -d' ' -f3), node $(node --version), npm $(npm --version)"
