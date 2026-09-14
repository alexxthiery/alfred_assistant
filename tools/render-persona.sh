#!/usr/bin/env bash
# render-persona.sh — the single source of persona rendering.
#
# Assembles the fragment source in docs/persona/, strips the leading instruction
# comment, and substitutes the identity tokens. Identity comes from the
# vault's .alfred.yml via the existing config parser (bin/lib/config.js);
# template assembly/substitution comes from bin/lib/persona-template.js.
# deploy.sh delegates its render here; do not re-implement rendering elsewhere.
#
# AGENTS.md is now allowed to be generated, but adoption is explicit. If an
# existing AGENTS.md is hand-authored (no generated marker), --apply refuses to
# overwrite it unless --adopt-generated-persona is also passed. Optional
# vault-local overlays live in persona/agents.d/*.md and are appended in sorted
# order.
#
# Usage:
#   render-persona.sh --vault <path> --stdout
#   render-persona.sh --vault <path> --check
#   render-persona.sh --vault <path> --apply [--adopt-generated-persona]
#
# Exit: 0 ok, 1 stale check, 2 usage/config/render error, 3 unsafe overwrite.

set -euo pipefail

SELF=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SELF/.." && pwd)
CONFIG_JS="$REPO/bin/lib/config.js"
PERSONA_TEMPLATE_JS="$REPO/bin/lib/persona-template.js"

VAULT=""
APPLY=false
STDOUT=false
CHECK=false
ADOPT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)  VAULT="$2"; shift 2 ;;
    --apply)  APPLY=true; shift ;;
    --stdout) STDOUT=true; shift ;;
    --check)  CHECK=true; shift ;;
    --adopt-generated-persona) ADOPT=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "render-persona.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

MODES=0
$APPLY && MODES=$((MODES + 1))
$STDOUT && MODES=$((MODES + 1))
$CHECK && MODES=$((MODES + 1))
[ "$MODES" -le 1 ] || { echo "render-persona.sh: choose only one of --apply, --stdout, --check" >&2; exit 2; }

[ -n "$VAULT" ] || { echo "render-persona.sh: missing --vault" >&2; exit 2; }
[ -f "$VAULT/.alfred.yml" ] || { echo "render-persona.sh: no .alfred.yml in $VAULT" >&2; exit 2; }
[ -f "$CONFIG_JS" ] || { echo "render-persona.sh: config parser missing: $CONFIG_JS" >&2; exit 2; }
[ -f "$PERSONA_TEMPLATE_JS" ] || { echo "render-persona.sh: persona template module missing: $PERSONA_TEMPLATE_JS" >&2; exit 2; }
[ -d "$REPO/docs/persona" ] || { echo "render-persona.sh: persona fragments missing: $REPO/docs/persona" >&2; exit 2; }

render() {
  node -e '
    const { loadConfig } = require(process.argv[1]);
    const {
      loadPersonaTemplate,
      loadLocalPersonaFragments,
      renderPersonaDocument,
    } = require(process.argv[2]);
    const vault = process.argv[3];
    const repo = process.argv[4];
    const c = loadConfig(vault);
    const tz = (c.weekly_review && c.weekly_review.timezone) || "";
    const city = tz.includes("/") ? tz.split("/").pop().replace(/_/g, " ") : (tz || "Singapore");
    const user = c.user || {};
    const email = c.email || {};
    process.stdout.write(renderPersonaDocument({
      template: loadPersonaTemplate(repo),
      localFragments: loadLocalPersonaFragments(vault),
      replacements: {
        USER_NAME: user.name || "",
        USER_SLUG: user.slug || "",
        USER_EMAIL: email.from || "",
        USER_TZ_CITY: city,
        ASSISTANT_NAME: (c.assistant && c.assistant.name) || "Alfred",
      },
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

DST="$VAULT/AGENTS.md"
RENDERED="$VAULT/AGENTS.rendered.md"

if $CHECK; then
  if [ -f "$DST" ] && diff -q "$DST" "$TMP" >/dev/null 2>&1; then
    echo "[persona] AGENTS.md is up to date ($LINES lines)"
    rm -f "$TMP"
    exit 0
  fi
  echo "[persona] AGENTS.md is stale or missing"
  echo "  Regenerate: tools/render-persona.sh --vault $VAULT --apply"
  rm -f "$TMP"
  exit 1
fi

if [ -f "$DST" ] && diff -q "$DST" "$TMP" >/dev/null 2>&1; then
  echo "[persona] AGENTS.md unchanged"
elif [ -f "$DST" ]; then
  echo "[persona] WOULD UPDATE $DST ($LINES generated lines)"
else
  echo "[persona] WOULD CREATE $DST ($LINES generated lines)"
fi

if $APPLY; then
  if [ -f "$DST" ] && ! grep -q 'GENERATED FILE' "$DST"; then
    if ! $ADOPT; then
      cp "$TMP" "$RENDERED"
      echo "[persona] REFUSING to overwrite hand-authored $DST" >&2
      echo "  Wrote comparison render to $RENDERED" >&2
      echo "  Re-run with --adopt-generated-persona after reviewing the diff." >&2
      rm -f "$TMP"
      exit 3
    fi
  fi
  cp "$TMP" "$DST"
  rm -f "$RENDERED"
  echo "[persona] wrote generated $DST"
fi
rm -f "$TMP"
