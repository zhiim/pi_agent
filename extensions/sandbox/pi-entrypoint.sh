#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/.pi/agent"

if [ -d /seed/agent ] && [ ! -f "$HOME/.pi/agent/.seeded" ]; then
  echo "[pi-sandbox] seeding ~/.pi/agent from /seed/agent"
  cp -a /seed/agent/. "$HOME/.pi/agent/"
  touch "$HOME/.pi/agent/.seeded"

  echo "[pi-sandbox] installing/updating Pi packages from settings.json"
  pi update --extensions || true
fi

cd /workspace
exec pi "$@"
