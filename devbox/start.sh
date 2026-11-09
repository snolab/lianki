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
if [ -n "${DEVBOX_LIANKI_CLIENT_ID:-}" ]; then
  # Signs in through lianki.com (docs/box-oauth.md): no sign-in or sign-up of its own.
  export LIANKI_BOX_CLIENT_ID="$DEVBOX_LIANKI_CLIENT_ID"
  export LIANKI_BOX_SCOPE="${DEVBOX_LIANKI_SCOPE:-box:read box:write offline_access}"
else
  export DEV_EMAIL_PASSWORD_AUTH=1
fi
export BETTER_AUTH_BASE_URL="${DEVBOX_PUBLIC_URL:-http://localhost:${DEVBOX_DEV_PORT:-3200}}"
AUTH_SECRET="$(cat /home/node/.devbox/auth-secret)"
export AUTH_SECRET

bunx next dev -H 0.0.0.0 -p 3000 >>"$LOGS/dev.log" 2>&1 &
dev=$!
echo "devbox: next dev (pid $dev) -> $LOGS/dev.log"

pids=("$dev")
if [ "${DEVBOX_DSH:-1}" = "1" ]; then
  if [ -n "${DEVBOX_DSH_PUBLIC_HOST:-}" ]; then
    # Only set once its Cloudflare Access app exists (README): bind the
    # container's address (published on the host loopback only) and trust
    # the Access-protected host.
    dsh_host="$(hostname -i | awk '{print $1}')"
    dsh_args=(--host "$dsh_host" --public-url "https://${DEVBOX_DSH_PUBLIC_HOST}/" --trusted-host "$DEVBOX_DSH_PUBLIC_HOST")
  else
    dsh_args=(--host 127.0.0.1) # container loopback: unreachable from outside
  fi
  dsh web "${dsh_args[@]}" --port 3080 --no-open >>"$LOGS/dsh.log" 2>&1 &
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
