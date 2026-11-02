#!/usr/bin/env bash
# Run a command with the Mac's sound output muted, then put it back.
#
#   bash scripts/qa/with-muted-mac.sh <command> [args…]
#
# Owner, 2026-10-31 03:34 JST: QA may run at any hour, but the Mac must go
# silent by itself (it read words aloud in the middle of the night). Before the
# command: remember whether output was muted, then mute. After it — success,
# failure, Ctrl-C or kill — restore what was there before (muted stays muted).
#
# Several QA runs at once share one mute: holders are pid files in $DIR, the
# first holder saves the original state, the last one restores it. A holder
# whose pid is gone is pruned, so a crashed run cannot keep the Mac muted
# forever, and its saved state is still the original one. Not macOS (CI): the
# command just runs.
set -u

if [ "$(uname -s)" != "Darwin" ] || ! command -v osascript >/dev/null 2>&1; then
  exec "$@"
fi

DIR="${LIANKI_QA_MUTE_DIR:-$HOME/.cache/lianki-qa-mute}"
STATE="$DIR/original-muted"
MUTEX="$DIR/mutex"
ME="$DIR/holder.$$"
mkdir -p "$DIR"

lock() {
  local i=0
  until mkdir "$MUTEX" 2>/dev/null; do
    i=$((i + 1))
    # A mutex older than 30 s belongs to a killed wrapper.
    if [ "$i" -gt 300 ] || [ -n "$(find "$MUTEX" -maxdepth 0 -mmin +0.5 2>/dev/null)" ]; then
      rm -rf "$MUTEX"
    fi
    sleep 0.1
  done
}
unlock() { rmdir "$MUTEX" 2>/dev/null || true; }

prune() {
  local f pid
  for f in "$DIR"/holder.*; do
    [ -e "$f" ] || continue
    pid="${f##*.}"
    kill -0 "$pid" 2>/dev/null || rm -f "$f"
  done
}

holders() { ls "$DIR"/holder.* 2>/dev/null | wc -l | tr -d ' '; }

muted_now() { osascript -e 'output muted of (get volume settings)' 2>/dev/null || echo "true"; }

restore() {
  trap - EXIT INT TERM HUP
  lock
  rm -f "$ME"
  prune
  if [ "$(holders)" = "0" ] && [ -f "$STATE" ]; then
    if [ "$(cat "$STATE")" = "false" ]; then
      osascript -e 'set volume without output muted' >/dev/null 2>&1 || true
    fi
    rm -f "$STATE"
  fi
  unlock
}

lock
prune
# The first holder saves the state. A leftover STATE with no live holder is
# from a crashed run: keep it, it is still the original.
if [ "$(holders)" = "0" ] && [ ! -f "$STATE" ]; then
  muted_now >"$STATE"
fi
osascript -e 'set volume with output muted' >/dev/null 2>&1 || true
touch "$ME"
unlock

trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 129' HUP
trap 'restore' EXIT

"$@"
