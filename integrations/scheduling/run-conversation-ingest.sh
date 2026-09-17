#!/usr/bin/env bash
# run-conversation-ingest.sh — daily conservative fact ingestion from private
# conversation mirrors.
#
# The wrapper is only an orchestrator. It may mirror runtime transcript files
# into the vault-private conversation archive, then invokes a headless agent.
# Any durable vault writes must go through .bin/wiki ingest or .bin/wiki patch.
#
# Config:
#   ALFRED_VAULT                  vault path (contains AGENTS.md and .bin/)
#   ALFRED_ASSISTANT_LABEL        assistant label stamped by the scheduler installer
#   ENV_FILE                      vault-private env file with TELEGRAM_BOT_TOKEN,
#                                 TELEGRAM_CHAT_ID, ALFRED_EXPECTED_VAULT,
#                                 ALFRED_EXPECTED_LABEL, and TZ
#   ALFRED_AGENT_BIN              agent binary; default: claude
#   ALFRED_CONVERSATION_SOURCE    optional runtime transcript directory to mirror
#   ALFRED_CONVERSATION_PROVIDER  provider label for mirror; default: nanoclaw
#   ALFRED_CONVERSATION_SOURCE_NAME source name for mirror; default: assistant label
#   ALFRED_CONVERSATION_SOURCE_EXTENSIONS optional comma-separated import extensions
#                                 for the runtime source; default: wiki CLI default
#   ALFRED_CONVERSATION_EXCLUDE_DIRS optional comma-separated source dir names to skip
#   ALFRED_CONVERSATION_EXTRACT  optional compact extractor; currently claude-jsonl
#   ALFRED_CONVERSATION_EXTRACT_ONLY optional true/1 to skip full raw mirror
#   ALFRED_CONVERSATION_INGEST_DAYS lookback window; default: 1
set -euo pipefail

DRY_RUN=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "run-conversation-ingest: unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$ALFRED_VAULT/.alfred/private/env}"
ALFRED_AGENT_BIN="${ALFRED_AGENT_BIN:-claude}"
ALFRED_CONVERSATION_PROVIDER="${ALFRED_CONVERSATION_PROVIDER:-nanoclaw}"
ALFRED_CONVERSATION_INGEST_DAYS="${ALFRED_CONVERSATION_INGEST_DAYS:-1}"

. "$SCRIPT_DIR/assistant-binding.sh"
alfred_require_private_env_path "run-conversation-ingest"
alfred_load_private_env "run-conversation-ingest"
alfred_require_assistant_binding "run-conversation-ingest"

ALFRED_CONVERSATION_SOURCE_NAME="${ALFRED_CONVERSATION_SOURCE_NAME:-$ALFRED_ASSISTANT_LABEL}"

LOG_DIR="$ALFRED_VAULT/cache/conversation-ingest"
LOG_FILE="$LOG_DIR/run.log"
LEDGER="$LOG_DIR/ledger.jsonl"
CONVERSATION_ROOT="$ALFRED_VAULT/.alfred/private/conversations"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log_msg() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') run-conversation-ingest: $*"
  echo "$line" >&2
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

if ! [[ "$ALFRED_CONVERSATION_INGEST_DAYS" =~ ^[0-9]+$ ]] || [ "$ALFRED_CONVERSATION_INGEST_DAYS" -lt 1 ] || [ "$ALFRED_CONVERSATION_INGEST_DAYS" -gt 14 ]; then
  log_msg "invalid ALFRED_CONVERSATION_INGEST_DAYS=$ALFRED_CONVERSATION_INGEST_DAYS; expected 1..14"
  exit 2
fi

[ -d "$ALFRED_VAULT" ] || { log_msg "vault not found: $ALFRED_VAULT"; exit 2; }
[ -x "$ALFRED_VAULT/.bin/wiki" ] || { log_msg "missing executable: $ALFRED_VAULT/.bin/wiki"; exit 2; }
[ -x "$ALFRED_VAULT/.bin/telegram-send" ] || { log_msg "missing executable: $ALFRED_VAULT/.bin/telegram-send"; exit 2; }
[ -f "$ALFRED_VAULT/AGENTS.md" ] || { log_msg "missing persona: $ALFRED_VAULT/AGENTS.md"; exit 2; }
[ -f "$ALFRED_VAULT/persona/conversation-ingest.md" ] || { log_msg "missing policy: $ALFRED_VAULT/persona/conversation-ingest.md"; exit 2; }
command -v "$ALFRED_AGENT_BIN" >/dev/null 2>&1 || { log_msg "agent binary not found: $ALFRED_AGENT_BIN"; exit 2; }

if [ "$DRY_RUN" -eq 0 ]; then
  : "${TELEGRAM_BOT_TOKEN:?run-conversation-ingest: TELEGRAM_BOT_TOKEN not set (check ENV_FILE)}"
  : "${TELEGRAM_CHAT_ID:?run-conversation-ingest: TELEGRAM_CHAT_ID not set (check ENV_FILE)}"
fi

LOCAL_DATE="$(date '+%Y-%m-%d')"
LOCAL_TIME="$(date '+%H:%M')"

if [ "$FORCE" -eq 0 ] && [ -f "$LEDGER" ] && grep -q "\"local_date\":\"$LOCAL_DATE\"" "$LEDGER"; then
  log_msg "completed: already ran for $LOCAL_DATE (use --force to rerun)"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<DRYRUN
Run the assistant's scheduled daily conversation fact ingestion.

Wrapper will:
  1. optionally mirror ALFRED_CONVERSATION_SOURCE into .alfred/private/conversations/
  2. read recent private conversation deltas/files from the last ${ALFRED_CONVERSATION_INGEST_DAYS} day(s)
  3. invoke ${ALFRED_AGENT_BIN} with AGENTS.md and persona/conversation-ingest.md
  4. require any durable writes to go through .bin/wiki ingest or .bin/wiki patch
  5. send only concrete clarification questions through .bin/telegram-send
DRYRUN
  exit 0
fi

cd "$ALFRED_VAULT"

if [ -n "${ALFRED_CONVERSATION_SOURCE:-}" ]; then
  [ -d "$ALFRED_CONVERSATION_SOURCE" ] || { log_msg "conversation source not found: $ALFRED_CONVERSATION_SOURCE"; exit 2; }
  IMPORT_OUT="$LOG_DIR/conversation-log-import.out"
  IMPORT_ERR="$LOG_DIR/conversation-log-import.stderr"
  IMPORT_ARGS=(
    conversation-log import
    --source "$ALFRED_CONVERSATION_SOURCE"
    --provider "$ALFRED_CONVERSATION_PROVIDER"
    --source-name "$ALFRED_CONVERSATION_SOURCE_NAME"
  )
  if [ -n "${ALFRED_CONVERSATION_SOURCE_EXTENSIONS:-}" ]; then
    IMPORT_ARGS+=(--extensions "$ALFRED_CONVERSATION_SOURCE_EXTENSIONS")
  fi
  if [ -n "${ALFRED_CONVERSATION_EXCLUDE_DIRS:-}" ]; then
    IMPORT_ARGS+=(--exclude-dir "$ALFRED_CONVERSATION_EXCLUDE_DIRS")
  fi
  if [ -n "${ALFRED_CONVERSATION_EXTRACT:-}" ]; then
    IMPORT_ARGS+=(--extract "$ALFRED_CONVERSATION_EXTRACT")
  fi
  if [ -n "${ALFRED_CONVERSATION_EXTRACT_ONLY:-}" ] && [ "$ALFRED_CONVERSATION_EXTRACT_ONLY" != "0" ] && [ "$ALFRED_CONVERSATION_EXTRACT_ONLY" != "false" ]; then
    IMPORT_ARGS+=(--extract-only)
  fi
  set +e
  "$ALFRED_VAULT/.bin/wiki" "${IMPORT_ARGS[@]}" >"$IMPORT_OUT" 2>"$IMPORT_ERR"
  import_rc=$?
  set -e
  if [ "$import_rc" -ne 0 ]; then
    log_msg "conversation-log import failed exit=$import_rc; stderr: $IMPORT_ERR"
    exit "$import_rc"
  fi
fi

mkdir -p "$CONVERSATION_ROOT" 2>/dev/null || true
if [ -n "${ALFRED_CONVERSATION_EXTRACT:-}" ]; then
  RECENT_FILES="$(find "$CONVERSATION_ROOT" -path '*/deltas/*.jsonl' -type f -mtime "-$ALFRED_CONVERSATION_INGEST_DAYS" -print 2>/dev/null | sort | head -100 || true)"
else
  RECENT_FILES="$(find "$CONVERSATION_ROOT" -type f \( -name '*.md' -o -name '*.txt' -o -name '*.jsonl' -o -name '*.json' \) ! -name 'manifest.jsonl' ! -path '*/cursor/*' -mtime "-$ALFRED_CONVERSATION_INGEST_DAYS" -print 2>/dev/null | sort | head -100 || true)"
fi

if [ -z "$(printf '%s' "$RECENT_FILES" | tr -d '[:space:]')" ]; then
  log_msg "completed: no recent private conversation files"
  exit 0
fi

RECENT_REL="$(printf '%s\n' "$RECENT_FILES" | sed "s|^$ALFRED_VAULT/||")"
MANIFEST_TAIL="$(find "$CONVERSATION_ROOT" -type f -name 'manifest.jsonl' -mtime "-$ALFRED_CONVERSATION_INGEST_DAYS" -print 2>/dev/null | sort | xargs tail -n 20 2>/dev/null || true)"

PROMPT=$(cat <<PROMPT
Run the assistant's scheduled daily conversation fact ingestion.

Before doing anything else, read AGENTS.md and persona/conversation-ingest.md.

The purpose is to catch durable facts from today's conversation that the live runtime may have missed. This is a conservative ingestion pass, not a diary, not therapy, and not a psychological interpretation pass.

Allowed evidence:
- Only the private conversation files listed below.
- The existing vault, read through .bin/wiki commands.

Recent private conversation files, relative to the vault:
---
${RECENT_REL}
---

Recent mirror manifest tail:
---
${MANIFEST_TAIL:-"(none)"}
---

Hard rules:
- Durable writes MUST go through .bin/wiki ingest --stdin, .bin/wiki ingest --file, .bin/wiki patch, or .bin/wiki todo.
- NEVER edit wiki/*.md directly.
- NEVER write directly to raw/ or .alfred/private except through the sanctioned commands already described.
- Use source/provenance "telegram:${LOCAL_DATE}" for facts learned from the conversation unless a more specific Telegram provenance is available.
- Do not create broad daily summaries.
- Do not over-interpret emotion, friendships, family dynamics, motives, or mental state.
- Prefer concrete facts, events, preferences, todos/reminders, relationships, names, dates, places, activities, and explicit self-reports.
- If a useful candidate is ambiguous, sensitive, or interpretive, ask at most one concise clarification question instead of writing it.
- After each write, read the CLI audit output and fix strict issues through .bin/wiki before finishing.
- If there is nothing worth ingesting or asking, output nothing.
- If an operational problem prevents writing (for example tamper state, git
  ownership, missing permissions, or a CLI/runtime failure), do NOT message the
  user. Output a single operator-only note beginning with:
  OPERATOR_ONLY:
  The wrapper will log it for the maintainer instead of sending Telegram.

Output ONLY a Telegram message body for the user if you need clarification or want to mention a very small useful update. If no user-visible message is needed, output nothing.

Local date/time: ${LOCAL_DATE} ${LOCAL_TIME}
Lookback days: ${ALFRED_CONVERSATION_INGEST_DAYS}
PROMPT
)

AGENT_ERR="$LOG_DIR/agent.stderr"
alfred_prepare_agent_args wiki-write
set +e
MESSAGE="$("$ALFRED_AGENT_BIN" "${ALFRED_AGENT_ARGS[@]}" -p "$PROMPT" 2>"$AGENT_ERR")"
agent_rc=$?
set -e
if [ "$agent_rc" -ne 0 ]; then
  log_msg "agent failed exit=$agent_rc; stderr: $AGENT_ERR"
  exit "$agent_rc"
fi

SENT=0
OPERATOR_ONLY=0
OPERATOR_NOTE=""
MESSAGE_CLASSIFIER="$(MESSAGE="$MESSAGE" node -e 'process.stdout.write((process.env.MESSAGE || "").replace(/^\s+/, ""))')"
if printf '%s' "$MESSAGE_CLASSIFIER" | grep -q '^OPERATOR_ONLY:'; then
  OPERATOR_ONLY=1
  OPERATOR_NOTE="${MESSAGE_CLASSIFIER#OPERATOR_ONLY:}"
  OPERATOR_NOTE="${OPERATOR_NOTE#"${OPERATOR_NOTE%%[![:space:]]*}"}"
  printf '%s\n' "$MESSAGE_CLASSIFIER" >> "$LOG_DIR/operator-only.log" 2>/dev/null || true
elif [ -n "$(printf '%s' "$MESSAGE" | tr -d '[:space:]')" ]; then
  printf '%s\n' "$MESSAGE" | "$ALFRED_VAULT/.bin/telegram-send"
  SENT=1
fi

LEDGER="$LEDGER" LOCAL_DATE="$LOCAL_DATE" LOCAL_TIME="$LOCAL_TIME" MESSAGE="$MESSAGE" SENT="$SENT" OPERATOR_ONLY="$OPERATOR_ONLY" OPERATOR_NOTE="$OPERATOR_NOTE" FILE_COUNT="$(printf '%s\n' "$RECENT_FILES" | sed '/^$/d' | wc -l | tr -d ' ')" node <<'NODE'
const fs = require('fs');
const entry = {
  ran_at_utc: new Date().toISOString(),
  local_date: process.env.LOCAL_DATE,
  local_time: process.env.LOCAL_TIME,
  recent_file_count: Number(process.env.FILE_COUNT || 0),
  telegram_sent: process.env.SENT === '1',
  operator_only: process.env.OPERATOR_ONLY === '1',
  message: process.env.MESSAGE || '',
};
if (entry.operator_only) {
  entry.operator_note = process.env.OPERATOR_NOTE || '';
}
fs.appendFileSync(process.env.LEDGER, JSON.stringify(entry) + '\n');
NODE

log_msg "completed: agent ran; telegram_sent=$SENT"
