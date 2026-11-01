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
PORT=5188                       # server.py's tunnel listener: tickets required, 127.0.0.1 only
# The STT server's oxmgr entry is never edited: the listener is switched by
# public.json (PUBCONF) plus `oxmgr restart`, then checked; a failed check restores.
SERVER=lianki-stt               # the oxmgr entry of the STT server
PROC=lianki-stt-tunnel          # the oxmgr entry of cloudflared
DIR="${CLOUDFLARED_DIR:-$HOME/.cloudflared}"
CONF="$DIR/$NAME.yml"
PUB="${STT_TICKET_PUB:-$HOME/.config/lianki-stt/ticket.pub}"
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
OXMGR="${OXMGR:-oxmgr}"
CURL="${CURL:-curl}"
PUBCONF="${STT_PUBLIC_CONFIG:-$HOME/.config/lianki-stt/public.json}"  # read by server.py
HEALTH_URL="${STT_HEALTH_URL:-http://127.0.0.1:5193/health}"         # the tailnet listener
WAIT_S="${STT_WAIT_S:-90}"
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

# Restart the STT server and wait for its "listening" line in its own log
# (bounded; the model loads in about a second), then check the tailnet
# listener answers /health and, when wanted, that the tunnel listener started.
restart_and_check() {
  local want="$1" log off
  log="$(field "$SERVER" 'Stdout Log')"
  off=0
  [ -n "$log" ] && [ -f "$log" ] && off="$(wc -c <"$log" | tr -d ' ')"
  "$OXMGR" restart "$SERVER" >/dev/null || return 1
  [ -n "$log" ] || { say "no stdout log for $SERVER"; return 1; }
  python3 -I - "$log" "$off" "$WAIT_S" "$want" <<'PY' || return 1
import sys, time
path, off, wait, want = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
end = time.monotonic() + wait
seen = ""
while time.monotonic() < end:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            f.seek(off)
            seen = f.read()
    except OSError:
        pass
    if "listening on" in seen:
        if want == "on" and "public listener on" not in seen:
            print("[tunnel] the STT server started without the tunnel listener:", file=sys.stderr)
            for line in seen.splitlines():
                if "public listener" in line:
                    print("[tunnel]   " + line.strip(), file=sys.stderr)
            sys.exit(1)
        if want == "off" and "public listener on" in seen:
            print("[tunnel] the tunnel listener is still on", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    time.sleep(0.25)
print(f"[tunnel] no 'listening' line from the STT server within {wait:.0f} s", file=sys.stderr)
sys.exit(1)
PY
  "$CURL" -fsS --max-time 5 "$HEALTH_URL" >/dev/null || { say "$HEALTH_URL does not answer"; return 1; }
}

# public.json as server.py accepts it: a fresh regular file of ours, mode 0600
# (it refuses a symlink or a group/world-writable file). rm first, so an
# existing symlink is replaced, never written through.
write_conf() {
  rm -f "$PUBCONF"
  (umask 077 && printf '%s\n' "$1" >"$PUBCONF")
}

# Turn the tunnel listener on or off through server.py's config file
# (~/.config/lianki-stt/public.json), so the oxmgr entry and all its flags stay
# exactly as they are. On "on", a failed check puts the server back as it was.
server_public() {
  local on="$1" cwd
  if ! has_proc "$SERVER"; then
    say "no oxmgr entry $SERVER: start the STT server first (docs/local-stt.md)"
    [ "$on" = off ] && return 0 || return 1
  fi
  cwd="$(field "$SERVER" 'Working Dir')"
  if [ "$on" = on ]; then
    if ! grep -q -- '--public-config' "$cwd/scripts/local-stt/server.py"; then
      say "$cwd has no tunnel listener in server.py yet: pull main there first"
      return 1
    fi
    local want
    want="$(python3 -I -c 'import json, os, sys; print(json.dumps({"port": int(sys.argv[1]), "pubkey": os.path.abspath(sys.argv[2])}))' "$PORT" "$PUB")"
    if [ -f "$PUBCONF" ] && [ "$(cat "$PUBCONF")" = "$want" ]; then
      say "STT server: tunnel listener already configured"
      return 0
    fi
    if [ -n "${DRY_RUN:-}" ]; then
      echo "+ write $PUBCONF: port $PORT, pubkey $PUB; oxmgr restart $SERVER; check; restore on failure"
      return 0
    fi
    local backup=""
    [ -f "$PUBCONF" ] && { backup="$(cat "$PUBCONF")"; }
    mkdir -p "$(dirname "$PUBCONF")"
    write_conf "$want"
    if restart_and_check on; then
      say "STT server: tunnel listener on 127.0.0.1:$PORT (key $PUB)"
      return 0
    fi
    say "check failed: restoring the STT server as it was"
    if [ -n "$backup" ]; then write_conf "$backup"; else rm -f "$PUBCONF"; fi
    restart_and_check any || say "the STT server did not come back healthy: oxmgr logs $SERVER"
    return 1
  fi
  if [ ! -f "$PUBCONF" ]; then
    say "STT server: tunnel listener already off"
    return 0
  fi
  if [ -n "${DRY_RUN:-}" ]; then
    echo "+ rm $PUBCONF; oxmgr restart $SERVER; check"
    return 0
  fi
  rm -f "$PUBCONF"
  restart_and_check off || { say "the STT server did not come back healthy: oxmgr logs $SERVER"; return 1; }
  say "STT server: tunnel listener off (tailnet unchanged)"
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
  echo "STT server:   $(field "$SERVER" Status || true) — $( [ -f "$PUBCONF" ] && echo "tunnel listener configured ($PUBCONF)" || echo 'no tunnel listener')"
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
