#!/usr/bin/env bash
# render-persona.sh — the single source of persona rendering.
#
# Assembles the fragment source in docs/persona/, strips the leading instruction
# comment, and substitutes the {{USER_*}} tokens. Identity comes from the
# vault's .alfred.yml via the existing config parser (bin/lib/config.js);
# template assembly/substitution comes from bin/lib/persona-template.js.
# deploy.sh delegates its render here; do not re-implement rendering elsewhere.
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
CONFIG_JS="$REPO/bin/lib/config.js"
PERSONA_TEMPLATE_JS="$REPO/bin/lib/persona-template.js"

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
[ -f "$CONFIG_JS" ] || { echo "render-persona.sh: config parser missing: $CONFIG_JS" >&2; exit 2; }
[ -f "$PERSONA_TEMPLATE_JS" ] || { echo "render-persona.sh: persona template module missing: $PERSONA_TEMPLATE_JS" >&2; exit 2; }
[ -d "$REPO/docs/persona" ] || { echo "render-persona.sh: persona fragments missing: $REPO/docs/persona" >&2; exit 2; }

render() {
  node -e '
    const { loadConfig } = require(process.argv[1]);
    const { loadPersonaTemplate, renderPersonaTemplate } = require(process.argv[2]);
    const vault = process.argv[3];
    const repo = process.argv[4];
    const c = loadConfig(vault);
    const tz = (c.weekly_review && c.weekly_review.timezone) || "";
    const city = tz.includes("/") ? tz.split("/").pop().replace(/_/g, " ") : (tz || "Singapore");
    const user = c.user || {};
    const email = c.email || {};
    process.stdout.write(renderPersonaTemplate(loadPersonaTemplate(repo), {
      USER_NAME: user.name || "",
      USER_SLUG: user.slug || "",
      USER_EMAIL: email.from || "",
      USER_TZ_CITY: city,
    }));
  ' "$CONFIG_JS" "$PERSONA_TEMPLATE_JS" "$VAULT" "$REPO"
}

if $STDOUT; then
  render || { echo "render-persona.sh: render failed" >&2; exit 2; }
  exit 0
fi

TMP=$(mktemp)
render > "$TMP" || { rm -f "$TMP"; echo "render-persona.sh: render failed" >&2; exit 2; }
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
