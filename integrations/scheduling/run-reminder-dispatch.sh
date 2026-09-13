#!/usr/bin/env bash
# run-reminder-dispatch.sh — the Telegram half of the vault-backed reminder
# system, runtime-independent.
#
# No agent involved: bin/reminder-dispatch finds reminders due now (vault todos
# with a remind_at <= now and no reminded_at stamp) and emits one line each;
# bin/telegram-send pushes them to Telegram and reminder-dispatch stamps them so
# they can't re-fire. Invoked every ~15 min by launchd/cron (see
# com.alfred.reminder-dispatch.plist). It does not depend on nanoclaw being up.
#
# The email half is separate: a reminder todo with a `due:` date is surfaced by
# the 07:00 daily brief. One vault todo, both channels.
#
# Config (edit or set in the environment / launchd plist):
#   ALFRED_VAULT  vault path (contains .bin/)
#   ALFRED_ASSISTANT_LABEL  assistant label stamped by the scheduler installer
#   ENV_FILE      a file exporting TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID +
#                 ALFRED_EXPECTED_VAULT + ALFRED_EXPECTED_LABEL (sourced)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$ALFRED_VAULT/.alfred/private/env}"

# Secrets are sourced from a file, never hardcoded here.
. "$SCRIPT_DIR/assistant-binding.sh"
alfred_require_private_env_path "run-reminder-dispatch"
set -a && . "$ENV_FILE" && set +a
alfred_require_assistant_binding "run-reminder-dispatch"
: "${TELEGRAM_BOT_TOKEN:?run-reminder-dispatch: TELEGRAM_BOT_TOKEN not set (check ENV_FILE)}"
: "${TELEGRAM_CHAT_ID:?run-reminder-dispatch: TELEGRAM_CHAT_ID not set (check ENV_FILE)}"

# reminder-dispatch emits nothing when no reminder is due; telegram-send treats
# empty stdin as a no-op, so this is silent on the common path.
"$ALFRED_VAULT/.bin/reminder-dispatch" \
  | "$ALFRED_VAULT/.bin/telegram-send"
