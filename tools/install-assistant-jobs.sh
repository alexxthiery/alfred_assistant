#!/usr/bin/env bash
# install-assistant-jobs.sh — generate + load the launchd jobs for ONE assistant.
#
# The host wrappers (run-daily-brief.sh, run-daily-checkin.sh,
# run-weekly-review.sh, run-reminder-dispatch.sh, vault-backup-push.sh,
# run-email-review.sh, run-conversation-ingest.sh) are
# already generic: each plist supplies ALFRED_VAULT, ENV_FILE, and
# ALFRED_ASSISTANT_LABEL in its EnvironmentVariables, which override the
# wrappers' defaults. So
# onboarding a new assistant is purely a matter of stamping per-assistant plists
# pointing at the shared wrappers — that's what this does. Reused for every
# family member (and for the primary assistant itself).
#
# Usage:
#   install-assistant-jobs.sh --vault <path> --env <env-file> --label <slug> \
#       [--brief HH:MM] [--morning-checkin HH:MM] [--afternoon-checkin HH:MM] [--evening-checkin HH:MM] \
#       [--email-review HH:MM] [--conversation-ingest HH:MM] [--weekly HH:MM] [--reminders] [--backup HH:MM] [--wrappers <dir>] \
#       [--dry-run] [--uninstall]
#
#   --vault       the assistant's vault (contains .bin/)
#   --env         env file under <vault>/.alfred/private/ that the wrappers parse
#                 (ALFRED_EXPECTED_VAULT /
#                 ALFRED_EXPECTED_LABEL / EMAIL_FROM / GMAIL_APP_PASSWORD /
#                 GMAIL_IMAP_APP_PASSWORD / TELEGRAM_BOT_TOKEN /
#                 TELEGRAM_CHAT_ID — set whichever apply)
#   --label       short slug; plists are com.<label>.{daily-brief,daily-checkin-morning,daily-checkin-afternoon,daily-checkin-evening,email-review,conversation-ingest,weekly-review,reminder-dispatch,vault-backup-push}
#   --brief HH:MM install the daily brief at this local time (default 07:00 if --brief bare)
#   --morning-checkin HH:MM install the agentic morning Telegram check-in (default 07:00 if bare)
#   --afternoon-checkin HH:MM install the agentic afternoon Telegram check-in (default 17:00 if bare)
#   --evening-checkin HH:MM install the agentic evening Telegram check-in (default 22:00 if bare)
#   --email-review HH:MM install the agentic Gmail review (default 10:00 if bare)
#   --conversation-ingest HH:MM install daily conservative fact ingestion from private conversation logs (default 21:30 if bare)
#   --weekly HH:MM install the weekly agentic review on Mondays (default 09:00 if bare)
#   --reminders   install the every-15-min reminder dispatcher
#   --backup HH:MM install the nightly git backup-push (default 22:00 if --backup bare)
#   --wrappers    dir holding run-*.sh (default ~/.local/bin)
#   --dry-run     print the plists; write/load nothing
#   --uninstall   unload + remove this label's plists, then exit
#
# At least one of --brief / --morning-checkin / --afternoon-checkin / --evening-checkin /
# --email-review / --conversation-ingest / --weekly / --reminders / --backup is required (unless --uninstall).
set -euo pipefail

VAULT="" ENVFILE="" LABEL="" WRAPPERS="$HOME/.local/bin"
BRIEF="" MORNING_CHECKIN="" AFTERNOON_CHECKIN="" EVENING_CHECKIN="" EMAIL_REVIEW="" CONVERSATION_INGEST="" WEEKLY="" REMINDERS=0 BACKUP="" DRYRUN=0 UNINSTALL=0
PATH_LINE=""
LA="$HOME/Library/LaunchAgents"

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)      VAULT="$2"; shift 2 ;;
    --env)        ENVFILE="$2"; shift 2 ;;
    --label)      LABEL="$2"; shift 2 ;;
    --brief)      if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then BRIEF="$2"; shift 2; else BRIEF="07:00"; shift; fi ;;
    --morning-checkin) if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then MORNING_CHECKIN="$2"; shift 2; else MORNING_CHECKIN="07:00"; shift; fi ;;
    --afternoon-checkin) if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then AFTERNOON_CHECKIN="$2"; shift 2; else AFTERNOON_CHECKIN="17:00"; shift; fi ;;
    --evening-checkin) if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then EVENING_CHECKIN="$2"; shift 2; else EVENING_CHECKIN="22:00"; shift; fi ;;
    --email-review) if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then EMAIL_REVIEW="$2"; shift 2; else EMAIL_REVIEW="10:00"; shift; fi ;;
    --conversation-ingest) if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then CONVERSATION_INGEST="$2"; shift 2; else CONVERSATION_INGEST="21:30"; shift; fi ;;
    --weekly)     if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then WEEKLY="$2"; shift 2; else WEEKLY="09:00"; shift; fi ;;
    --reminders)  REMINDERS=1; shift ;;
    --backup)     if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then BACKUP="$2"; shift 2; else BACKUP="22:00"; shift; fi ;;
    --wrappers)   WRAPPERS="$2"; shift 2 ;;
    --dry-run)    DRYRUN=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    sed -n '2,/^set /p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-assistant-jobs: unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -n "$LABEL" ] || { echo "install-assistant-jobs: --label is required" >&2; exit 1; }
if ! [[ "$LABEL" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "install-assistant-jobs: invalid --label: $LABEL (use lowercase letters, digits, and internal hyphens)" >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  for kind in daily-brief daily-checkin-morning daily-checkin-afternoon daily-checkin-evening email-review conversation-ingest weekly-review reminder-dispatch vault-backup-push; do
    p="$LA/com.$LABEL.$kind.plist"
    [ -f "$p" ] || continue
    launchctl unload "$p" 2>/dev/null || true
    rm -f "$p"; echo "removed $p"
  done
  exit 0
fi

[ -n "$VAULT" ]   || { echo "install-assistant-jobs: --vault is required" >&2; exit 1; }
[ -n "$ENVFILE" ] || { echo "install-assistant-jobs: --env is required" >&2; exit 1; }
[ -n "$BRIEF$MORNING_CHECKIN$AFTERNOON_CHECKIN$EVENING_CHECKIN$EMAIL_REVIEW$CONVERSATION_INGEST$WEEKLY$BACKUP" ] || [ "$REMINDERS" -eq 1 ] || { echo "install-assistant-jobs: pick at least one of --brief / --morning-checkin / --afternoon-checkin / --evening-checkin / --email-review / --conversation-ingest / --weekly / --reminders / --backup" >&2; exit 1; }
VAULT_ABS=$(cd "$VAULT" 2>/dev/null && pwd -P) || { echo "install-assistant-jobs: vault not found: $VAULT" >&2; exit 1; }
WRAPPERS_ABS=$(cd "$WRAPPERS" 2>/dev/null && pwd -P) || { echo "install-assistant-jobs: wrappers dir not found: $WRAPPERS" >&2; exit 1; }
[ -f "$WRAPPERS_ABS/assistant-binding.sh" ] || { echo "install-assistant-jobs: missing $WRAPPERS_ABS/assistant-binding.sh (copy it with the run-*.sh wrappers)" >&2; exit 1; }
[ -f "$ENVFILE" ] || { echo "install-assistant-jobs: env file not found: $ENVFILE" >&2; exit 1; }
[ ! -L "$ENVFILE" ] || { echo "install-assistant-jobs: env file must not be a symlink: $ENVFILE" >&2; exit 1; }
ENV_DIR_ABS=$(cd "$(dirname "$ENVFILE")" 2>/dev/null && pwd -P) || { echo "install-assistant-jobs: env dir not found: $ENVFILE" >&2; exit 1; }
ENVFILE_ABS="$ENV_DIR_ABS/$(basename "$ENVFILE")"
case "$ENVFILE_ABS" in
  "$VAULT_ABS/.alfred/private"/*) ;;
  *) echo "install-assistant-jobs: env file must live under $VAULT_ABS/.alfred/private; got $ENVFILE_ABS" >&2; exit 1 ;;
esac

. "$WRAPPERS_ABS/assistant-binding.sh"
ALFRED_VAULT="$VAULT_ABS"
ENV_FILE="$ENVFILE_ABS"
alfred_load_private_env "install-assistant-jobs"
[ -n "${ALFRED_EXPECTED_VAULT:-}" ] || { echo "install-assistant-jobs: env file must set ALFRED_EXPECTED_VAULT" >&2; exit 1; }
[ -n "${ALFRED_EXPECTED_LABEL:-}" ] || { echo "install-assistant-jobs: env file must set ALFRED_EXPECTED_LABEL" >&2; exit 1; }
EXPECTED_VAULT_ABS=$(cd "$ALFRED_EXPECTED_VAULT" 2>/dev/null && pwd -P) || { echo "install-assistant-jobs: ALFRED_EXPECTED_VAULT does not resolve: $ALFRED_EXPECTED_VAULT" >&2; exit 1; }
[ "$EXPECTED_VAULT_ABS" = "$VAULT_ABS" ] || { echo "install-assistant-jobs: env vault binding mismatch: expected $EXPECTED_VAULT_ABS, installing $VAULT_ABS" >&2; exit 1; }
[ "$ALFRED_EXPECTED_LABEL" = "$LABEL" ] || { echo "install-assistant-jobs: env label binding mismatch: expected $ALFRED_EXPECTED_LABEL, installing $LABEL" >&2; exit 1; }
[ -n "${TZ:-}" ] || { echo "install-assistant-jobs: env file must set TZ=Area/City" >&2; exit 1; }
case "$TZ" in
  */*) ;;
  *) echo "install-assistant-jobs: TZ must look like an IANA timezone (Area/City); got $TZ" >&2; exit 1 ;;
esac
PATH_LINE="$WRAPPERS_ABS:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  s="${s//\'/&apos;}"
  printf '%s' "$s"
}

# Emit one plist to stdout. $1=label-suffix $2=schedule-xml $3=program-args-xml
plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "com.$LABEL.$1")</string>
  <key>ProgramArguments</key>
  <array>
$3
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ALFRED_VAULT</key><string>$(xml_escape "$VAULT_ABS")</string>
    <key>ALFRED_ASSISTANT_LABEL</key><string>$(xml_escape "$LABEL")</string>
    <key>ENV_FILE</key><string>$(xml_escape "$ENVFILE_ABS")</string>
    <key>PATH</key><string>$(xml_escape "$PATH_LINE")</string>
  </dict>
$2
  <key>StandardOutPath</key><string>$(xml_escape "/tmp/com.$LABEL.$1.out")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "/tmp/com.$LABEL.$1.err")</string>
</dict>
</plist>
PLIST
}

prog() {
  local arg
  for arg in "$@"; do
    printf '    <string>%s</string>\n' "$(xml_escape "$arg")"
  done
}
calendar() { printf '  <key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>' "$1" "$2"; }
weekly_calendar() { printf '  <key>StartCalendarInterval</key>\n  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>' "$1" "$2"; }

install_one() {
  local kind="$1" sched="$2" args="$3" p="$LA/com.$LABEL.$1.plist"
  if [ "$DRYRUN" -eq 1 ]; then
    echo "=== $p ==="; plist "$kind" "$sched" "$args"; echo; return
  fi
  mkdir -p "$LA"
  plist "$kind" "$sched" "$args" > "$p"
  plutil -lint "$p" >/dev/null || { echo "install-assistant-jobs: bad plist $p" >&2; exit 1; }
  launchctl unload "$p" 2>/dev/null || true
  launchctl load "$p"
  echo "installed + loaded $p"
}

if [ -n "$BRIEF" ]; then
  install_one daily-brief "$(calendar "${BRIEF%%:*}" "${BRIEF##*:}")" "$(prog "$WRAPPERS_ABS/run-daily-brief.sh")"
fi
if [ -n "$MORNING_CHECKIN" ]; then
  install_one daily-checkin-morning "$(calendar "${MORNING_CHECKIN%%:*}" "${MORNING_CHECKIN##*:}")" "$(prog "$WRAPPERS_ABS/run-daily-checkin.sh" "--slot" "morning")"
fi
if [ -n "$AFTERNOON_CHECKIN" ]; then
  install_one daily-checkin-afternoon "$(calendar "${AFTERNOON_CHECKIN%%:*}" "${AFTERNOON_CHECKIN##*:}")" "$(prog "$WRAPPERS_ABS/run-daily-checkin.sh" "--slot" "afternoon")"
fi
if [ -n "$EVENING_CHECKIN" ]; then
  install_one daily-checkin-evening "$(calendar "${EVENING_CHECKIN%%:*}" "${EVENING_CHECKIN##*:}")" "$(prog "$WRAPPERS_ABS/run-daily-checkin.sh" "--slot" "evening")"
fi
if [ -n "$EMAIL_REVIEW" ]; then
  install_one email-review "$(calendar "${EMAIL_REVIEW%%:*}" "${EMAIL_REVIEW##*:}")" "$(prog "$WRAPPERS_ABS/run-email-review.sh")"
fi
if [ -n "$CONVERSATION_INGEST" ]; then
  install_one conversation-ingest "$(calendar "${CONVERSATION_INGEST%%:*}" "${CONVERSATION_INGEST##*:}")" "$(prog "$WRAPPERS_ABS/run-conversation-ingest.sh")"
fi
if [ -n "$WEEKLY" ]; then
  install_one weekly-review "$(weekly_calendar "${WEEKLY%%:*}" "${WEEKLY##*:}")" "$(prog "$WRAPPERS_ABS/run-weekly-review.sh")"
fi
if [ "$REMINDERS" -eq 1 ]; then
  install_one reminder-dispatch "  <key>StartInterval</key><integer>900</integer>" "$(prog "$WRAPPERS_ABS/run-reminder-dispatch.sh")"
fi
if [ -n "$BACKUP" ]; then
  # backup runs the repo script directly with the vault as its arg (no wrapper).
  install_one vault-backup-push "$(calendar "${BACKUP%%:*}" "${BACKUP##*:}")" "$(prog "$WRAPPERS_ABS/vault-backup-push.sh" "$VAULT_ABS")"
fi
