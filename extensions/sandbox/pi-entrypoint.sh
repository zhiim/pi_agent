#!/usr/bin/env bash
set -euo pipefail

PI_RUNTIME_DIR="${PI_RUNTIME_DIR:-$HOME/.pi/runtime}"

export NPM_CONFIG_PREFIX="$PI_RUNTIME_DIR"
export PATH="$PI_RUNTIME_DIR/bin:$PATH"

mkdir -p "$HOME/.pi/agent" "$HOME/.pi/context-mode" "$PI_RUNTIME_DIR"

if [ ! -x "$PI_RUNTIME_DIR/bin/pi" ]; then
  echo "[pi-sandbox] installing Pi into persistent runtime volume"

  npm --prefix "$PI_RUNTIME_DIR" install -g \
   --ignore-scripts \
   --min-release-age=0 \
   "@earendil-works/pi-coding-agent@${PI_VERSION:-latest}"
fi

if [ -d /seed/agent ] && [ ! -f "$HOME/.pi/agent/.seeded" ]; then
  echo "[pi-sandbox] seeding ~/.pi/agent from /seed/agent"
  cp -a /seed/agent/. "$HOME/.pi/agent/"
  touch "$HOME/.pi/agent/.seeded"

  echo "[pi-sandbox] installing/updating Pi packages from settings.json"
  pi update --extensions
fi

cd /workspace
exec pi "$@"
