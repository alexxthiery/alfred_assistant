#!/usr/bin/env bash
# run-weekly-review.sh — the weekly digest, runtime-independent.
#
# Unlike the daily brief, the weekly review needs *synthesis* (an agent reads
# `wiki review` / `wiki audit` and writes a readable summary). We invoke a
# HEADLESS agent for that — `claude -p` from the vault, so it loads the Alfred
# persona (AGENTS.md) and runs the "Weekly routine" steps — then pipe the
# result to email-digest. This is runtime-independent: it does not require
# nanoclaw or its schedule_task table. Swap `claude -p` for `codex exec` if you
# prefer Codex.
#
# Config:
#   ALFRED_VAULT      vault path (contains AGENTS.md and .bin/)
#   ALFRED_ASSISTANT_LABEL  assistant label stamped by the scheduler installer
#   ENV_FILE          vault-private KEY=VALUE file exporting EMAIL_FROM + GMAIL_APP_PASSWORD +
#                     ALFRED_EXPECTED_VAULT + ALFRED_EXPECTED_LABEL
#   ALFRED_AGENT_BIN  agent binary; default: claude
set -euo pipefail

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "run-weekly-review: unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALFRED_VAULT="${ALFRED_VAULT:-$HOME/my-vault}"
ENV_FILE="${ENV_FILE:-$ALFRED_VAULT/.alfred/private/env}"
ALFRED_AGENT_BIN="${ALFRED_AGENT_BIN:-claude}"
. "$SCRIPT_DIR/assistant-binding.sh"
alfred_require_private_env_path "run-weekly-review"
alfred_load_private_env "run-weekly-review"
alfred_require_assistant_binding "run-weekly-review"

PROMPT='Run the weekly vault review exactly as your persona'\''s Weekly routine specifies. Output ONLY the final email body (<=40 lines, the three sections). No preamble.'

[ -d "$ALFRED_VAULT" ] || { echo "run-weekly-review: vault not found: $ALFRED_VAULT" >&2; exit 2; }
[ -x "$ALFRED_VAULT/.bin/email-digest" ] || { echo "run-weekly-review: missing executable: $ALFRED_VAULT/.bin/email-digest" >&2; exit 2; }
[ -f "$ALFRED_VAULT/AGENTS.md" ] || { echo "run-weekly-review: missing persona: $ALFRED_VAULT/AGENTS.md" >&2; exit 2; }
command -v "$ALFRED_AGENT_BIN" >/dev/null 2>&1 || { echo "run-weekly-review: agent binary not found: $ALFRED_AGENT_BIN" >&2; exit 2; }

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$PROMPT"
  exit 0
fi

: "${EMAIL_FROM:?run-weekly-review: EMAIL_FROM not set (check ENV_FILE)}"

cd "$ALFRED_VAULT"
"$ALFRED_AGENT_BIN" -p "$PROMPT" \
  | "$ALFRED_VAULT/.bin/email-digest" \
      --subject "Vault weekly digest, $(date +%F)" \
      --to "$EMAIL_FROM"
