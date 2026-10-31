#!/usr/bin/env bash
# The whole-page dev server's public tunnel: https://preview.lianki.com
# (docs/dev-whole-page.md, "Off the tailnet"). A remotely managed Cloudflare
# tunnel made through the API (scripts/ops/cf-tunnel.ts), run by cloudflared
# under oxmgr with a token FILE, reaching only the guard's gate on
# 127.0.0.1:3104. Tailscale :8443 is untouched.
#
#   scripts/dev/preview-tunnel.sh up       # tunnel + ingress + DNS + rate rule, token file, connector
#   scripts/dev/preview-tunnel.sh down     # rollback: connector, tunnel (connections first), DNS, token file
#   scripts/dev/preview-tunnel.sh status
#
# Needs: the dev server running with `--public-host preview.lianki.com`
# (its gate must already answer 503), and a Cloudflare API token in
# CLOUDFLARE_API_TOKEN or ~/.config/lianki/cf-api-token (0600; the
# permissions are in scripts/ops/cf-tunnel.ts). No cloudflared login.
set -euo pipefail

HOST=preview.lianki.com
GATE="${PREVIEW_GATE_URL:-http://127.0.0.1:3104}"
PROC=lianki-preview-tunnel
TOKEN_FILE="${PREVIEW_TUNNEL_TOKEN_FILE:-$HOME/.config/lianki/preview-tunnel-token}"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
OXMGR="${OXMGR:-oxmgr}"
CURL="${CURL:-curl}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

say() { echo "[preview-tunnel] $*" >&2; }
api() {
  if [ -n "${PREVIEW_TUNNEL_API:-}" ]; then "$PREVIEW_TUNNEL_API" "$@"; else bun "$REPO/scripts/ops/cf-tunnel.ts" "$@"; fi
}
has_proc() { "$OXMGR" status "$1" >/dev/null 2>&1; }

# The gate answers 503 to a request without a token: up, and closed.
gate_closed() {
  local code
  code="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $HOST" "$GATE/" || true)"
  [ "$code" = 503 ]
}

up() {
  [ -x "$CFD" ] || { say "cloudflared not found (install it to ~/.local/bin)"; exit 3; }
  gate_closed || {
    say "the gate at $GATE does not answer 503: start the dev server with --public-host $HOST first"
    exit 3
  }
  api up --token-out "$TOKEN_FILE"
  api check-secret "$TOKEN_FILE" || { say "refusing to run with that token file"; exit 1; }
  if has_proc "$PROC"; then
    "$OXMGR" restart "$PROC" >/dev/null
  else
    # --token-file: the token is never on a command line (ps) or in oxmgr's config.
    "$OXMGR" start --name "$PROC" --restart always \
      "$CFD tunnel --no-autoupdate run --token-file $TOKEN_FILE" >/dev/null
  fi
  say "connector started. Check once it has registered: scripts/dev/preview-tunnel.sh status"
}

down() {
  local left=0
  if has_proc "$PROC"; then "$OXMGR" delete "$PROC" >/dev/null; say "connector stopped"; else say "no $PROC running"; fi
  if api down; then :; else
    say "the tunnel and DNS record were NOT removed (no API token?): run bun scripts/ops/cf-tunnel.ts down"
    left=1
  fi
  rm -f "$TOKEN_FILE"
  say "down (the dev server's gate stays on loopback; restart serve without --public-host to close it too)"
  return "$left"
}

status() {
  echo "connector:  $(has_proc "$PROC" && "$OXMGR" status "$PROC" | sed -n 's/^Status: *//p' || echo 'not running')"
  echo "token file: $( [ -e "$TOKEN_FILE" ] && { api check-secret "$TOKEN_FILE" 2>&1 && echo "$TOKEN_FILE (ok)"; } || echo none)"
  echo "gate:       $(gate_closed && echo "up, 503 without a token" || echo "not answering at $GATE")"
  echo "public:     $("$CURL" -s -o /dev/null -D - --max-time 5 "https://$HOST/_lk/up" 2>/dev/null | grep -qi '^x-lianki-gate: 1' && echo "https://$HOST answers through the gate" || echo "https://$HOST does not reach the gate")"
  api status 2>&1 || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
