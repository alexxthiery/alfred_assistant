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
# Channel failures are isolated: an SMTP outage must not suppress Telegram.
# Failures are logged to <vault>/cache/daily-brief/send.log and retried once
# after DAILY_BRIEF_RETRY_AFTER_SECONDS (default: 10800 = 3 hours).
#
# Config (edit or set in the environment / launchd plist):
#   ALFRED_VAULT      vault path (contains .bin/)
#   ALFRED_ASSISTANT_LABEL  assistant label stamped by the scheduler installer
#   ENV_FILE          a file (sourced) exporting any of: EMAIL_FROM +
#                     ALFRED_EXPECTED_VAULT + ALFRED_EXPECTED_LABEL +
#                     GMAIL_APP_PASSWORD (email), TELEGRAM_BOT_TOKEN +
#                     TELEGRAM_CHAT_ID (Telegram)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$ALFRED_VAULT/.alfred/private/env}"
RETRY_AFTER_SECONDS="${DAILY_BRIEF_RETRY_AFTER_SECONDS:-10800}"
RETRY_ON_FAILURE="${DAILY_BRIEF_RETRY_ON_FAILURE:-1}"

# Secrets are sourced from a file, never hardcoded here.
. "$SCRIPT_DIR/assistant-binding.sh"
alfred_require_private_env_path "run-daily-brief"
set -a && . "$ENV_FILE" && set +a
alfred_require_assistant_binding "run-daily-brief"

LOG_DIR="$ALFRED_VAULT/cache/daily-brief"
LOG_FILE="$LOG_DIR/send.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log_msg() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') run-daily-brief: $*"
  echo "$line" >&2
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

summarize_output() {
  local file="$1"
  if [ ! -s "$file" ]; then
    printf '(no output)'
    return
  fi
  tail -n 12 "$file" | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g'
}

if ! [[ "$RETRY_AFTER_SECONDS" =~ ^[0-9]+$ ]]; then
  log_msg "invalid DAILY_BRIEF_RETRY_AFTER_SECONDS=$RETRY_AFTER_SECONDS; using 10800"
  RETRY_AFTER_SECONDS=10800
fi

want_email=0; [ -n "${EMAIL_FROM:-}" ] && want_email=1
want_telegram=0; [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && want_telegram=1
if [ "$want_email" -eq 0 ] && [ "$want_telegram" -eq 0 ]; then
  log_msg "no channel configured — set EMAIL_FROM (email) and/or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID (Telegram) in $ENV_FILE"
  exit 1
fi

# Compose the brief ONCE, then fan out to the configured channel(s). --tz makes
# "today" the user's local date even if the runtime zone differs (UTC container).
TZ_ARGS=()
[ -n "${TZ:-}" ] && TZ_ARGS=(--tz "$TZ")
BRIEF="$("$ALFRED_VAULT/.bin/daily-brief" "${TZ_ARGS[@]}")"

if [ "$want_email" -eq 1 ]; then
  # Subject reflects the actual counts (e.g. "Daily brief: 2 overdue, 1 due
  # (Mon 25 May)"). Computed in a second, cheap pass (--no-sync/--no-log) that
  # reuses the same composer; falls back to a plain subject if it fails.
  SUBJECT="$("$ALFRED_VAULT/.bin/daily-brief" "${TZ_ARGS[@]}" --print-subject --no-sync --no-log 2>/dev/null || true)"
  [ -n "$SUBJECT" ] || SUBJECT="Daily brief, $(date +%F)"
fi

send_email() {
  printf '%s\n' "$BRIEF" | "$ALFRED_VAULT/.bin/email-digest" \
    --subject "$SUBJECT" \
    --to "$EMAIL_FROM"
}

send_telegram() {
  printf '%s\n' "$BRIEF" | "$ALFRED_VAULT/.bin/telegram-send"
}

attempt_channel() {
  local channel="$1"
  local tmp status summary
  tmp="$(mktemp -t "alfred-daily-brief-${channel}.XXXXXX")"
  if "send_${channel}" >"$tmp" 2>&1; then
    summary="$(summarize_output "$tmp")"
    log_msg "$channel send ok: $summary"
    rm -f "$tmp"
    return 0
  else
    status=$?
  fi
  summary="$(summarize_output "$tmp")"
  log_msg "$channel send failed exit=$status: $summary"
  rm -f "$tmp"
  return "$status"
}

failed_channels=()
if [ "$want_email" -eq 1 ]; then
  if ! attempt_channel email; then
    failed_channels+=("email")
  fi
fi
if [ "$want_telegram" -eq 1 ]; then
  if ! attempt_channel telegram; then
    failed_channels+=("telegram")
  fi
fi

if [ "${#failed_channels[@]}" -gt 0 ] && [ "$RETRY_ON_FAILURE" != "0" ]; then
  log_msg "retrying failed channel(s) in ${RETRY_AFTER_SECONDS}s: ${failed_channels[*]}"
  sleep "$RETRY_AFTER_SECONDS"

  still_failed=()
  for channel in "${failed_channels[@]}"; do
    if ! attempt_channel "$channel"; then
      still_failed+=("$channel")
    fi
  done
  if [ "${#still_failed[@]}" -gt 0 ]; then
    failed_channels=("${still_failed[@]}")
  else
    failed_channels=()
  fi
elif [ "${#failed_channels[@]}" -gt 0 ]; then
  log_msg "retry disabled; failed channel(s): ${failed_channels[*]}"
fi

if [ "${#failed_channels[@]}" -gt 0 ]; then
  log_msg "giving up; failed channel(s): ${failed_channels[*]}"
  exit 1
fi

log_msg "all configured channels delivered"
