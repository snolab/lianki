#!/bin/bash
# Host side of a dev box's public URL (devbox/README.md, "Tunnel"). Runs on the
# Mac with the Mac's own cloudflared login (~/.cloudflared/cert.pem, made by
# `cloudflared tunnel login`); nothing here goes into the container.
#
#   devbox/host-tunnel.sh create   # named tunnel + its config; no DNS, no connector
#   devbox/host-tunnel.sh dns      # the CNAME — only after the owner's typed OK in Slack
#   devbox/host-tunnel.sh run      # the connector, foreground (run it under oxmgr)
#   devbox/host-tunnel.sh status
#
# Reads DEVBOX_NAME and DEVBOX_DEV_PORT from devbox/.env. The ingress reaches
# ONLY the box's dev server on the host loopback; everything else is 404.
# dsh web is not routed: that waits for Cloudflare Access (README).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/.env" ]; then
  # Only the two names we need, never the whole file (it holds the DeepSeek key).
  eval "$(grep -E '^(DEVBOX_NAME|DEVBOX_DEV_PORT)=[A-Za-z0-9._-]*$' "$here/.env")"
fi
: "${DEVBOX_NAME:?set DEVBOX_NAME in devbox/.env}"
PORT="${DEVBOX_DEV_PORT:-3200}"
TUNNEL="lianki-devbox-${DEVBOX_NAME}"
HOST="${DEVBOX_HOST:-devbox-${DEVBOX_NAME}.lianki.com}"
CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/${TUNNEL}.yml"

tunnel_id() { cloudflared tunnel list --name "$TUNNEL" --output json 2>/dev/null | python3 -c 'import json,sys;t=json.load(sys.stdin);print(t[0]["id"] if t else "")'; }

case "${1:-}" in
  create)
    [ -f "$CFDIR/cert.pem" ] || { echo "no $CFDIR/cert.pem: run \`cloudflared tunnel login\` on the Mac first" >&2; exit 1; }
    id="$(tunnel_id)"
    if [ -z "$id" ]; then
      cloudflared tunnel create "$TUNNEL" >/dev/null
      id="$(tunnel_id)"
    fi
    creds="$CFDIR/${id}.json"
    [ -f "$creds" ] && [ ! -L "$creds" ] || { echo "credentials file for $TUNNEL missing: $creds" >&2; exit 1; }
    chmod 600 "$creds"
    umask 077
    cat >"$CONFIG.tmp" <<EOF
tunnel: ${id}
credentials-file: ${creds}
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF
    mv "$CONFIG.tmp" "$CONFIG"
    echo "tunnel $TUNNEL ($id) -> $HOST -> http://127.0.0.1:$PORT; config $CONFIG"
    echo "no DNS record yet: \`$0 dns\` after the owner's typed OK"
    ;;
  dns)
    # Creating a DNS record needs the owner's typed confirmation in Slack.
    [ "${OWNER_APPROVED_DNS:-}" = "1" ] || { echo "refusing: set OWNER_APPROVED_DNS=1 only after the owner's typed OK in Slack" >&2; exit 1; }
    cloudflared tunnel route dns "$TUNNEL" "$HOST"
    ;;
  run)
    [ -f "$CONFIG" ] || { echo "no $CONFIG: run \`$0 create\` first" >&2; exit 1; }
    exec cloudflared tunnel --no-autoupdate --config "$CONFIG" run "$TUNNEL"
    ;;
  status)
    echo "tunnel: $TUNNEL id=$(tunnel_id) host=$HOST origin=http://127.0.0.1:$PORT"
    curl -s -o /dev/null -w "origin: %{http_code}\n" "http://127.0.0.1:$PORT/" || echo "origin: down"
    cloudflared tunnel info "$TUNNEL" 2>/dev/null | tail -n +2 || true
    ;;
  *)
    sed -n '2,13p' "$0"; exit 2 ;;
esac
