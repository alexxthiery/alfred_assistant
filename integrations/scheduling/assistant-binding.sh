#!/usr/bin/env bash
# assistant-binding.sh — shared fail-closed checks for scheduled wrappers.
#
# Source before ENV_FILE is loaded. The env file must live under the active
# vault's .alfred/private/ directory and must declare:
#   ALFRED_EXPECTED_VAULT=/absolute/path/to/the/one/vault
#   ALFRED_EXPECTED_LABEL=<assistant-label>
# The plist/cron environment must declare:
#   ALFRED_VAULT=/absolute/path/to/the/active/vault
#   ALFRED_ASSISTANT_LABEL=<assistant-label>

alfred_realpath_dir() {
  cd "$1" 2>/dev/null && pwd -P
}

alfred_require_private_env_path() {
  local caller="$1"
  local active env_dir env_real private_root

  [ -n "${ALFRED_VAULT:-}" ] || { echo "$caller: ALFRED_VAULT is not set" >&2; exit 2; }
  [ -n "${ENV_FILE:-}" ] || { echo "$caller: ENV_FILE is not set" >&2; exit 2; }
  [ -f "$ENV_FILE" ] || { echo "$caller: ENV_FILE does not exist: $ENV_FILE" >&2; exit 2; }
  [ ! -L "$ENV_FILE" ] || { echo "$caller: ENV_FILE must not be a symlink: $ENV_FILE" >&2; exit 2; }

  active="$(alfred_realpath_dir "$ALFRED_VAULT")" || { echo "$caller: ALFRED_VAULT does not resolve: $ALFRED_VAULT" >&2; exit 2; }
  env_dir="$(alfred_realpath_dir "$(dirname "$ENV_FILE")")" || { echo "$caller: ENV_FILE directory does not resolve: $ENV_FILE" >&2; exit 2; }
  env_real="$env_dir/$(basename "$ENV_FILE")"
  private_root="$active/.alfred/private"

  case "$env_real" in
    "$private_root"/*) ;;
    *)
      echo "$caller: ENV_FILE must live under $private_root; got $env_real" >&2
      exit 2
      ;;
  esac
}

alfred_env_key_allowed() {
  case "$1" in
    ALFRED_EXPECTED_VAULT|ALFRED_EXPECTED_LABEL|ALFRED_AGENT_BIN|\
ALFRED_EMAIL_REVIEW_DAYS|ALFRED_EMAIL_REVIEW_MAX_QUESTIONS|\
ALFRED_CONVERSATION_SOURCE|ALFRED_CONVERSATION_PROVIDER|\
ALFRED_CONVERSATION_SOURCE_NAME|ALFRED_CONVERSATION_SOURCE_EXTENSIONS|\
ALFRED_CONVERSATION_EXCLUDE_DIRS|ALFRED_CONVERSATION_EXTRACT|\
ALFRED_CONVERSATION_EXTRACT_ONLY|ALFRED_CONVERSATION_INGEST_DAYS|\
DAILY_BRIEF_RETRY_AFTER_SECONDS|DAILY_BRIEF_RETRY_ON_FAILURE|\
EMAIL_FROM|GMAIL_APP_PASSWORD|GMAIL_IMAP_APP_PASSWORD|\
ONECLI_URL|\
TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|TZ)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

alfred_load_private_env() {
  local caller="$1"
  local line key value line_no

  [ -n "${ENV_FILE:-}" ] || { echo "$caller: ENV_FILE is not set" >&2; exit 2; }
  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    line="${line%$'\r'}"
    case "$line" in
      ""|\#*) continue ;;
    esac
    case "$line" in
      export\ *)
        echo "$caller: ENV_FILE line $line_no must be KEY=VALUE, not shell syntax" >&2
        exit 2
        ;;
      *=*) ;;
      *)
        echo "$caller: ENV_FILE line $line_no must be KEY=VALUE" >&2
        exit 2
        ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    if ! [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "$caller: invalid ENV_FILE key on line $line_no: $key" >&2
      exit 2
    fi
    if ! alfred_env_key_allowed "$key"; then
      echo "$caller: unsupported ENV_FILE key on line $line_no: $key" >&2
      exit 2
    fi
    if [[ "$value" == *'$('* || "$value" == *'`'* ]]; then
      echo "$caller: unsafe shell syntax in ENV_FILE line $line_no for $key" >&2
      exit 2
    fi
    export "$key=$value"
  done < "$ENV_FILE"
}

alfred_require_assistant_binding() {
  local caller="$1"
  local active expected

  [ -n "${ALFRED_VAULT:-}" ] || { echo "$caller: ALFRED_VAULT is not set" >&2; exit 2; }
  [ -n "${ALFRED_ASSISTANT_LABEL:-}" ] || { echo "$caller: ALFRED_ASSISTANT_LABEL is not set" >&2; exit 2; }
  [ -n "${ALFRED_EXPECTED_VAULT:-}" ] || { echo "$caller: ALFRED_EXPECTED_VAULT is not set in ENV_FILE" >&2; exit 2; }
  [ -n "${ALFRED_EXPECTED_LABEL:-}" ] || { echo "$caller: ALFRED_EXPECTED_LABEL is not set in ENV_FILE" >&2; exit 2; }

  active="$(alfred_realpath_dir "$ALFRED_VAULT")" || { echo "$caller: ALFRED_VAULT does not resolve: $ALFRED_VAULT" >&2; exit 2; }
  expected="$(alfred_realpath_dir "$ALFRED_EXPECTED_VAULT")" || { echo "$caller: ALFRED_EXPECTED_VAULT does not resolve: $ALFRED_EXPECTED_VAULT" >&2; exit 2; }

  if [ "$active" != "$expected" ]; then
    echo "$caller: vault binding mismatch: active=$active expected=$expected" >&2
    exit 2
  fi
  if [ "$ALFRED_ASSISTANT_LABEL" != "$ALFRED_EXPECTED_LABEL" ]; then
    echo "$caller: assistant label mismatch: active=$ALFRED_ASSISTANT_LABEL expected=$ALFRED_EXPECTED_LABEL" >&2
    exit 2
  fi

  # Bound scheduled jobs run in deployed mode by default. Any wiki writes made
  # by deterministic wrappers or child agents then fail closed on missing git,
  # disabled auto-commit, or git-status failures. Local repair sessions can
  # still opt out explicitly by launching the wrapper with ALFRED_STRICT_DEPLOYED=0.
  export ALFRED_STRICT_DEPLOYED="${ALFRED_STRICT_DEPLOYED:-1}"
}

alfred_prepare_agent_args() {
  local capability="$1"
  shift || true

  ALFRED_AGENT_ARGS=()
  case "$(basename "${ALFRED_AGENT_BIN:-}")" in
    claude) ;;
    *) return 0 ;;
  esac

  case "$capability" in
    wiki-write)
      # Headless Claude Code cannot answer interactive permission prompts.
      # Grant only the wiki CLI path; vault writes still flow through the
      # CLI's schema, audit, autolink, auto-commit, and binding checks.
      ALFRED_AGENT_ARGS=(
        --allowedTools
        "Bash(.bin/wiki *)"
        "Bash(./.bin/wiki *)"
        "Bash($ALFRED_VAULT/.bin/wiki *)"
      )
      ;;
    wiki-read)
      ALFRED_AGENT_ARGS=(--allowedTools)
      local verb
      for verb in "$@"; do
        ALFRED_AGENT_ARGS+=(
          "Bash(.bin/wiki ${verb}*)"
          "Bash(./.bin/wiki ${verb}*)"
          "Bash($ALFRED_VAULT/.bin/wiki ${verb}*)"
        )
      done
      ;;
    none)
      ;;
    *)
      echo "alfred_prepare_agent_args: unknown capability: $capability" >&2
      exit 2
      ;;
  esac
}
