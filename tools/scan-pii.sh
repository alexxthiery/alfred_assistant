#!/usr/bin/env bash
# scan-pii.sh — flag candidate files for PII before publication.
#
# Reads patterns (TAB-separated <CATEGORY>\t<pattern>) from
# tools/pii-list.local.txt — a gitignored file.
#
# For each file argument, reports: <file>:<line> [<category>] HIT
# Never prints the matched string itself — output is safe to share.
#
# Usage:
#   tools/scan-pii.sh path/to/file [path/to/file ...]
#
# Exit code: 0 if clean, 1 if any HIT, 2 on usage error.

# NOTE: deliberately NOT using `set -e` — grep returns 1 on no-match, which
# would abort the script. We track hits explicitly via $HITS instead.
set -uo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PII_FILE="$SELF_DIR/pii-list.local.txt"

if [ ! -f "$PII_FILE" ]; then
  echo "scan-pii: missing $PII_FILE — populate it with TAB-separated <CATEGORY>\\t<pattern> per line." >&2
  exit 2
fi
if [ $# -eq 0 ]; then
  echo "scan-pii: no files given" >&2
  echo "usage: $0 <file> [file ...]" >&2
  exit 2
fi

# Load patterns into parallel arrays.
declare -a PATTERNS CATEGORIES
while IFS= read -r line; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  case "$line" in
    *$'\t'*) ;;
    *) continue ;;  # no tab separator
  esac
  cat="${line%%$'\t'*}"
  pat="${line#*$'\t'}"
  [ -z "$cat" ] && continue
  [ -z "$pat" ] && continue
  PATTERNS+=("$pat")
  CATEGORIES+=("$cat")
done < "$PII_FILE"

if [ "${#PATTERNS[@]}" -eq 0 ]; then
  echo "scan-pii: $PII_FILE has no patterns" >&2
  exit 2
fi

HITS=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "scan-pii: skip (not a regular file): $f" >&2
    continue
  fi
  i=0
  while [ "$i" -lt "${#PATTERNS[@]}" ]; do
    cat="${CATEGORIES[$i]}"
    pat="${PATTERNS[$i]}"
    case "$cat" in
      NAME|ORG|SLUG) wflag="-w" ;;
      *)             wflag=""   ;;
    esac
    # First test (cheap) — does this pattern hit at all?
    if grep -F -i -q $wflag -- "$pat" "$f" 2>/dev/null; then
      HITS=1
      # Then print one line per match. grep returns 0 here since we know it hits.
      grep -F -i -n $wflag -- "$pat" "$f" 2>/dev/null | \
        awk -F: -v file="$f" -v cat="$cat" '{print file ":" $1 " [" cat "] HIT"}'
    fi
    i=$((i + 1))
  done
done

exit "$HITS"
