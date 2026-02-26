#!/usr/bin/env bash
set -e

# Get list of staged files before formatting
STAGED_FILES=$(git diff --cached --name-only)

# Run linting and formatting
bun fix
bun run typecheck

# Re-stage files that were formatted
for file in $STAGED_FILES; do
  if [ -f "$file" ] && git diff --name-only | grep -q "^$file$"; then
    git add "$file"
    echo "Auto-staged formatting changes: $file"
  fi
done
