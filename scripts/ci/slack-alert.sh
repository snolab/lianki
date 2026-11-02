#!/usr/bin/env bash
# Posts one line to Slack #lianki from a CI job: scripts/ci/slack-alert.sh "<text>".
# Needs SLACK_WEBHOOK_URL (an incoming webhook for #lianki, a repo secret). When
# it is unset, emits a workflow warning instead of failing the job a second time.
set -euo pipefail
text="$1"
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "::warning title=No Slack alert::SLACK_WEBHOOK_URL is not set, so #lianki was not told: $text"
  exit 0
fi
payload=$(TEXT="$text" node -e 'process.stdout.write(JSON.stringify({ text: process.env.TEXT }))' 2>/dev/null ||
  TEXT="$text" bun -e 'process.stdout.write(JSON.stringify({ text: process.env.TEXT }))')
curl -sSf --retry 3 -H 'Content-Type: application/json' -d "$payload" "$SLACK_WEBHOOK_URL" >/dev/null
