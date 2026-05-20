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
PRUNE_BACKUPS=false
TARGET=""
USER_NAME=""; USER_SLUG=""; USER_EMAIL=""; USER_TZ_CITY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)         APPLY=true; shift ;;
    --prune-backups) PRUNE_BACKUPS=true; shift ;;
    --target)        TARGET="$2"; shift 2 ;;
    --user-name)     USER_NAME="$2"; shift 2 ;;
    --user-slug)     USER_SLUG="$2"; shift 2 ;;
    --user-email)    USER_EMAIL="$2"; shift 2 ;;
    --user-tz-city)  USER_TZ_CITY="$2"; shift 2 ;;
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

# 3. bin/ deployment (COPY, not symlink)
#
# Symlinks store absolute paths and don't survive Dropbox-mediated sync to a
# different filesystem (the Mac dev path won't resolve inside a Linux container
# that has only the vault mounted). The historical working state of this
# vault was copies. We restore that here.
#
# Trade-off: copies don't auto-update when the source changes — you must
# re-run deploy.sh. For a personal vault with one dev machine and a runtime
# container, the manual sync step is worth the cross-platform robustness.
mkdir -p "$TARGET/.bin"
BIN_ITEMS=(wiki inbox email-digest daily-brief gmail wiki-test)

# --prune-backups: remove the legacy .pre-deploy-*.bak files that earlier
# versions of this script accreted on every refresh. The source repo is
# git-versioned, so backups of deployed build artifacts have no recovery value;
# they only clutter .bin/ and create stale grep hits during debugging.
if $PRUNE_BACKUPS; then
  BAK_COUNT=$(find "$TARGET/.bin" -maxdepth 2 -name '*.pre-deploy-*.bak' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$BAK_COUNT" -eq 0 ]; then
    echo "[prune] no .pre-deploy-*.bak files under $TARGET/.bin"
  else
    echo "[prune] $BAK_COUNT .pre-deploy-*.bak file(s) under $TARGET/.bin"
    if $APPLY; then
      find "$TARGET/.bin" -maxdepth 2 -name '*.pre-deploy-*.bak' -exec rm -rf {} +
      echo "[prune] removed $BAK_COUNT backup(s)"
    else
      echo "[prune] DRY-RUN — re-run with --apply to delete"
    fi
  fi
  echo ""
fi

# Snapshot summary: what's there now vs what we'd write.
NEEDS_COPY=()
for f in "${BIN_ITEMS[@]}"; do
  src="$SRC/bin/$f"
  dst="$TARGET/.bin/$f"
  if [ ! -f "$src" ]; then
    echo "[bin] WARN: source $src missing, skipping"
    continue
  fi
  if [ ! -e "$dst" ]; then
    NEEDS_COPY+=("$f" "create")
    continue
  fi
  if [ -L "$dst" ]; then
    NEEDS_COPY+=("$f" "delink-then-copy")
    continue
  fi
  if cmp -s "$src" "$dst"; then
    : # identical, no work needed
  else
    NEEDS_COPY+=("$f" "refresh")
  fi
done
# Subtree directories under bin/ (lib/, verbs/, etc.) — keep this list in sync
# with new top-level dirs added under bin/. Each is copy-or-refreshed as a unit.
BIN_DIRS=(lib verbs)
DIR_ACTIONS=()
for d in "${BIN_DIRS[@]}"; do
  src="$SRC/bin/$d"
  dst="$TARGET/.bin/$d"
  if [ ! -e "$src" ]; then continue; fi
  if [ ! -e "$dst" ]; then
    DIR_ACTIONS+=("$d" "create")
  elif [ -L "$dst" ]; then
    DIR_ACTIONS+=("$d" "delink-then-copy")
  elif diff -rq "$src" "$dst" > /dev/null 2>&1; then
    : # identical, skip
  else
    DIR_ACTIONS+=("$d" "refresh")
  fi
done

if [ ${#NEEDS_COPY[@]} -eq 0 ] && [ ${#DIR_ACTIONS[@]} -eq 0 ]; then
  echo "[bin] OK (all .bin/ files match source — no copy needed)"
else
  echo "[bin] WOULD COPY (or refresh) ${#BIN_ITEMS[@]} CLIs + subtree(s) from $SRC/bin → $TARGET/.bin"
  for ((i = 0; i < ${#NEEDS_COPY[@]}; i += 2)); do
    echo "    $TARGET/.bin/${NEEDS_COPY[i]}: ${NEEDS_COPY[i+1]}"
  done
  for ((i = 0; i < ${#DIR_ACTIONS[@]}; i += 2)); do
    echo "    $TARGET/.bin/${DIR_ACTIONS[i]}/: ${DIR_ACTIONS[i+1]}"
  done
  if $APPLY; then
    # No per-file backups: the source is git-versioned, so the recovery path
    # for a bad deploy is `git checkout` in the repo, not a .bak in .bin/.
    # Overwrite directly. (Old .pre-deploy-*.bak files: clean up with
    # `--prune-backups --apply`.)
    for ((i = 0; i < ${#NEEDS_COPY[@]}; i += 2)); do
      f="${NEEDS_COPY[i]}"
      dst="$TARGET/.bin/$f"
      if [ -L "$dst" ]; then rm -f "$dst"; fi
      cp -p "$SRC/bin/$f" "$dst"
      chmod +x "$dst"
    done
    for ((i = 0; i < ${#DIR_ACTIONS[@]}; i += 2)); do
      d="${DIR_ACTIONS[i]}"
      src="$SRC/bin/$d"
      dst="$TARGET/.bin/$d"
      if [ -L "$dst" ]; then rm -f "$dst"; fi
      if [ -d "$dst" ]; then rm -rf "$dst"; fi
      cp -R "$src" "$dst"
    done
    echo "  (overwrote in place; recovery via git in the source repo)"
  fi
fi

echo ""
if ! $APPLY; then
  echo "DRY-RUN — no files written. Re-run with --apply to write."
fi
