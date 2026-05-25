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
# Delivers the brief to whichever channels are configured: email (if EMAIL_FROM
# is set) and/or Telegram (if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set).
# A Telegram-only assistant (e.g. a kid's, no email account) just omits
# EMAIL_FROM. Errors only if NEITHER channel is configured.
#
# Config (edit or set in the environment / launchd plist):
#   ALFRED_VAULT      vault path (contains .bin/)
#   ENV_FILE          a file (sourced) exporting any of: EMAIL_FROM +
#                     GMAIL_APP_PASSWORD (email), TELEGRAM_BOT_TOKEN +
#                     TELEGRAM_CHAT_ID (Telegram)
set -euo pipefail
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$HOME/nanoclaw/.env}"

# Secrets are sourced from a file, never hardcoded here.
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

want_email=0; [ -n "${EMAIL_FROM:-}" ] && want_email=1
want_telegram=0; [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && want_telegram=1
if [ "$want_email" -eq 0 ] && [ "$want_telegram" -eq 0 ]; then
  echo "run-daily-brief: no channel configured — set EMAIL_FROM (email) and/or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID (Telegram) in $ENV_FILE" >&2
  exit 1
fi

# Compose the brief ONCE, then fan out to the configured channel(s). --tz makes
# "today" the user's local date even if the runtime zone differs (UTC container).
TZ_ARG=""; [ -n "${TZ:-}" ] && TZ_ARG="--tz $TZ"
BRIEF="$("$ALFRED_VAULT/.bin/daily-brief" $TZ_ARG)"

if [ "$want_email" -eq 1 ]; then
  # Subject reflects the actual counts (e.g. "Daily brief: 2 overdue, 1 due
  # (Mon 25 May)"). Computed in a second, cheap pass (--no-sync/--no-log) that
  # reuses the same composer; falls back to a plain subject if it fails.
  SUBJECT="$("$ALFRED_VAULT/.bin/daily-brief" $TZ_ARG --print-subject --no-sync --no-log 2>/dev/null)"
  [ -n "$SUBJECT" ] || SUBJECT="Daily brief, $(date +%F)"
  printf '%s\n' "$BRIEF" | "$ALFRED_VAULT/.bin/email-digest" \
    --subject "$SUBJECT" \
    --to "$EMAIL_FROM"
fi

# Telegram is best-effort + non-fatal: a Telegram failure must not fail the job
# (when email is also configured, it already went). Same brief body, lands in
# the assistant's chat.
if [ "$want_telegram" -eq 1 ]; then
  printf '%s\n' "$BRIEF" | "$ALFRED_VAULT/.bin/telegram-send" \
    || echo "run-daily-brief: Telegram note failed (non-fatal)" >&2
fi
