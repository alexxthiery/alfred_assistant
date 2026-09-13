#!/usr/bin/env bash
# assistant-binding.sh — shared fail-closed checks for scheduled wrappers.
#
# Source before ENV_FILE is sourced. The env file must live under the active
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
}
