#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_VOLUME="pi-agent-home"
CTX_VOLUME="pi-context-mode"
IMAGE="pi-agent-sandbox"

docker volume create "$AGENT_VOLUME" >/dev/null
docker volume create "$CTX_VOLUME" >/dev/null

docker run --rm -i \
  -v "$AGENT_VOLUME:/home/piuser/.pi/agent" \
  -v "$CTX_VOLUME:/home/piuser/.pi/context-mode" \
  --entrypoint /bin/bash \
  "$IMAGE" \
  -c 'rm -f ~/.pi/agent/.seeded'
