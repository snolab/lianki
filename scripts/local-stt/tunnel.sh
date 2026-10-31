#!/usr/bin/env bash
# The second route to the local STT server: wss://stt.lianki.com through a
# named cloudflared tunnel, "lianki-stt" (docs/local-stt.md "Off the
# tailnet"). Separate from the dev.lianki.com tunnel; Tailscale stays the
# first route and the cloud the last.
#
#   scripts/local-stt/tunnel.sh up       # create/route the tunnel, open the ticket listener, run it under oxmgr
#   scripts/local-stt/tunnel.sh down     # rollback: stop it, close the listener, delete the tunnel, DNS and rule
#   scripts/local-stt/tunnel.sh status
#
# DRY_RUN=1 prints every command that would change something instead of running it.
#
# Needs once: `cloudflared tunnel login` (browser; ~/.cloudflared/cert.pem) and
# the ticket key (`bun scripts/local-stt/ticket-key.ts | bunx wrangler secret
# put STT_TICKET_KEY`, which writes the public key to ~/.config/lianki-stt/ticket.pub).
# The rate-limit rule and removing the DNS record need CLOUDFLARE_API_TOKEN
# (scripts/ops/stt-edge.ts).
set -euo pipefail

NAME=lianki-stt                 # the cloudflared tunnel
HOST=stt.lianki.com
PORT=5188                       # server.py --public-port: tickets required, 127.0.0.1 only
SERVER=lianki-stt               # the oxmgr entry of the STT server
PROC=lianki-stt-tunnel          # the oxmgr entry of cloudflared
DIR="${CLOUDFLARED_DIR:-$HOME/.cloudflared}"
CONF="$DIR/$NAME.yml"
PUB="${STT_TICKET_PUB:-$HOME/.config/lianki-stt/ticket.pub}"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
OXMGR="${OXMGR:-oxmgr}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

run() {
  if [ -n "${DRY_RUN:-}" ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}
say() { echo "[tunnel] $*" >&2; }

has_proc() { "$OXMGR" status "$1" >/dev/null 2>&1; }
field() { "$OXMGR" status "$1" 2>/dev/null | sed -n "s/^$2: *//p"; }

tunnel_id() {
  [ -f "$DIR/cert.pem" ] || return 0
  "$CFD" tunnel list --name "$NAME" --output json 2>/dev/null |
    python3 -I -c 'import json,sys; d=json.load(sys.stdin) or []; print(d[0]["id"] if d else "")' 2>/dev/null || true
}

# The STT server's command with or without --public-port; restarts it only on a change.
server_public() {
  local on="$1" cmd cwd new
  if ! has_proc "$SERVER"; then
    say "no oxmgr entry $SERVER: start the STT server first (docs/local-stt.md)"
    [ "$on" = off ] && return 0 || return 1
  fi
  cmd="$(field "$SERVER" Command)"
  cwd="$(field "$SERVER" 'Working Dir')"
  new="$(printf '%s' "$cmd" | sed -E 's/ --public-port [0-9]+//')"
  if [ "$on" = on ]; then
    if ! grep -q -- '--public-port' "$cwd/scripts/local-stt/server.py"; then
      say "$cwd has no --public-port in server.py yet: pull main there first"
      return 1
    fi
    new="$new --public-port $PORT"
  fi
  if [ "$new" = "$cmd" ]; then
    say "STT server: ticket listener already $on"
    return 0
  fi
  run "$OXMGR" delete "$SERVER"
  run "$OXMGR" start --name "$SERVER" --restart always --cwd "$cwd" "$new"
}

up() {
  [ -x "$CFD" ] || { say "cloudflared not found (docs/local-stt.md: install it to ~/.local/bin)"; exit 3; }
  [ -f "$DIR/cert.pem" ] || { say "not logged in: run \`cloudflared tunnel login\` (browser) once"; exit 3; }
  [ -f "$PUB" ] || { say "no ticket key at $PUB: run ticket-key.ts | wrangler secret put STT_TICKET_KEY first"; exit 3; }
  run chmod 600 "$DIR/cert.pem"

  local id
  id="$(tunnel_id)"
  if [ -z "$id" ]; then
    run "$CFD" tunnel create "$NAME"
    id="$(tunnel_id)"
    [ -n "$id" ] || { [ -n "${DRY_RUN:-}" ] && id="<tunnel-uuid>" || { say "tunnel create failed"; exit 1; }; }
  fi
  local creds="$DIR/$id.json"
  [ -f "$creds" ] || [ -n "${DRY_RUN:-}" ] || {
    say "no credentials file for $NAME on this Mac ($creds); see docs/local-stt.md"; exit 1; }
  run chmod 600 "$creds"

  # Only the ticket listener is reachable through the tunnel; everything else is 404 at cloudflared.
  if [ -n "${DRY_RUN:-}" ]; then
    echo "+ write $CONF (0600): $HOST -> http://127.0.0.1:$PORT, else http_status:404"
  else
    umask 077
    cat >"$CONF" <<EOF
tunnel: $id
credentials-file: $creds
no-autoupdate: true
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
    chmod 600 "$CONF"
  fi

  run "$CFD" tunnel route dns "$NAME" "$HOST"
  server_public on
  if has_proc "$PROC"; then
    run "$OXMGR" restart "$PROC"
  else
    run "$OXMGR" start --name "$PROC" --restart always "$CFD tunnel --config $CONF run $NAME"
  fi
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    run bun "$REPO/scripts/ops/stt-edge.ts"
  else
    say "rate limit NOT applied: CLOUDFLARE_API_TOKEN is not set (bun scripts/ops/stt-edge.ts)"
  fi
  say "up. Check: scripts/local-stt/tunnel.sh status (expect 401 from https://$HOST/ without a ticket)"
}

down() {
  local left=0
  if has_proc "$PROC"; then run "$OXMGR" delete "$PROC"; else say "no $PROC running"; fi
  server_public off
  local id
  id="$(tunnel_id)"
  if [ -n "$id" ]; then
    run "$CFD" tunnel cleanup "$NAME" || true
    run "$CFD" tunnel delete -f "$NAME"
    run rm -f "$DIR/$id.json"
  elif [ -f "$DIR/cert.pem" ]; then
    say "no tunnel named $NAME"
  else
    say "not logged in to cloudflared: cannot check for the tunnel (nothing was created from here)"
  fi
  run rm -f "$CONF"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    run bun "$REPO/scripts/ops/stt-edge.ts" --remove
  else
    say "DNS record $HOST and the rate-limit rule NOT removed: set CLOUDFLARE_API_TOKEN and run"
    say "  bun scripts/ops/stt-edge.ts --remove   (with the tunnel gone the record reaches nothing: 1033)"
    left=1
  fi
  say "down"
  return "$left"
}

status() {
  echo "STT server:   $(field "$SERVER" Status || true) — $(field "$SERVER" Command | grep -o -- '--public-port [0-9]*' || echo 'no ticket listener')"
  echo "tunnel proc:  $(has_proc "$PROC" && field "$PROC" Status || echo 'not running')"
  echo "tunnel:       $( [ -f "$DIR/cert.pem" ] && { id="$(tunnel_id)"; echo "${id:-none}"; } || echo 'not logged in')"
  echo "ticket key:   $( [ -f "$PUB" ] && echo "$PUB" || echo 'none')"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Origin: https://lianki.com' "https://$HOST/" || true)"
  echo "https://$HOST/ → ${code:-no answer} (401 = up and gated; 502 = no ticket listener; 530 = no connector; 000 = no DNS)"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
