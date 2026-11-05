#!/bin/bash
# Host side of a dev box's public URLs (devbox/README.md, "Tunnel"). Runs on the
# Mac with the Mac's own cloudflared login (~/.cloudflared/cert.pem, made by
# `cloudflared tunnel login`); nothing here goes into the container.
#
#   devbox/host-tunnel.sh create     # named tunnel + its config; no DNS, no connector
#   devbox/host-tunnel.sh dns        # CNAME my-<hash> — only after the owner's typed OK
#   devbox/host-tunnel.sh dns-dsh    # CNAME dsh-<name> — only after the Access app exists
#   devbox/host-tunnel.sh run        # the connector, foreground (run it under oxmgr)
#   devbox/host-tunnel.sh status
#
# Box: devbox/.env, or DEVBOX_ENV=.env.<name>. Ingress: my-<hash> -> the
# box's dev server on the host loopback. dsh-<name> is added ONLY when the env
# file names its Access application (DEVBOX_DSH_ACCESS_AUD + CF_ACCESS_TEAM):
# then the connector itself rejects any request without a valid Access token
# for that application, on top of the Access login at the edge. Rest: 404.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
env_file="$here/${DEVBOX_ENV:-.env}"
if [ -f "$env_file" ]; then
  # Only the names we need, never the whole file (it holds the DeepSeek key).
  eval "$(grep -E '^(DEVBOX_NAME|DEVBOX_DEV_PORT|DEVBOX_DSH_PORT|DEVBOX_DSH_ACCESS_AUD|CF_ACCESS_TEAM)=[A-Za-z0-9._-]*$' "$env_file")"
fi
: "${DEVBOX_NAME:?set DEVBOX_NAME in $env_file}"
PORT="${DEVBOX_DEV_PORT:-3200}"
DSH_PORT="${DEVBOX_DSH_PORT:-}"
AUD="${DEVBOX_DSH_ACCESS_AUD:-}"
TEAM="${CF_ACCESS_TEAM:-}"
TUNNEL="lianki-devbox-${DEVBOX_NAME}"
# The public host is my-<hash>.lianki.com, unguessable, so it lives only in the
# gitignored env file (DEVBOX_PUBLIC_URL) and the tunnel config in ~/.cloudflared.
HOST="$(sed -nE 's#^DEVBOX_PUBLIC_URL=https://(my-[0-9a-f]{12,}\.lianki\.com)/?$#\1#p' "$env_file" 2>/dev/null | tail -n 1)"
if [ -z "$HOST" ]; then
  echo "no DEVBOX_PUBLIC_URL=https://my-<hash>.lianki.com in $env_file (openssl rand -hex 8)" >&2
  exit 1
fi
DSH_HOST="dsh-${DEVBOX_NAME}.lianki.com"
CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/${TUNNEL}.yml"

tunnel_id() { cloudflared tunnel list --name "$TUNNEL" --output json 2>/dev/null | python3 -c 'import json,sys;t=json.load(sys.stdin);print(t[0]["id"] if t else "")'; }
need_ok() { [ "${OWNER_APPROVED_DNS:-}" = "1" ] || { echo "refusing: set OWNER_APPROVED_DNS=1 only after the owner's typed OK in Slack" >&2; exit 1; }; }
dsh_ready() { [ -n "$DSH_PORT" ] && [ -n "$AUD" ] && [ -n "$TEAM" ]; }

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
    {
      echo "tunnel: ${id}"
      echo "credentials-file: ${creds}"
      echo "ingress:"
      echo "  - hostname: ${HOST}"
      echo "    service: http://127.0.0.1:${PORT}"
      if dsh_ready; then
        echo "  - hostname: ${DSH_HOST}"
        echo "    service: http://127.0.0.1:${DSH_PORT}"
        echo "    originRequest:"
        echo "      access:"
        echo "        required: true"
        echo "        teamName: ${TEAM}"
        echo "        audTag: [${AUD}]"
      fi
      echo "  - service: http_status:404"
    } >"$CONFIG.tmp"
    mv "$CONFIG.tmp" "$CONFIG"
    echo "tunnel $TUNNEL ($id) -> $HOST -> http://127.0.0.1:$PORT; config $CONFIG"
    if dsh_ready; then echo "  + $DSH_HOST -> http://127.0.0.1:$DSH_PORT (Access token required)"; else echo "  dsh not routed (no Access app in $env_file)"; fi
    ;;
  dns)
    need_ok
    cloudflared tunnel route dns "$TUNNEL" "$HOST"
    ;;
  dns-dsh)
    need_ok
    dsh_ready || { echo "refusing: no Access app for $DSH_HOST in $env_file (DEVBOX_DSH_ACCESS_AUD, CF_ACCESS_TEAM, DEVBOX_DSH_PORT)" >&2; exit 1; }
    grep -q "audTag: \[${AUD}\]" "$CONFIG" || { echo "refusing: $CONFIG has no Access-gated dsh rule; run \`$0 create\` and restart the connector" >&2; exit 1; }
    cloudflared tunnel route dns "$TUNNEL" "$DSH_HOST"
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
    sed -n '2,17p' "$0"; exit 2 ;;
esac
