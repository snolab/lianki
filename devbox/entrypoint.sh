#!/bin/bash
# First-run setup for the dev box (devbox/README.md). Idempotent: on later
# starts it only fills in what is missing. Never fetches or writes a credential.
set -euo pipefail

: "${DEVBOX_NAME:?DEVBOX_NAME is required (devbox/.env)}"
BRANCH="friend/${DEVBOX_NAME}"
REPO_URL="${DEVBOX_REPO_URL:-https://github.com/snolab/lianki.git}"
REPO=/home/node/lianki
STATE=/home/node/.devbox

mkdir -p "$STATE"

if [ ! -d "$REPO/.git" ]; then
  echo "devbox: cloning $REPO_URL ($BRANCH)"
  # Anonymous HTTPS clone of the public repo: the box holds no GitHub credential.
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO" \
    || git clone "$REPO_URL" "$REPO"
  git -C "$REPO" checkout "$BRANCH" 2>/dev/null || git -C "$REPO" checkout -b "$BRANCH"
  # origin is fetch-only. Pushes go to the friend's own fork (README, "Git").
  git -C "$REPO" remote set-url --push origin "no-push: open a PR from your fork (devbox/README.md)"
fi

# Local-only auth secret for the dev server's local D1, made once per box.
if [ ! -s "$STATE/auth-secret" ]; then
  (umask 077; head -c 32 /dev/urandom | base64 > "$STATE/auth-secret")
fi

cd "$REPO"
if [ ! -d node_modules ] || [ package.json -nt node_modules/.devbox-installed ] || [ bun.lock -nt node_modules/.devbox-installed ]; then
  echo "devbox: bun install"
  bun install --frozen-lockfile || bun install
  touch node_modules/.devbox-installed
fi

# Local Miniflare D1 only (.wrangler/state in the volume). No --remote, no login.
echo "devbox: applying migrations to the local D1"
CI=1 bunx wrangler d1 migrations apply lianki --local >/dev/null

exec "$@"
