#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_VOLUME="pi-agent-home"
CTX_VOLUME="pi-context-mode"
IMAGE="pi-agent-sandbox"

# if a directory argument is provided, use it as the project directory,
# otherwise use the current working directory
if [ "${1:-}" != "" ] && [ -d "${1:-}" ]; then
  PROJECT_DIR="$(cd "$1" && pwd)"
  shift
else
  PROJECT_DIR="$(pwd)"
fi

# all arguments after -- will be passed to the docker run command
if [ "${1:-}" = "--" ]; then
  shift
fi

docker volume create "$AGENT_VOLUME" >/dev/null
docker volume create "$CTX_VOLUME" >/dev/null

docker run --rm -it \
  -e "PROVIDER_BASE_URL=$PROVIDER_BASE_URL" \
  -e "PROVIDER_API_KEY=$PROVIDER_API_KEY" \
  -e "TERM=xterm-256color" \
  -e "COLORTERM=$COLORTERM" \
  -v "$BASE_DIR/seed:/seed:ro" \
  -v "$AGENT_VOLUME:/home/piuser/.pi/agent" \
  -v "$CTX_VOLUME:/home/piuser/.pi/context-mode" \
  -v "$PROJECT_DIR:/workspace" \
  -w /workspace \
  "$IMAGE" "$@"
