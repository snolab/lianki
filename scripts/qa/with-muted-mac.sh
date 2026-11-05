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
# Several QA runs at once share one mute (worktrees overlap all the time):
#   - $DIR/holder.<pid>, one per running wrapper. A holder counts only while
#     that pid is the same process (its start time is in the file), so a killed
#     run is ignored and a reused pid cannot hold the mute for ever.
#   - $DIR/original-muted: written by the first holder, acted on and removed by
#     the last. It goes only once the Mac has been seen unmuted, so a failed
#     restore is tried again rather than read as "muted" by the next run. That
#     misreading kept the owner's Mac muted (2026-11-05 14:21 JST).
#   - $DIR/mutex guards both. mkdir is atomic; the owner's pid is inside, so it
#     is broken only for a dead owner, or a stuck one after LOCK_WAIT. Every
#     osascript under it has a time limit, so a live owner never gets that old.
#   - A watcher per wrapper is detached from its process group and blocks on a
#     pipe only that wrapper holds. The wrapper's death — even kill -9 of the
#     whole tree — closes the pipe, and the watcher settles the mute. No polling.
#
# Keep the file names: older checkouts of this script share the directory.
# Not macOS (CI): the command just runs.
set -u

if [ "$(uname -s)" != "Darwin" ] || ! command -v osascript >/dev/null 2>&1; then
  exec "$@"
fi

DIR="${LIANKI_QA_MUTE_DIR:-$HOME/.cache/lianki-qa-mute}"
STATE="$DIR/original-muted"
MUTEX="$DIR/mutex"
BREAKER="$DIR/mutex-breaker"
ME="$DIR/holder.$$"
LOCK_WAIT=300 # tenths of a second

# Nowhere to keep the state means no way to restore it: leave the sound alone.
if ! mkdir -p "$DIR" 2>/dev/null || [ ! -w "$DIR" ]; then
  echo "with-muted-mac: $DIR is not writable, not muting" >&2
  exec "$@"
fi

started() { ps -o lstart= -p "$1" 2>/dev/null; }

lock() {
  local i=0 owner now
  until mkdir "$MUTEX" 2>/dev/null; do
    i=$((i + 1))
    owner="$(cat "$MUTEX/pid" 2>/dev/null)"
    # No pid is an older checkout's mutex, or an owner just past its mkdir: only
    # the long wait says anything about those.
    if { [ -n "$owner" ] && [ -z "$(started "$owner")" ]; } || [ "$i" -gt "$LOCK_WAIT" ]; then
      # One breaker at a time, and only the mutex it looked at: a second waiter
      # acting on the same dead owner must not remove the next owner's mutex.
      if mkdir "$BREAKER" 2>/dev/null; then
        now="$(cat "$MUTEX/pid" 2>/dev/null)"
        if [ "$now" = "$owner" ]; then rm -rf "$MUTEX"; fi
        rmdir "$BREAKER" 2>/dev/null
        i=0
      elif [ "$i" -gt $((LOCK_WAIT * 2)) ]; then
        rmdir "$BREAKER" 2>/dev/null # its breaker was killed
        i=0
      fi
    fi
    sleep 0.1
  done
  echo "$$" >"$MUTEX/pid"
}
unlock() { rm -rf "$MUTEX"; }

prune() {
  local f pid want now
  for f in "$DIR"/holder.*; do
    [ -e "$f" ] || continue
    pid="${f##*.}"
    want="$(cat "$f" 2>/dev/null)"
    now="$(started "$pid")"
    # An empty file is an older checkout's holder: all it has is the pid.
    if [ -z "$now" ] || { [ -n "$want" ] && [ "$want" != "$now" ]; }; then rm -f "$f"; fi
  done
}

holders() { ls "$DIR"/holder.* 2>/dev/null | wc -l | tr -d ' '; }

# osascript with a time limit: it runs under the mutex and can hang on a busy
# audio daemon. Fd 8 is the watcher's pipe, which only the wrapper may hold.
osa() {
  osascript -e "$1" 8>&- 2>/dev/null &
  local job=$! guard rc
  { sleep 8 8>&- && kill "$job"; } >/dev/null 2>&1 &
  guard=$!
  wait "$job" 2>/dev/null
  rc=$?
  kill "$guard" 2>/dev/null
  wait "$guard" 2>/dev/null
  return "$rc"
}

muted_now() { osa 'output muted of (get volume settings)'; }

# Whether output is muted, or "unknown" when it cannot be read. Never guess
# "true" here: an original of "true" is never restored.
read_original() {
  local i value
  for i in 1 2 3; do
    if value="$(muted_now)" && [ -n "$value" ]; then
      echo "$value"
      return
    fi
    sleep 0.5
  done
  echo unknown
}

mute() { osa 'set volume with output muted' >/dev/null || true; }

# The Mac ends up as it was. Only an original of exactly "true" stays muted: an
# unreadable one, or none (a device with no mute reads "missing value"), is
# unmuted, since a Mac stuck on mute is the failure this file exists to prevent.
settle() {
  local i
  prune
  if [ "$(holders)" != "0" ] || [ ! -f "$STATE" ]; then return; fi
  if [ "$(cat "$STATE")" = "true" ]; then
    rm -f "$STATE"
    return
  fi
  for i in 1 2 3; do
    osa 'set volume without output muted' >/dev/null
    if [ "$(muted_now)" != "true" ]; then
      rm -f "$STATE"
      return
    fi
    sleep 0.5
  done
  echo "with-muted-mac: could not unmute; the next run tries again ($STATE)" >&2
}

# The watcher: its stdin is the wrapper's pipe. EOF means the wrapper is gone.
if [ -n "${LIANKI_QA_MUTE_WATCH:-}" ]; then
  trap '' INT TERM HUP
  cat >/dev/null
  # Ignored signals are inherited, and osa() must be able to stop its guard.
  trap - INT TERM HUP
  # Nothing saved: a clean exit already restored, or a live holder will.
  [ -f "$STATE" ] || exit 0
  lock
  settle
  unlock
  exit 0
fi

restore() {
  trap - EXIT INT TERM HUP
  lock
  rm -f "$ME"
  settle
  unlock
}

# Double fork, with job control on so the watcher gets its own process group: a
# kill of the run's group or tree does not reach it. Stdout and stderr go nowhere
# so a pipe reading this wrapper's output still sees EOF when the wrapper ends.
exec 8> >(
  set -m
  LIANKI_QA_MUTE_WATCH=1 bash "$0" <&0 >/dev/null 2>&1 &
)

lock
prune
if [ ! -f "$STATE" ]; then
  # The first holder saves the state. With live holders but no saved state their
  # mute is all a read would see, so the original counts as not muted. A leftover
  # state with no live holder is from a crashed run: it is still the original.
  if [ "$(holders)" = "0" ]; then read_original >"$STATE"; else echo false >"$STATE"; fi
fi
mute
started "$$" >"$ME"
unlock

trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
trap 'restore; exit 129' HUP
trap 'restore' EXIT

"$@" 8>&-
