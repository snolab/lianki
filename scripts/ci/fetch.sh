#!/usr/bin/env bash
# Download a tool for CI to a FILE, retrying a flaky CDN (docs/shipping.md,
# "Flaky tool downloads"). Three attempts, 10 s then 30 s apart: on 2026-11-09
# GitHub's release CDN answered 504 for minutes, and curl's own --retry (3 s
# apart) gave up inside the outage.
#
#   bash scripts/ci/fetch.sh <url> <out-file>
set -uo pipefail

url="${1:?usage: fetch.sh <url> <out-file>}"
out="${2:?usage: fetch.sh <url> <out-file>}"
delays=(10 30)

for attempt in 1 2 3; do
  if curl -sSfL --connect-timeout 20 --max-time 300 -o "$out" "$url"; then
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    wait_s="${delays[$((attempt - 1))]}"
    echo "::warning title=download retry::attempt $attempt of 3 failed for $url; retrying in ${wait_s}s"
    sleep "$wait_s"
  fi
done

echo "::error title=download failed::$url failed 3 times"
exit 1
