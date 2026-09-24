#!/usr/bin/env bash
# scan-pii.sh — flag candidate files for PII before publication.
#
# Thin wrapper kept for existing callers; the scanner lives in scan-pii.js
# (list patterns from tools/pii-list.local.txt + generic secret shapes).
# Never prints the matched string itself — output is safe to share.
#
# Usage:
#   tools/scan-pii.sh path/to/file [path/to/file ...]
#   tools/scan-pii.sh --staged | --range <rev-list args>
#
# Exit code: 0 if clean, 1 if any HIT, 2 on usage error.

set -uo pipefail
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
exec node "$SELF_DIR/scan-pii.js" "$@"
