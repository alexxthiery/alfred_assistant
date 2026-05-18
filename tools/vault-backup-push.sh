#!/usr/bin/env bash
# vault-backup-push.sh — push the vault to its `origin` remote.
# Idempotent: only pushes if local commits are ahead. Quiet on no-op.
# Wire into cron / launchd / a Telegram nudge for periodic execution.
#
# Usage:
#   tools/vault-backup-push.sh <vault-dir>
#   tools/vault-backup-push.sh ~/Library/CloudStorage/Dropbox/_AI_box
#
# Exit 0 on success/no-op, 1 on push failure.

set -uo pipefail

VAULT_DIR="${1:-}"
if [ -z "$VAULT_DIR" ]; then
  echo "usage: $0 <vault-dir>" >&2
  exit 2
fi
if [ ! -d "$VAULT_DIR/.git" ]; then
  echo "error: $VAULT_DIR is not a git repo" >&2
  exit 2
fi

cd "$VAULT_DIR" || exit 2

# Skip if no remote configured.
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "vault-backup-push: no 'origin' remote configured in $VAULT_DIR; skipping" >&2
  exit 0
fi

# Skip if working tree dirty — refuse to push partial work.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "vault-backup-push: working tree has uncommitted changes; skipping push" >&2
  exit 0
fi

# Skip if local is not ahead.
git fetch origin --quiet 2>/dev/null || true
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "")
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0  # silent no-op when already synced
fi

if git push origin HEAD 2>&1; then
  echo "vault-backup-push: pushed $(git rev-parse --short HEAD) to origin"
  exit 0
fi

echo "vault-backup-push: push failed" >&2
exit 1
