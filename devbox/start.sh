#!/bin/bash
# Runs the two services of the dev box (devbox/README.md):
#   - Lianki `next dev` on local D1, :3000 (published to the host's loopback)
#   - DeepSeek Harness web UI (`dsh web`) on 127.0.0.1:3080, loopback INSIDE the
#     container until Cloudflare Access is in front of it. dsh is a shell.
# Logs: ~/.devbox/logs/{dev,dsh}.log
set -uo pipefail

REPO=/home/node/lianki
LOGS=/home/node/.devbox/logs
mkdir -p "$LOGS"

cd "$REPO"
export DB_BACKEND=d1
export LIANKI_DEVBOX=1
export DEV_EMAIL_PASSWORD_AUTH=1
export BETTER_AUTH_BASE_URL="${DEVBOX_PUBLIC_URL:-http://localhost:${DEVBOX_DEV_PORT:-3200}}"
AUTH_SECRET="$(cat /home/node/.devbox/auth-secret)"
export AUTH_SECRET

bunx next dev -H 0.0.0.0 -p 3000 >>"$LOGS/dev.log" 2>&1 &
dev=$!
echo "devbox: next dev (pid $dev) -> $LOGS/dev.log"

pids=("$dev")
if [ "${DEVBOX_DSH:-1}" = "1" ]; then
  # Loopback only. Opening it to the host waits for Cloudflare Access (README).
  dsh web --host 127.0.0.1 --port 3080 --no-open >>"$LOGS/dsh.log" 2>&1 &
  dsh_pid=$!
  pids+=("$dsh_pid")
  echo "devbox: dsh web (pid $dsh_pid) -> $LOGS/dsh.log"
fi

trap 'kill "${pids[@]}" 2>/dev/null; wait' TERM INT
# One service dying stops the box, so `docker compose ps` shows it and restart applies.
wait -n "${pids[@]}"
code=$?
echo "devbox: a service exited ($code); stopping"
kill "${pids[@]}" 2>/dev/null
wait
exit "$code"
