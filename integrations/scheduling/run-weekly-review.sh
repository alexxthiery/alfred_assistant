#!/usr/bin/env bash
# run-weekly-review.sh — the weekly digest, runtime-independent.
#
# Unlike the daily brief, the weekly review needs *synthesis* (an agent reads
# `wiki review` / `wiki audit` and writes a readable summary). We invoke a
# HEADLESS agent for that — `claude -p` from the vault, so it loads the Alfred
# persona (AGENTS.md) and runs the "Weekly routine" steps — then pipe the
# result to email-digest. This is runtime-independent: it does not require
# nanoclaw or its schedule_task table. Swap `claude -p` for `codex exec` if you
# prefer Codex.
#
# Config:
#   ALFRED_VAULT  vault path
#   ENV_FILE      file exporting EMAIL_FROM + GMAIL_APP_PASSWORD
set -euo pipefail
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/Library/CloudStorage/Dropbox/_AI_box}"
ENV_FILE="${ENV_FILE:-$HOME/nanoclaw/.env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
: "${EMAIL_FROM:?run-weekly-review: EMAIL_FROM not set (check ENV_FILE)}"

cd "$ALFRED_VAULT"
claude -p "Run the weekly vault review exactly as your persona's Weekly routine specifies. Output ONLY the final email body (<=40 lines, the three sections). No preamble." \
  | "$ALFRED_VAULT/.bin/email-digest" \
      --subject "Vault weekly digest — $(date +%F)" \
      --to "$EMAIL_FROM"
