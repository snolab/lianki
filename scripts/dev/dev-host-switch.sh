#!/usr/bin/env bash
# Point https://dev.lianki.com at this Mac's userscript dev server (the dev
# loader on :3003), or back (docs/dev-userscript-loader.md, "Switching
# dev.lianki.com to this Mac"). The Cloudflare side is
# scripts/dev/dev-host-switch.ts; this runs the connector under oxmgr.
#
#   scripts/dev/dev-host-switch.sh plan       # read-only: old → new and the rollback
#   scripts/dev/dev-host-switch.sh up --yes   # only after the owner's tap: DNS changes
#   scripts/dev/dev-host-switch.sh down       # DNS restored exactly, tunnel and token file gone
#   scripts/dev/dev-host-switch.sh status
#
# Needs the Cloudflare API token at ~/.config/lianki/cf-api-token (0600), and
# the dev loader answering on :3003 (bun scripts/dev-userscript-server.ts
# --origin https://dev.lianki.com --port 3003).
set -euo pipefail

PROC=lianki-dev-host-tunnel
PORT="${DEV_LOADER_PORT:-3003}"
TOKEN_FILE="${DEV_HOST_TUNNEL_TOKEN_FILE:-$HOME/.config/lianki/dev-host-tunnel-token}"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
OXMGR="${OXMGR:-oxmgr}"
CURL="${CURL:-curl}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

say() { echo "[dev-host] $*" >&2; }
api() {
  if [ -n "${DEV_HOST_API:-}" ]; then "$DEV_HOST_API" "$@"; else bun "$REPO/scripts/dev/dev-host-switch.ts" "$@"; fi
}
has_proc() { "$OXMGR" status "$1" >/dev/null 2>&1; }
loader_up() { "$CURL" -s -o /dev/null --max-time 5 -w '%{http_code}' "http://localhost:$PORT/health" | grep -q '^200$'; }

up() {
  [ -x "$CFD" ] || { say "cloudflared not found"; exit 3; }
  loader_up || { say "the dev loader does not answer on :$PORT: start it first"; exit 3; }
  if [ "${1:-}" != "--yes" ]; then api plan; say "plan only: run 'up --yes' after the owner approves"; return 0; fi
  api up --yes
  if has_proc "$PROC"; then
    "$OXMGR" restart "$PROC" >/dev/null
  else
    # --token-file: the token is never on a command line (ps) or in oxmgr's config.
    "$OXMGR" start --name "$PROC" --restart always \
      "$CFD tunnel --no-autoupdate run --token-file $TOKEN_FILE" >/dev/null
  fi
  say "connector started; check: scripts/dev/dev-host-switch.sh status"
}

down() {
  if has_proc "$PROC"; then "$OXMGR" delete "$PROC" >/dev/null; say "connector stopped"; fi
  api down
  rm -f "$TOKEN_FILE"
}

status() {
  echo "connector: $(has_proc "$PROC" && echo running || echo 'not running')"
  echo "loader:    $(loader_up && echo "answers on :$PORT" || echo "not answering on :$PORT")"
  echo "public:    $("$CURL" -s --max-time 5 https://dev.lianki.com/loader.user.js | sed -n 's#^// @version *##p' | head -1)"
  api status || true
}

case "${1:-}" in
  plan) api plan ;;
  up) up "${2:-}" ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 plan | up --yes | down | status" >&2; exit 2 ;;
esac
