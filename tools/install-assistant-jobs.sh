#!/usr/bin/env bash
# install-assistant-jobs.sh — generate + load the launchd jobs for ONE assistant.
#
# The host wrappers (run-daily-brief.sh, run-weekly-review.sh,
# run-reminder-dispatch.sh, vault-backup-push.sh, run-email-review.sh) are
# already generic: each plist supplies ALFRED_VAULT, ENV_FILE, and
# ALFRED_ASSISTANT_LABEL in its EnvironmentVariables, which override the
# wrappers' defaults. So
# onboarding a new assistant is purely a matter of stamping per-assistant plists
# pointing at the shared wrappers — that's what this does. Reused for every
# family member (and for the primary assistant itself).
#
# Usage:
#   install-assistant-jobs.sh --vault <path> --env <env-file> --label <slug> \
#       [--brief HH:MM] [--email-review HH:MM] [--weekly HH:MM] [--reminders] [--backup HH:MM] [--wrappers <dir>] \
#       [--dry-run] [--uninstall]
#
#   --vault       the assistant's vault (contains .bin/)
#   --env         env file under <vault>/.alfred/private/ that the wrappers source
#                 (ALFRED_EXPECTED_VAULT /
#                 ALFRED_EXPECTED_LABEL / EMAIL_FROM / GMAIL_APP_PASSWORD /
#                 GMAIL_IMAP_APP_PASSWORD / TELEGRAM_BOT_TOKEN /
#                 TELEGRAM_CHAT_ID — set whichever apply)
#   --label       short slug; plists are com.<label>.{daily-brief,email-review,weekly-review,reminder-dispatch,vault-backup-push}
#   --brief HH:MM install the daily brief at this local time (default 07:00 if --brief bare)
#   --email-review HH:MM install the agentic Gmail review (default 10:00 if bare)
#   --weekly HH:MM install the weekly agentic review on Mondays (default 09:00 if bare)
#   --reminders   install the every-15-min reminder dispatcher
#   --backup HH:MM install the nightly git backup-push (default 22:00 if --backup bare)
#   --wrappers    dir holding run-*.sh (default ~/.local/bin)
#   --dry-run     print the plists; write/load nothing
#   --uninstall   unload + remove this label's plists, then exit
#
# At least one of --brief / --email-review / --weekly / --reminders / --backup is required (unless --uninstall).
set -euo pipefail

VAULT="" ENVFILE="" LABEL="" WRAPPERS="$HOME/.local/bin"
BRIEF="" EMAIL_REVIEW="" WEEKLY="" REMINDERS=0 BACKUP="" DRYRUN=0 UNINSTALL=0
PATH_LINE=""
LA="$HOME/Library/LaunchAgents"

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)      VAULT="$2"; shift 2 ;;
    --env)        ENVFILE="$2"; shift 2 ;;
    --label)      LABEL="$2"; shift 2 ;;
    --brief)      if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then BRIEF="$2"; shift 2; else BRIEF="07:00"; shift; fi ;;
    --email-review) if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then EMAIL_REVIEW="$2"; shift 2; else EMAIL_REVIEW="10:00"; shift; fi ;;
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

if [ "$UNINSTALL" -eq 1 ]; then
  for kind in daily-brief email-review weekly-review reminder-dispatch vault-backup-push; do
    p="$LA/com.$LABEL.$kind.plist"
    [ -f "$p" ] || continue
    launchctl unload "$p" 2>/dev/null || true
    rm -f "$p"; echo "removed $p"
  done
  exit 0
fi

[ -n "$VAULT" ]   || { echo "install-assistant-jobs: --vault is required" >&2; exit 1; }
[ -n "$ENVFILE" ] || { echo "install-assistant-jobs: --env is required" >&2; exit 1; }
[ -n "$BRIEF$EMAIL_REVIEW$WEEKLY$BACKUP" ] || [ "$REMINDERS" -eq 1 ] || { echo "install-assistant-jobs: pick at least one of --brief / --email-review / --weekly / --reminders / --backup" >&2; exit 1; }
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
PATH_LINE="$WRAPPERS_ABS:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Emit one plist to stdout. $1=label-suffix $2=schedule-xml $3=program-args-xml
plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.$LABEL.$1</string>
  <key>ProgramArguments</key>
  <array>
$3
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ALFRED_VAULT</key><string>$VAULT_ABS</string>
    <key>ALFRED_ASSISTANT_LABEL</key><string>$LABEL</string>
    <key>ENV_FILE</key><string>$ENVFILE_ABS</string>
    <key>PATH</key><string>$PATH_LINE</string>
  </dict>
$2
  <key>StandardOutPath</key><string>/tmp/com.$LABEL.$1.out</string>
  <key>StandardErrorPath</key><string>/tmp/com.$LABEL.$1.err</string>
</dict>
</plist>
PLIST
}

prog() { printf '    <string>%s</string>\n' "$@"; }
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
if [ -n "$EMAIL_REVIEW" ]; then
  install_one email-review "$(calendar "${EMAIL_REVIEW%%:*}" "${EMAIL_REVIEW##*:}")" "$(prog "$WRAPPERS_ABS/run-email-review.sh")"
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
