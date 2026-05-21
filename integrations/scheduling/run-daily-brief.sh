#!/usr/bin/env bash
# run-daily-brief.sh — the deterministic morning brief, runtime-independent.
#
# No agent involved: bin/daily-brief composes the brief and bin/email-digest
# sends it. Invoked by launchd/cron (see com.alfred.daily-brief.plist). Because
# it needs no LLM, it is the most robust scheduled job — it does not depend on
# nanoclaw being up or any agent runtime.
#
# Config (edit or set in the environment / launchd plist):
#   ALFRED_VAULT  vault path (contains .bin/)
#   ENV_FILE      a file exporting EMAIL_FROM + GMAIL_APP_PASSWORD (sourced)
set -euo pipefail
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$HOME/nanoclaw/.env}"

# Secrets are sourced from a file, never hardcoded here.
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
: "${EMAIL_FROM:?run-daily-brief: EMAIL_FROM not set (check ENV_FILE)}"

"$ALFRED_VAULT/.bin/daily-brief" \
  | "$ALFRED_VAULT/.bin/email-digest" \
      --subject "Daily brief — $(date +%F)" \
      --to "$EMAIL_FROM"
