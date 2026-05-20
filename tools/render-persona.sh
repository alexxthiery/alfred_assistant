#!/usr/bin/env bash
# render-persona.sh — the single source of persona rendering.
#
# Strips the template's leading instruction comment and substitutes the
# {{USER_*}} tokens, pulling identity from the vault's .alfred.yml via the
# existing config parser (bin/lib/config.js) so there is exactly one place
# that knows the substitution and one source of identity. deploy.sh delegates
# its render here; do not re-implement the awk/sed elsewhere.
#
# IMPORTANT: this renders the GENERIC template, not the user's personalized
# persona. It writes a COMPARISON file (AGENTS.local.md) — never the canonical
# AGENTS.md — so a re-render can't clobber hand-personalization. The canonical
# AGENTS.md is owned by the user/agent; deploy.sh diffs AGENTS.local.md against
# it to surface new template content for manual merge (same model as the old
# _persona.local.md vs _persona.md).
#
# Usage:
#   render-persona.sh --vault <path> [--apply]   # write <vault>/AGENTS.local.md (dry-run unless --apply)
#   render-persona.sh --vault <path> --stdout     # print the rendered template, write nothing (used by deploy.sh)
#
# Exit: 0 ok, 2 usage/config error.

set -euo pipefail

SELF=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SELF/.." && pwd)
TEMPLATE="$REPO/docs/PERSONA.template.md"
CONFIG_JS="$REPO/bin/lib/config.js"

VAULT=""
APPLY=false
STDOUT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)  VAULT="$2"; shift 2 ;;
    --apply)  APPLY=true; shift ;;
    --stdout) STDOUT=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "render-persona.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$VAULT" ] || { echo "render-persona.sh: missing --vault" >&2; exit 2; }
[ -f "$VAULT/.alfred.yml" ] || { echo "render-persona.sh: no .alfred.yml in $VAULT" >&2; exit 2; }
[ -f "$TEMPLATE" ] || { echo "render-persona.sh: template missing: $TEMPLATE" >&2; exit 2; }

# Identity from .alfred.yml via the canonical parser (no bash YAML parsing).
VARS=$(node -e '
  const { loadConfig } = require(process.argv[1]);
  const c = loadConfig(process.argv[2]);
  const tz = (c.weekly_review && c.weekly_review.timezone) || "";
  const city = tz.includes("/") ? tz.split("/").pop().replace(/_/g, " ") : (tz || "Singapore");
  process.stdout.write([
    "USER_NAME\t"  + (c.user.name  || ""),
    "USER_SLUG\t"  + (c.user.slug  || ""),
    "USER_EMAIL\t" + (c.email.from || ""),
    "USER_TZ_CITY\t" + city,
  ].join("\n"));
' "$CONFIG_JS" "$VAULT") || { echo "render-persona.sh: config load failed" >&2; exit 2; }

USER_NAME=""; USER_SLUG=""; USER_EMAIL=""; USER_TZ_CITY="Singapore"
while IFS=$'\t' read -r k v; do
  case "$k" in
    USER_NAME)    USER_NAME="$v" ;;
    USER_SLUG)    USER_SLUG="$v" ;;
    USER_EMAIL)   USER_EMAIL="$v" ;;
    USER_TZ_CITY) USER_TZ_CITY="$v" ;;
  esac
done <<< "$VARS"

render() {
  # Strip the leading <!-- ... --> instruction block (human-only template
  # metadata), then substitute the four tokens.
  awk 'BEGIN{skip=0} /^<!--$/{if(NR==1){skip=1;next}} skip && /^-->$/{skip=0;next} !skip{print}' \
    "$TEMPLATE" \
  | sed -e "s|{{USER_NAME}}|$USER_NAME|g" \
        -e "s|{{USER_SLUG}}|$USER_SLUG|g" \
        -e "s|{{USER_EMAIL}}|$USER_EMAIL|g" \
        -e "s|{{USER_TZ_CITY}}|$USER_TZ_CITY|g"
}

if $STDOUT; then
  render
  exit 0
fi

TMP=$(mktemp)
render > "$TMP"
LINES=$(wc -l < "$TMP" | tr -d ' ')

DST="$VAULT/AGENTS.local.md"
if [ -f "$DST" ] && diff -q "$DST" "$TMP" >/dev/null 2>&1; then
  echo "[persona] AGENTS.local.md unchanged"
elif [ -f "$DST" ]; then
  echo "[persona] WOULD UPDATE $DST (latest template render, for merge comparison)"
else
  echo "[persona] WOULD CREATE $DST ($LINES lines, latest template render)"
fi

if $APPLY; then
  cp "$TMP" "$DST"
  echo "[persona] wrote $DST"
fi
rm -f "$TMP"
