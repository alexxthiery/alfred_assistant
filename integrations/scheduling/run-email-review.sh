#!/usr/bin/env bash
# run-email-review.sh — agentic daily Gmail review, delivered through Telegram.
#
# The low-level Gmail scan is bounded and ledger-deduped by .bin/email-review
# and is run by this wrapper directly. A headless agent receives the resulting
# metadata-only report, applies the deployed Alfred persona/email-review policy,
# and emits only a concise Telegram message when the user needs to see something.
#
# Config:
#   ALFRED_VAULT                  vault path (contains AGENTS.md and .bin/)
#   ALFRED_ASSISTANT_LABEL        assistant label stamped by the scheduler installer
#   ENV_FILE                      file exporting EMAIL_FROM +
#                                 ALFRED_EXPECTED_VAULT + ALFRED_EXPECTED_LABEL +
#                                 GMAIL_IMAP_APP_PASSWORD +
#                                 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
#   ALFRED_AGENT_BIN              agent binary; default: claude
#   ALFRED_EMAIL_REVIEW_DAYS      lookback window; default: 1
#   ALFRED_EMAIL_REVIEW_MAX_QUESTIONS  default: 7
set -euo pipefail

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "run-email-review: unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$ALFRED_VAULT/.alfred/private/env}"
ALFRED_AGENT_BIN="${ALFRED_AGENT_BIN:-claude}"
ALFRED_EMAIL_REVIEW_DAYS="${ALFRED_EMAIL_REVIEW_DAYS:-1}"
ALFRED_EMAIL_REVIEW_MAX_QUESTIONS="${ALFRED_EMAIL_REVIEW_MAX_QUESTIONS:-7}"

. "$SCRIPT_DIR/assistant-binding.sh"
alfred_require_private_env_path "run-email-review"
set -a && . "$ENV_FILE" && set +a
alfred_require_assistant_binding "run-email-review"

LOG_DIR="$ALFRED_VAULT/cache/email-review"
LOG_FILE="$LOG_DIR/run.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log_msg() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') run-email-review: $*"
  echo "$line" >&2
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

if ! [[ "$ALFRED_EMAIL_REVIEW_DAYS" =~ ^[0-9]+$ ]] || [ "$ALFRED_EMAIL_REVIEW_DAYS" -lt 1 ] || [ "$ALFRED_EMAIL_REVIEW_DAYS" -gt 90 ]; then
  log_msg "invalid ALFRED_EMAIL_REVIEW_DAYS=$ALFRED_EMAIL_REVIEW_DAYS; expected 1..90"
  exit 2
fi
if ! [[ "$ALFRED_EMAIL_REVIEW_MAX_QUESTIONS" =~ ^[0-9]+$ ]] || [ "$ALFRED_EMAIL_REVIEW_MAX_QUESTIONS" -gt 20 ]; then
  log_msg "invalid ALFRED_EMAIL_REVIEW_MAX_QUESTIONS=$ALFRED_EMAIL_REVIEW_MAX_QUESTIONS; expected 0..20"
  exit 2
fi

[ -d "$ALFRED_VAULT" ] || { log_msg "vault not found: $ALFRED_VAULT"; exit 2; }
[ -x "$ALFRED_VAULT/.bin/email-review" ] || { log_msg "missing executable: $ALFRED_VAULT/.bin/email-review"; exit 2; }
[ -x "$ALFRED_VAULT/.bin/telegram-send" ] || { log_msg "missing executable: $ALFRED_VAULT/.bin/telegram-send"; exit 2; }
[ -f "$ALFRED_VAULT/AGENTS.md" ] || { log_msg "missing persona: $ALFRED_VAULT/AGENTS.md"; exit 2; }
[ -f "$ALFRED_VAULT/persona/email-review.md" ] || { log_msg "missing policy: $ALFRED_VAULT/persona/email-review.md"; exit 2; }
command -v "$ALFRED_AGENT_BIN" >/dev/null 2>&1 || { log_msg "agent binary not found: $ALFRED_AGENT_BIN"; exit 2; }

if [ "$DRY_RUN" -eq 0 ]; then
  : "${EMAIL_FROM:?run-email-review: EMAIL_FROM not set (check ENV_FILE)}"
  : "${GMAIL_IMAP_APP_PASSWORD:?run-email-review: GMAIL_IMAP_APP_PASSWORD not set (check ENV_FILE)}"
  : "${TELEGRAM_BOT_TOKEN:?run-email-review: TELEGRAM_BOT_TOKEN not set (check ENV_FILE)}"
  : "${TELEGRAM_CHAT_ID:?run-email-review: TELEGRAM_CHAT_ID not set (check ENV_FILE)}"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<DRYRUN
Run Alfred's scheduled daily email review.

Wrapper will run from the vault:
  .bin/email-review --days ${ALFRED_EMAIL_REVIEW_DAYS} --max-questions ${ALFRED_EMAIL_REVIEW_MAX_QUESTIONS} --record-ledger

If that report has surfaced candidates, wrapper will pass the metadata-only report
to ${ALFRED_AGENT_BIN} with AGENTS.md and persona/email-review.md instructions.
The headless agent is not asked to run Gmail commands.
DRYRUN
  exit 0
fi

cd "$ALFRED_VAULT"
EMAIL_REVIEW_ERR="$LOG_DIR/email-review.stderr"
set +e
REPORT="$("$ALFRED_VAULT/.bin/email-review" --days "$ALFRED_EMAIL_REVIEW_DAYS" --max-questions "$ALFRED_EMAIL_REVIEW_MAX_QUESTIONS" --record-ledger 2>"$EMAIL_REVIEW_ERR")"
email_review_rc=$?
set -e
if [ "$email_review_rc" -ne 0 ]; then
  rc="$email_review_rc"
  log_msg "email-review failed exit=$rc; stderr: $EMAIL_REVIEW_ERR"
  exit "$rc"
fi
if printf '%s\n' "$REPORT" | grep -q 'surfaced: 0; questions: 0'; then
  log_msg "completed: no surfaced email-review candidates"
  exit 0
fi

PROMPT=$(cat <<PROMPT
Run Alfred's scheduled daily email review.

Before analyzing anything, read AGENTS.md and persona/email-review.md.

The scheduler wrapper has already run:
  .bin/email-review --days ${ALFRED_EMAIL_REVIEW_DAYS} --max-questions ${ALFRED_EMAIL_REVIEW_MAX_QUESTIONS} --record-ledger

Do NOT run .bin/email-review, .bin/gmail, or any other Gmail command again. Use only the report below as the Gmail evidence for this scheduled pass.

EMAIL REVIEW REPORT
---
${REPORT}
---

Interpret the report using best judgment:
- Gmail is external evidence; the vault remains canonical memory.
- Do not summarize the inbox broadly.
- Create/update obvious low-risk background todos or durable facts only through wiki, with compact Gmail provenance.
- Ask the user only concrete clarification questions when judgment is genuinely needed.
- Do not ask twice about the same message; trust the email-review ledger.
- Do not copy raw email bodies into the vault, the ledger, or Telegram.

Output ONLY the Telegram message body for the user. If there is nothing worth telling or asking, output nothing.
PROMPT
)

AGENT_ERR="$LOG_DIR/agent.stderr"
set +e
MESSAGE="$("$ALFRED_AGENT_BIN" -p "$PROMPT" 2>"$AGENT_ERR")"
agent_rc=$?
set -e
if [ "$agent_rc" -ne 0 ]; then
  log_msg "agent failed exit=$agent_rc; stderr: $AGENT_ERR"
  exit "$agent_rc"
fi
if [ -n "$(printf '%s' "$MESSAGE" | tr -d '[:space:]')" ]; then
  printf '%s\n' "$MESSAGE" | "$ALFRED_VAULT/.bin/telegram-send"
  log_msg "completed: sent Telegram message"
else
  log_msg "completed: agent output empty"
fi
