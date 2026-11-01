#!/usr/bin/env bash
# The whole-page dev server's public tunnel: https://preview.lianki.com
# (docs/dev-whole-page.md, "Off the tailnet"), reaching only the guard's gate
# on 127.0.0.1:3104. Tailscale :8443 is untouched.
#
#   scripts/dev/preview-tunnel.sh up       # tunnel + ingress + DNS (+ rate rule), connector under oxmgr
#   scripts/dev/preview-tunnel.sh down     # rollback: connector, tunnel (connections first), DNS, local secrets
#   scripts/dev/preview-tunnel.sh status
#
# Two ways to make the tunnel, picked by what is on this Mac:
#   API (preferred): a Cloudflare API token in CLOUDFLARE_API_TOKEN or
#     ~/.config/lianki/cf-api-token (0600; permissions in scripts/ops/cf-tunnel.ts).
#     A remotely managed tunnel, the DNS record and the shared rate-limit rule,
#     all through the API; cloudflared runs with a run-token FILE.
#   cert.pem (fallback, no API token yet): `cloudflared tunnel login` left
#     ~/.cloudflared/cert.pem. A locally managed tunnel: created and DNS-routed
#     by cloudflared, its ingress in ~/.cloudflared/lianki-preview.yml, its
#     credentials JSON 0600. The rate-limit rule needs the API token (the
#     gate's own limits apply meanwhile), and so does deleting the DNS record
#     on `down` (without it the record is left, reaching nothing: 1033).
#
# Needs in both: the dev server running with `--public-host preview.lianki.com`
# (its gate must already answer 503 with its own marker).
set -euo pipefail

HOST=preview.lianki.com
NAME=lianki-preview
GATE="${PREVIEW_GATE_URL:-http://127.0.0.1:3104}"
ORIGIN_URL=http://127.0.0.1:3104
PROC=lianki-preview-tunnel
TOKEN_FILE="${PREVIEW_TUNNEL_TOKEN_FILE:-$HOME/.config/lianki/preview-tunnel-token}"
API_TOKEN_FILE="${CF_API_TOKEN_FILE:-$HOME/.config/lianki/cf-api-token}"
DIR="${CLOUDFLARED_DIR:-$HOME/.cloudflared}"
CERT="$DIR/cert.pem"
CONF="$DIR/$NAME.yml"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
OXMGR="${OXMGR:-oxmgr}"
CURL="${CURL:-curl}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

say() { echo "[preview-tunnel] $*" >&2; }
api() {
  if [ -n "${PREVIEW_TUNNEL_API:-}" ]; then "$PREVIEW_TUNNEL_API" "$@"; else bun "$REPO/scripts/ops/cf-tunnel.ts" "$@"; fi
}
has_proc() { "$OXMGR" status "$1" >/dev/null 2>&1; }
have_api() { [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || [ -e "$API_TOKEN_FILE" ]; }
have_cert() { [ -e "$CERT" ]; }
# Owner-only, 0600, not a symlink (scripts/ops/cf-tunnel.ts secretFileProblem): no API token needed.
secret_ok() { CF_API_TOKEN_FILE="$API_TOKEN_FILE" api check-secret "$1"; }

# Both: a page without a token is 503, and /_lk/up carries the gate's own
# marker (x-lianki-gate: 1), so a 503 from anything else (a crashed proxy, a
# different server on the port) is not taken for the gate.
gate_closed() {
  local code head
  code="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $HOST" "$GATE/" || true)"
  [ "$code" = 503 ] || return 1
  head="$("$CURL" -s -o /dev/null -D - --max-time 5 -H "Host: $HOST" "$GATE/_lk/up" || true)"
  printf '%s' "$head" | grep -q '^HTTP/[0-9.]* 503' || return 1
  printf '%s' "$head" | grep -qi '^x-lianki-gate: 1'
}

# The cert.pem tunnel's id, if it exists (cloudflared lists by name).
tunnel_id() {
  "$CFD" tunnel list --name "$NAME" --output json 2>/dev/null |
    python3 -I -c 'import json,sys; d=json.load(sys.stdin) or []; print(d[0]["id"] if d else "")' 2>/dev/null || true
}

start_connector() {
  if has_proc "$PROC"; then "$OXMGR" delete "$PROC" >/dev/null; fi
  "$OXMGR" start --name "$PROC" --restart always "$1" >/dev/null
}

up_api() {
  api up --token-out "$TOKEN_FILE"
  secret_ok "$TOKEN_FILE" || { say "refusing to run with that token file"; exit 1; }
  # --token-file: the token is never on a command line (ps) or in oxmgr's config.
  start_connector "$CFD tunnel --no-autoupdate run --token-file $TOKEN_FILE"
}

up_cert() {
  chmod 600 "$CERT"
  secret_ok "$CERT" || { say "refusing to use $CERT"; exit 1; }
  local id creds
  id="$(tunnel_id)"
  if [ -z "$id" ]; then
    "$CFD" tunnel create "$NAME" >/dev/null
    id="$(tunnel_id)"
    [ -n "$id" ] || { say "cloudflared tunnel create $NAME failed"; exit 1; }
  fi
  creds="$DIR/$id.json"
  [ -e "$creds" ] || { say "no credentials file for $NAME on this Mac ($creds)"; exit 1; }
  chmod 600 "$creds"
  secret_ok "$creds" || { say "refusing to use $creds"; exit 1; }
  # Only the gate is reachable through the tunnel; anything else is 404 at cloudflared.
  rm -f "$CONF"
  (umask 077 && cat >"$CONF" <<EOF
tunnel: $id
credentials-file: $creds
no-autoupdate: true
ingress:
  - hostname: $HOST
    service: $ORIGIN_URL
  - service: http_status:404
EOF
  )
  "$CFD" tunnel route dns "$NAME" "$HOST" >/dev/null
  start_connector "$CFD tunnel --no-autoupdate --config $CONF run $NAME"
  say "rate-limit rule NOT applied (needs the API token); the gate's own limits apply meanwhile"
}

up() {
  [ -x "$CFD" ] || { say "cloudflared not found (install it to ~/.local/bin)"; exit 3; }
  gate_closed || {
    say "the gate at $GATE does not answer 503: start the dev server with --public-host $HOST first"
    exit 3
  }
  if have_api; then up_api
  elif have_cert; then up_cert
  else
    say "no way to make the tunnel: put a Cloudflare API token at $API_TOKEN_FILE (0600), or run \`cloudflared tunnel login\`"
    exit 3
  fi
  say "connector started. Check once it has registered: scripts/dev/preview-tunnel.sh status"
}

down() {
  local left=0 id=""
  if has_proc "$PROC"; then "$OXMGR" delete "$PROC" >/dev/null; say "connector stopped"; else say "no $PROC running"; fi
  [ -e "$CONF" ] && id="$(sed -n 's/^tunnel: *//p' "$CONF")"
  if have_api; then
    # Tunnel (either kind, found by name, connections first) and its DNS record.
    if api down; then :; else
      say "the tunnel and DNS record were NOT removed: run bun scripts/ops/cf-tunnel.ts down"
      left=1
    fi
  elif have_cert; then
    if [ -n "$(tunnel_id)" ]; then
      "$CFD" tunnel cleanup "$NAME" >/dev/null 2>&1 || true
      "$CFD" tunnel delete -f "$NAME" >/dev/null
      say "tunnel $NAME deleted"
    fi
    say "DNS record $HOST NOT removed (needs the API token: bun scripts/ops/cf-tunnel.ts down); it reaches nothing now"
    left=1
  else
    say "no API token and no cert.pem: the tunnel and DNS record were NOT removed"
    left=1
  fi
  rm -f "$TOKEN_FILE" "$CONF"
  [ -n "$id" ] && rm -f "$DIR/$id.json"
  say "down (the dev server's gate stays on loopback; restart serve without --public-host to close it too)"
  return "$left"
}

status() {
  echo "mode:       $(have_api && echo 'API token' || { have_cert && echo 'cert.pem (no rate-limit rule)' || echo 'neither'; })"
  echo "connector:  $(has_proc "$PROC" && "$OXMGR" status "$PROC" | sed -n 's/^Status: *//p' || echo 'not running')"
  echo "token file: $( [ -e "$TOKEN_FILE" ] && { secret_ok "$TOKEN_FILE" 2>&1 && echo "$TOKEN_FILE (ok)"; } || echo none)"
  echo "gate:       $(gate_closed && echo "up, 503 without a token" || echo "not answering at $GATE")"
  echo "public:     $("$CURL" -s -o /dev/null -D - --max-time 5 "https://$HOST/_lk/up" 2>/dev/null | grep -qi '^x-lianki-gate: 1' && echo "https://$HOST answers through the gate" || echo "https://$HOST does not reach the gate")"
  if have_api; then api status 2>&1 || true; fi
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
