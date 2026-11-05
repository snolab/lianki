#!/bin/bash
# docker compose for a dev box, ALWAYS on OrbStack (devbox/README.md). Docker
# Desktop on this Mac runs another project; this never talks to its socket.
#   devbox/box.sh up -d --build        # devbox/.env
#   DEVBOX_ENV=.env.bob devbox/box.sh ps
#   devbox/box.sh exec box bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export DOCKER_CONTEXT=orbstack
env_file="$here/${DEVBOX_ENV:-.env}"
[ -f "$env_file" ] || { echo "no $env_file: cp devbox/.env.example $env_file" >&2; exit 1; }
exec docker --context orbstack compose -f "$here/compose.yaml" --env-file "$env_file" "$@"
