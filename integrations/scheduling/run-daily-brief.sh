#!/usr/bin/env bash
# run-daily-brief.sh — the deterministic morning brief, runtime-independent.
#
# No agent involved: bin/daily-brief composes the brief and bin/email-digest
# sends it. Invoked by launchd/cron (see com.alfred.daily-brief.plist). Because
# it needs no LLM, it is the most robust scheduled job — it does not depend on
# nanoclaw being up or any agent runtime.
#
# Sends the brief to email, and (if Telegram creds are set) the same brief as a
# Telegram message — both deterministically from one composition, no agent.
#
# Config (edit or set in the environment / launchd plist):
#   ALFRED_VAULT      vault path (contains .bin/)
#   ENV_FILE          a file exporting EMAIL_FROM + GMAIL_APP_PASSWORD, and
#                     optionally TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (sourced)
set -euo pipefail
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$HOME/nanoclaw/.env}"

# Secrets are sourced from a file, never hardcoded here.
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
: "${EMAIL_FROM:?run-daily-brief: EMAIL_FROM not set (check ENV_FILE)}"

# Compose the brief ONCE, then fan out to both channels. --tz makes "today" the
# user's local date even if the runtime zone differs (e.g. a UTC container).
TZ_ARG=""; [ -n "${TZ:-}" ] && TZ_ARG="--tz $TZ"
BRIEF="$("$ALFRED_VAULT/.bin/daily-brief" $TZ_ARG)"

# Email (primary).
printf '%s\n' "$BRIEF" | "$ALFRED_VAULT/.bin/email-digest" \
  --subject "Daily brief — $(date +%F)" \
  --to "$EMAIL_FROM"

# Telegram note (best-effort; only if creds are configured). Same brief body,
# lands in the same chat the agent uses. Non-fatal: a Telegram failure must not
# fail the job after the email already went.
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  printf '%s\n' "$BRIEF" | "$ALFRED_VAULT/.bin/telegram-send" \
    || echo "run-daily-brief: Telegram note failed (non-fatal; email already sent)" >&2
fi
