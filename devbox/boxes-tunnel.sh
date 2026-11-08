#!/bin/bash
# One tunnel for every box (devbox/README.md, "One tunnel for every box"). Runs on
# the Mac with its cloudflared login (~/.cloudflared/cert.pem); nothing goes
# into a container.
#
#   devbox/boxes-tunnel.sh create   # tunnel lianki-boxes, once; no DNS, no connector
#   devbox/boxes-tunnel.sh sync     # ingress from every devbox/.env*, then restart the connector
#   devbox/boxes-tunnel.sh dns      # the ONE wildcard CNAME *.lianki.com — owner's typed OK only
#   devbox/boxes-tunnel.sh run      # the connector, foreground (oxmgr runs it)
#   devbox/boxes-tunnel.sh status
#
# A new box: its env file with DEVBOX_PUBLIC_URL and DEVBOX_DEV_PORT, then `sync`.
# No DNS edit. Each my-<hash|name> host in an env file -> its port; every other
# name the wildcard brings here is 404. Names with their own DNS record (www,
# dev, preview, an older box's CNAME, ...) never come here: an exact record wins.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# The env files live in the main checkout's devbox/ (gitignored); a worktree can point here.
ENV_DIR="${DEVBOX_ENV_DIR:-$here}"
TUNNEL="lianki-boxes"
WILDCARD="*.lianki.com"
CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/${TUNNEL}.yml"
PROC="${TUNNEL}-tunnel"

tunnel_id() { cloudflared tunnel list --name "$TUNNEL" --output json 2>/dev/null | python3 -c 'import json,sys;t=json.load(sys.stdin);print(t[0]["id"] if t else "")'; }
need_ok() { [ "${OWNER_APPROVED_DNS:-}" = "1" ] || { echo "refusing: set OWNER_APPROVED_DNS=1 only after the owner's typed OK in Slack" >&2; exit 1; }; }

case "${1:-}" in
  create)
    [ -f "$CFDIR/cert.pem" ] || { echo "no $CFDIR/cert.pem: run \`cloudflared tunnel login\` on the Mac first" >&2; exit 1; }
    [ -n "$(tunnel_id)" ] || cloudflared tunnel create "$TUNNEL" >/dev/null
    echo "tunnel $TUNNEL $(tunnel_id); next: $0 sync"
    ;;
  sync)
    id="$(tunnel_id)"
    [ -n "$id" ] || { echo "no tunnel $TUNNEL: run \`$0 create\` first" >&2; exit 1; }
    creds="$CFDIR/${id}.json"
    [ -f "$creds" ] && [ ! -L "$creds" ] || { echo "credentials file for $TUNNEL missing: $creds" >&2; exit 1; }
    chmod 600 "$creds"
    umask 077
    bun "$here/../scripts/dev/boxes-ingress.ts" "$ENV_DIR" "$id" "$creds" >"$CONFIG.tmp"
    cloudflared tunnel --config "$CONFIG.tmp" ingress validate >/dev/null
    mv "$CONFIG.tmp" "$CONFIG"
    echo "config $CONFIG"
    if oxmgr list 2>/dev/null | grep -q " $PROC "; then
      oxmgr restart "$PROC" >/dev/null && echo "restarted $PROC"
    else
      oxmgr start --name "$PROC" --restart always --cwd "$HOME" \
        "$(command -v cloudflared) tunnel --no-autoupdate --config $CONFIG run $TUNNEL" >/dev/null && echo "started $PROC"
    fi
    ;;
  dns)
    need_ok
    [ -n "$(tunnel_id)" ] || { echo "no tunnel $TUNNEL: run \`$0 create\` first" >&2; exit 1; }
    # Never --overwrite-dns: if *.lianki.com exists already, this fails and changes nothing.
    cloudflared tunnel route dns "$TUNNEL" "$WILDCARD"
    ;;
  run)
    [ -f "$CONFIG" ] || { echo "no $CONFIG: run \`$0 sync\` first" >&2; exit 1; }
    exec cloudflared tunnel --no-autoupdate --config "$CONFIG" run "$TUNNEL"
    ;;
  status)
    echo "tunnel: $TUNNEL id=$(tunnel_id) config=$CONFIG"
    grep -c 'hostname:' "$CONFIG" 2>/dev/null | sed 's/^/routed boxes: /' || echo "routed boxes: none (no config)"
    cloudflared tunnel info "$TUNNEL" 2>/dev/null | tail -n +2 || true
    ;;
  *)
    sed -n '2,15p' "$0"; exit 2 ;;
esac
