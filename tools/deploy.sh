#!/usr/bin/env bash
# tools/deploy.sh — render PERSONA.template.md and refresh bin/ symlinks in
# a target vault. Default mode is dry-run; pass --apply to actually write.
#
# What it does (in order):
#   1. Seed .alfred.yml from examples/.alfred.yml.example if missing.
#   2. Render docs/PERSONA.template.md → <target>/alfred/_persona.md by
#      substituting the four template placeholders.
#   3. Refresh <target>/.bin/ via install.sh (handles copy → symlink upgrade
#      when the current .bin/ entries are stale copies, e.g. from a previous
#      manual deploy that bypassed install.sh).
#
# Usage:
#   tools/deploy.sh --target /path/to/vault \
#                   --user-name "Your Name" --user-slug your-slug \
#                   --user-email you@example.com --user-tz-city "Your City" \
#                   [--apply]
#
# Idempotent. Re-running with the same config is a no-op.

set -euo pipefail

APPLY=false
TARGET=""
USER_NAME=""; USER_SLUG=""; USER_EMAIL=""; USER_TZ_CITY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)        APPLY=true; shift ;;
    --target)       TARGET="$2"; shift 2 ;;
    --user-name)    USER_NAME="$2"; shift 2 ;;
    --user-slug)    USER_SLUG="$2"; shift 2 ;;
    --user-email)   USER_EMAIL="$2"; shift 2 ;;
    --user-tz-city) USER_TZ_CITY="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "deploy.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TARGET" ]    || { echo "deploy.sh: missing --target"    >&2; exit 2; }
[ -n "$USER_NAME" ] || { echo "deploy.sh: missing --user-name" >&2; exit 2; }
[ -n "$USER_SLUG" ] || { echo "deploy.sh: missing --user-slug" >&2; exit 2; }
[ -n "$USER_EMAIL" ]   || USER_EMAIL=""
[ -n "$USER_TZ_CITY" ] || USER_TZ_CITY="Singapore"

SELF=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$SELF/.." && pwd)
TARGET=$(cd "$TARGET" && pwd)

echo "=== deploy.sh ==="
echo "  source:   $SRC"
echo "  target:   $TARGET"
echo "  apply:    $APPLY"
echo "  user:     $USER_NAME ($USER_SLUG)"
echo "  tz_city:  $USER_TZ_CITY"
echo ""

# 1. .alfred.yml
if [ ! -f "$TARGET/.alfred.yml" ]; then
  echo "[config] WOULD CREATE $TARGET/.alfred.yml"
  echo "  user.slug: $USER_SLUG"
  echo "  user.name: $USER_NAME"
  echo "  email.from: $USER_EMAIL"
  if $APPLY; then
    sed -e "s|^  slug: user|  slug: $USER_SLUG|" \
        -e "s|^  name: Anonymous|  name: $USER_NAME|" \
        -e "s|^  from: \"\"|  from: \"$USER_EMAIL\"|" \
        "$SRC/examples/.alfred.yml.example" > "$TARGET/.alfred.yml"
    echo "[config] wrote $TARGET/.alfred.yml — review/edit before next deploy"
  fi
else
  echo "[config] OK (.alfred.yml present)"
fi
echo ""

# 2. Render persona to _persona.local.md (per template's own instruction).
# We do NOT overwrite _persona.md — that file may be hand-personalized (e.g.
# the worked-example cast Alice/Maya/Ada substituted for the user's actual
# relations). Rendering to a side-by-side file lets the user manually merge
# new template content (e.g. new persona sections) without losing edits.
TMP=$(mktemp)

# Strip the leading <!-- ... --> instructions block (template metadata for
# humans, not for Alfred). It's the first HTML comment in the file.
awk 'BEGIN{skip=0} /^<!--$/{if(NR==1){skip=1;next}} skip && /^-->$/{skip=0;next} !skip{print}' \
  "$SRC/docs/PERSONA.template.md" \
  | sed -e "s|{{USER_NAME}}|$USER_NAME|g" \
        -e "s|{{USER_SLUG}}|$USER_SLUG|g" \
        -e "s|{{USER_EMAIL}}|$USER_EMAIL|g" \
        -e "s|{{USER_TZ_CITY}}|$USER_TZ_CITY|g" \
  > "$TMP"

RENDERED="$TARGET/alfred/_persona.local.md"
if [ -f "$RENDERED" ]; then
  if diff -q "$RENDERED" "$TMP" > /dev/null 2>&1; then
    echo "[persona] _persona.local.md unchanged"
  else
    echo "[persona] WOULD UPDATE $RENDERED"
  fi
else
  echo "[persona] WOULD CREATE $RENDERED ($(wc -l < "$TMP" | tr -d ' ') lines)"
fi

if $APPLY; then
  mkdir -p "$TARGET/alfred"
  cp "$TMP" "$RENDERED"
  echo "[persona] wrote $RENDERED"
fi

# Side-by-side comparison vs the live _persona.md, since the user's runtime
# may be reading that file (not the .local.md the template prescribes). The
# diff shows what new content (e.g. Phase 8/9/10 sections) the template
# has that the live file lacks, so the user can merge selectively.
if [ -f "$TARGET/alfred/_persona.md" ]; then
  EXISTING=$(wc -l < "$TARGET/alfred/_persona.md" | tr -d ' ')
  NEW=$(wc -l < "$TMP" | tr -d ' ')
  if diff -q "$TARGET/alfred/_persona.md" "$TMP" > /dev/null 2>&1; then
    echo "[persona] live _persona.md matches rendered template (no merge needed)"
  else
    ADDED=$(diff "$TARGET/alfred/_persona.md" "$TMP" | grep -c '^>' || true)
    REMOVED=$(diff "$TARGET/alfred/_persona.md" "$TMP" | grep -c '^<' || true)
    echo ""
    echo "[persona] live _persona.md vs rendered template: $EXISTING → $NEW lines (+$ADDED / −$REMOVED)"
    echo "  The live file is NOT overwritten by deploy.sh."
    echo "  Inspect: diff $TARGET/alfred/_persona.md $RENDERED"
    echo "  Merge wanted deltas manually. Hand personalization in _persona.md survives."
  fi
fi

rm -f "$TMP"
echo ""

# 3. bin/ deployment
WIKI_TARGET="$TARGET/.bin/wiki"
WIKI_SRC="$SRC/bin/wiki"
if [ ! -e "$WIKI_TARGET" ]; then
  echo "[bin] WOULD INSTALL via install.sh"
  $APPLY && "$SRC/install.sh" "$TARGET"
elif [ -L "$WIKI_TARGET" ]; then
  LINK_TGT=$(readlink "$WIKI_TARGET")
  if [ "$LINK_TGT" = "$WIKI_SRC" ]; then
    echo "[bin] OK (symlinked to $WIKI_SRC)"
  else
    echo "[bin] WOULD RELINK ($LINK_TGT → $WIKI_SRC)"
    $APPLY && "$SRC/install.sh" "$TARGET"
  fi
else
  CURRENT_DATE=$(stat -f %Sm "$WIKI_TARGET" 2>/dev/null || stat -c %y "$WIKI_TARGET" 2>/dev/null || echo "?")
  SOURCE_DATE=$(stat -f %Sm "$WIKI_SRC"    2>/dev/null || stat -c %y "$WIKI_SRC"    2>/dev/null || echo "?")
  echo "[bin] STALE COPY at $WIKI_TARGET"
  echo "  current copy : $CURRENT_DATE"
  echo "  source       : $SOURCE_DATE"
  echo "  WOULD upgrade .bin/{wiki,inbox,email-digest,wiki-test,lib} from copies → symlinks"
  if $APPLY; then
    # Back up the stale copies before deleting (defensive: in case any have
    # local edits we can't detect). Suffix is dated so multiple deploys
    # don't clobber each other.
    BAK_SUFFIX=".pre-deploy-$(date +%Y%m%d-%H%M%S).bak"
    for f in wiki inbox email-digest wiki-test; do
      if [ -f "$TARGET/.bin/$f" ] && [ ! -L "$TARGET/.bin/$f" ]; then
        mv "$TARGET/.bin/$f" "$TARGET/.bin/${f}${BAK_SUFFIX}"
      fi
    done
    if [ -e "$TARGET/.bin/lib" ] && [ ! -L "$TARGET/.bin/lib" ]; then
      mv "$TARGET/.bin/lib" "$TARGET/.bin/lib${BAK_SUFFIX}"
    fi
    echo "  (pre-deploy copies preserved with suffix ${BAK_SUFFIX})"
    "$SRC/install.sh" "$TARGET"
  fi
fi

echo ""
if ! $APPLY; then
  echo "DRY-RUN — no files written. Re-run with --apply to write."
fi
