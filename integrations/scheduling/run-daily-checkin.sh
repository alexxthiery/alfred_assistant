#!/usr/bin/env bash
# run-daily-checkin.sh — agentic Telegram check-ins for one assistant.
#
# This is not a digest and it does not write to the vault. It asks a headless
# agent, loaded with the vault's generated AGENTS.md and recent check-in ledger,
# to produce one short, natural Telegram message that encourages a reply. The
# wrapper sends the message and records what was sent so future check-ins avoid
# stale or repeated prompts.
#
# Config:
#   ALFRED_VAULT            vault path (contains AGENTS.md and .bin/)
#   ALFRED_ASSISTANT_LABEL  assistant label stamped by the scheduler installer
#   ENV_FILE                vault-private env file with TELEGRAM_BOT_TOKEN,
#                           TELEGRAM_CHAT_ID, ALFRED_EXPECTED_VAULT,
#                           ALFRED_EXPECTED_LABEL, and TZ
#   ALFRED_AGENT_BIN        agent binary; default: claude
set -euo pipefail

SLOT=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slot) SLOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "run-daily-checkin: unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$SLOT" in
  morning|afternoon|evening) ;;
  *) echo "run-daily-checkin: --slot must be morning, afternoon, or evening" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$ALFRED_VAULT/.alfred/private/env}"
ALFRED_AGENT_BIN="${ALFRED_AGENT_BIN:-claude}"

. "$SCRIPT_DIR/assistant-binding.sh"
alfred_require_private_env_path "run-daily-checkin"
alfred_load_private_env "run-daily-checkin"
alfred_require_assistant_binding "run-daily-checkin"

LOG_DIR="$ALFRED_VAULT/cache/daily-checkin"
LOG_FILE="$LOG_DIR/run.log"
LEDGER="$LOG_DIR/checkins.jsonl"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log_msg() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') run-daily-checkin[$SLOT]: $*"
  echo "$line" >&2
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

[ -d "$ALFRED_VAULT" ] || { log_msg "vault not found: $ALFRED_VAULT"; exit 2; }
[ -x "$ALFRED_VAULT/.bin/telegram-send" ] || { log_msg "missing executable: $ALFRED_VAULT/.bin/telegram-send"; exit 2; }
[ -x "$ALFRED_VAULT/.bin/wiki" ] || { log_msg "missing executable: $ALFRED_VAULT/.bin/wiki"; exit 2; }
[ -f "$ALFRED_VAULT/AGENTS.md" ] || { log_msg "missing persona: $ALFRED_VAULT/AGENTS.md"; exit 2; }
command -v "$ALFRED_AGENT_BIN" >/dev/null 2>&1 || { log_msg "agent binary not found: $ALFRED_AGENT_BIN"; exit 2; }

if [ "$DRY_RUN" -eq 0 ]; then
  : "${TELEGRAM_BOT_TOKEN:?run-daily-checkin: TELEGRAM_BOT_TOKEN not set (check ENV_FILE)}"
  : "${TELEGRAM_CHAT_ID:?run-daily-checkin: TELEGRAM_CHAT_ID not set (check ENV_FILE)}"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<DRYRUN
Run the assistant's scheduled ${SLOT} Telegram check-in.

Wrapper will load:
  AGENTS.md
  cache/daily-checkin/checkins.jsonl

It will ask ${ALFRED_AGENT_BIN} for at most two short lines, send them through
.bin/telegram-send, then append the sent message to the check-in ledger.
DRYRUN
  exit 0
fi

cd "$ALFRED_VAULT"
LOCAL_DATE="$(date '+%Y-%m-%d')"
LOCAL_TIME="$(date '+%H:%M')"
RECENT_LEDGER=""
if [ -f "$LEDGER" ]; then
  RECENT_LEDGER="$(tail -n 30 "$LEDGER" || true)"
fi

PROMPT=$(cat <<PROMPT
Run the assistant's scheduled ${SLOT} check-in.

Before writing the message, read AGENTS.md. Use the vault's persona and voice.
You may use read-only wiki commands such as:
  .bin/wiki recent
  .bin/wiki agenda today
  .bin/wiki day ${LOCAL_DATE}
  .bin/wiki search <term>

Do not write to the vault. Do not create todos. Do not run email/Gmail commands.

This is NOT a digest. Output ONLY the Telegram message body, or output nothing if sending a message would be actively unhelpful.

Goal:
- Send a short, natural check-in that makes it easy for the user to reply.
- Use memory and recent context when that produces a natural question.
- Avoid sounding scripted, therapeutic, corporate, or like a worksheet.
- Do not refer to yourself in the third person. Use "I" when needed.
- Ask at most one question.
- Keep it to one or two short lines.
- Do not guilt the user for not replying.
- Avoid repeating the same topic from the recent ledger unless the user engaged with it.

For a morning check-in, prefer a light start-of-day prompt.
For an afternoon check-in, prefer a small question about the day, work/school, friends, activities, or something recent in the vault.
For an evening check-in, prefer a brief end-of-day follow-up, reflection invitation, or tomorrow-orientation prompt.

Style guardrails:
- Openings like "Hi there!", "Hey!", or "Good morning!" are fine when natural.
- Do not use "bestie", "Soph", exaggerated teen slang, or try to sound like a teenager.
- Avoid phrases like "what do you want me to remember?" unless the user directly asked to log something.

Local date/time: ${LOCAL_DATE} ${LOCAL_TIME}
Slot: ${SLOT}

Recent check-in ledger:
---
${RECENT_LEDGER:-"(none)"}
---
PROMPT
)

AGENT_ERR="$LOG_DIR/agent-${SLOT}.stderr"
alfred_prepare_agent_args wiki-read recent agenda day search
set +e
MESSAGE="$("$ALFRED_AGENT_BIN" "${ALFRED_AGENT_ARGS[@]}" -p "$PROMPT" 2>"$AGENT_ERR")"
agent_rc=$?
set -e
if [ "$agent_rc" -ne 0 ]; then
  log_msg "agent failed exit=$agent_rc; stderr: $AGENT_ERR"
  exit "$agent_rc"
fi

if [ -z "$(printf '%s' "$MESSAGE" | tr -d '[:space:]')" ]; then
  log_msg "agent output empty; nothing sent"
  exit 0
fi

printf '%s\n' "$MESSAGE" | "$ALFRED_VAULT/.bin/telegram-send"

LEDGER="$LEDGER" SLOT="$SLOT" MESSAGE="$MESSAGE" LOCAL_DATE="$LOCAL_DATE" LOCAL_TIME="$LOCAL_TIME" node <<'NODE'
const fs = require('fs');
const entry = {
  sent_at_utc: new Date().toISOString(),
  local_date: process.env.LOCAL_DATE,
  local_time: process.env.LOCAL_TIME,
  slot: process.env.SLOT,
  message: process.env.MESSAGE,
};
fs.appendFileSync(process.env.LEDGER, JSON.stringify(entry) + '\n');
NODE

log_msg "completed: sent Telegram message and appended ledger"
