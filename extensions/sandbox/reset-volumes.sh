#!/usr/bin/env bash
set -euo pipefail
AGENT_VOLUME="${PI_AGENT_VOLUME:-pi-agent-home}"
CTX_VOLUME="${PI_CONTEXT_VOLUME:-pi-context-mode}"
# after remove the volumes, the next run will create new ones, and totally refresh the config
docker volume rm "$AGENT_VOLUME" "$CTX_VOLUME"
