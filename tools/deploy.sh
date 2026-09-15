#!/usr/bin/env bash
# tools/deploy.sh — render the assembled persona template and refresh bin/ symlinks in
# a target vault. Default mode is dry-run; pass --apply to actually write.
#
# What it does (in order):
#   1. Seed .alfred.yml from examples/.alfred.yml.example if missing.
#   2. Render docs/persona/*.template.md + optional
#      <target>/persona/agents.d/*.md into <target>/AGENTS.md (via
#      render-persona.sh). Existing hand-authored AGENTS.md files are protected:
#      pass --adopt-generated-persona once after reviewing the rendered diff.
#   3. Copy runtime policy docs that the deployed persona references.
#   4. Refresh <target>/.bin/ via install.sh (handles copy → symlink upgrade
#      when the current .bin/ entries are stale copies, e.g. from a previous
#      manual deploy that bypassed install.sh).
#
# Usage:
#   tools/deploy.sh --target /path/to/vault \
#                   --user-name "Your Name" --user-slug your-slug \
#                   --user-email you@example.com --user-tz-city "Your City" \
#                   [--assistant-name "Alfred"] \
#                   [--adopt-generated-persona] \
#                   [--apply]
#
# Idempotent. Re-running with the same config is a no-op.

set -euo pipefail

APPLY=false
PRUNE_BACKUPS=false
ADOPT_GENERATED_PERSONA=false
TARGET=""
USER_NAME=""; USER_SLUG=""; USER_EMAIL=""; USER_TZ_CITY=""; ASSISTANT_NAME="Alfred"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)         APPLY=true; shift ;;
    --prune-backups) PRUNE_BACKUPS=true; shift ;;
    --adopt-generated-persona) ADOPT_GENERATED_PERSONA=true; shift ;;
    --target)        TARGET="$2"; shift 2 ;;
    --user-name)     USER_NAME="$2"; shift 2 ;;
    --user-slug)     USER_SLUG="$2"; shift 2 ;;
    --user-email)    USER_EMAIL="$2"; shift 2 ;;
    --user-tz-city)  USER_TZ_CITY="$2"; shift 2 ;;
    --assistant-name) ASSISTANT_NAME="$2"; shift 2 ;;
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

ensure_gitignore_entry() {
  local file="$1" entry="$2"
  if grep -qxF "$entry" "$file" 2>/dev/null; then
    return 0
  fi
  echo "[config] WOULD APPEND $entry to $file"
  if $APPLY; then
    {
      printf '\n# Runtime + private assistant artifacts\n'
      printf '%s\n' "$entry"
    } >> "$file"
    echo "[config] appended $entry to $file"
  fi
}

echo "=== deploy.sh ==="
echo "  source:   $SRC"
echo "  target:   $TARGET"
echo "  apply:    $APPLY"
echo "  user:     $USER_NAME ($USER_SLUG)"
echo "  assistant:$ASSISTANT_NAME"
echo "  tz_city:  $USER_TZ_CITY"
echo "  persona:  generated AGENTS.md (adopt=$ADOPT_GENERATED_PERSONA)"
echo ""

LOCALITY_WARNING=$(node - "$TARGET" "$SRC" <<'NODE'
const target = process.argv[2];
const src = process.argv[3];
const { localityWarningForVault } = require(`${src}/bin/lib/locality.js`);
const warning = localityWarningForVault(target);
if (warning) console.log(warning.message);
NODE
)
if [ -n "$LOCALITY_WARNING" ]; then
  echo "[locality] WARN: $LOCALITY_WARNING"
  echo "  .gitignore prevents git commits, not Dropbox/iCloud/CloudStorage sync."
  echo ""
fi

# 1. .alfred.yml
if [ ! -f "$TARGET/.alfred.yml" ]; then
  echo "[config] WOULD CREATE $TARGET/.alfred.yml"
  echo "  user.slug: $USER_SLUG"
  echo "  user.name: $USER_NAME"
  echo "  assistant.name: $ASSISTANT_NAME"
  echo "  email.from: $USER_EMAIL"
  if $APPLY; then
    node "$SRC/tools/render-alfred-config.js" \
      --template "$SRC/examples/.alfred.yml.example" \
      --user-slug "$USER_SLUG" \
      --user-name "$USER_NAME" \
      --assistant-name "$ASSISTANT_NAME" \
      --email-from "$USER_EMAIL" \
      > "$TARGET/.alfred.yml"
    echo "[config] wrote $TARGET/.alfred.yml — review/edit before next deploy"
  fi
else
  echo "[config] OK (.alfred.yml present)"
fi
echo ""

# 1b. .gitignore — seed if absent so a fresh vault starts clean. Without this a
# new vault tracks runtime artifacts (the cache/ logs the cron jobs append to,
# the DuckDB .cache/, tamper.log, rendered persona review files), which dirty the
# tree on every run and trip the tamper-check. Idempotent: never clobber an
# existing .gitignore.
if [ ! -f "$TARGET/.gitignore" ]; then
  echo "[config] WOULD CREATE $TARGET/.gitignore"
  if $APPLY; then
    cat > "$TARGET/.gitignore" <<'GITIGNORE'
# Runtime + derived artifacts — not vault content. Tracking them dirties the
# tree on every CLI/cron run (auto-commit is scoped to wiki/ + raw/).
# DuckDB analytical view (rebuilt lazily)
.cache/
# daily-brief / reminder-dispatch run logs
cache/
# per-vault credentials and local-only runtime secrets
.alfred/private/
.DS_Store
# appended by the tamper watcher
alfred/tamper.log
alfred/log/
alfred/scratchpad.md
# persona render artifact (canonical is AGENTS.md)
AGENTS.local.md
AGENTS.rendered.md
# deployed CLI/runtime copy (source of truth is alfred_assistant)
.bin/
__pycache__/
*.pyc
GITIGNORE
    echo "[config] wrote $TARGET/.gitignore"
  fi
else
  echo "[config] OK (.gitignore present)"
  ensure_gitignore_entry "$TARGET/.gitignore" ".alfred/private/"
  ensure_gitignore_entry "$TARGET/.gitignore" ".bin/"
  ensure_gitignore_entry "$TARGET/.gitignore" "AGENTS.local.md"
  ensure_gitignore_entry "$TARGET/.gitignore" "AGENTS.rendered.md"
fi
echo ""

if git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED_BIN=$(git -C "$TARGET" ls-files .bin 2>/dev/null | wc -l | tr -d ' ')
  if [ "$TRACKED_BIN" -gt 0 ]; then
    echo "[config] WARN: $TRACKED_BIN tracked .bin file(s) in $TARGET"
    echo "  .bin/ is deployed runtime code; prefer gitignored, untracked copies."
    echo "  To migrate deliberately: git -C $TARGET rm -r --cached .bin && git -C $TARGET commit -m 'Stop tracking deployed .bin artifacts'"
  fi
fi
echo ""

# 1c. Private per-vault directory for credentials. The deploy script creates
# the directory with owner-only permissions but never writes secrets into it.
echo "[private] WOULD ENSURE $TARGET/.alfred/private (mode 700)"
if $APPLY; then
  mkdir -p "$TARGET/.alfred/private"
  chmod 700 "$TARGET/.alfred" "$TARGET/.alfred/private" 2>/dev/null || true
  echo "[private] OK ($TARGET/.alfred/private)"
fi
echo ""

# 2. Render the canonical runtime persona. AGENTS.md is generated from the repo
# fragments, .alfred.yml identity, and optional vault-local overlays in
# persona/agents.d/*.md. Existing hand-authored AGENTS.md files are protected by
# render-persona.sh unless --adopt-generated-persona is passed.
RENDER_ARGS=(--vault "$TARGET")
if $APPLY; then
  RENDER_ARGS+=(--apply)
  if $ADOPT_GENERATED_PERSONA; then
    RENDER_ARGS+=(--adopt-generated-persona)
  fi
fi
"$SELF/render-persona.sh" "${RENDER_ARGS[@]}"
echo ""

# 2b. Runtime policy docs referenced by the deployed persona.
POLICY_DOCS=(
  "EMAIL-REVIEW.md:email-review.md"
  "CONVERSATION-INGEST.md:conversation-ingest.md"
)
for policy in "${POLICY_DOCS[@]}"; do
  SRC_NAME="${policy%%:*}"
  DST_NAME="${policy##*:}"
  POLICY_SRC="$SRC/docs/$SRC_NAME"
  POLICY_DST="$TARGET/persona/$DST_NAME"
  if [ -f "$POLICY_SRC" ]; then
    if [ ! -e "$POLICY_DST" ]; then
      echo "[persona-doc] WOULD CREATE $POLICY_DST"
    elif cmp -s "$POLICY_SRC" "$POLICY_DST"; then
      echo "[persona-doc] OK ($DST_NAME policy unchanged)"
    else
      echo "[persona-doc] WOULD UPDATE $POLICY_DST"
    fi
    if $APPLY; then
      mkdir -p "$TARGET/persona"
      cp "$POLICY_SRC" "$POLICY_DST"
      echo "[persona-doc] wrote $POLICY_DST"
    fi
  else
    echo "[persona-doc] WARN: source $POLICY_SRC missing, skipping"
  fi
done
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
BIN_ITEMS=(wiki inbox email-digest daily-brief reminder-dispatch telegram-send gmail email-review wiki-test docker-watchdog)

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
BIN_DIRS=(lib verbs commands)
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

INGEST_SCHEMA_SRC="$SRC/schemas/wiki-ingest.schema.json"
INGEST_SCHEMA_DST="$TARGET/.bin/wiki-ingest.schema.json"
INGEST_SCHEMA_ACTION=""
if [ -f "$INGEST_SCHEMA_SRC" ]; then
  if [ ! -e "$INGEST_SCHEMA_DST" ]; then
    INGEST_SCHEMA_ACTION="create"
  elif [ -L "$INGEST_SCHEMA_DST" ]; then
    INGEST_SCHEMA_ACTION="delink-then-copy"
  elif cmp -s "$INGEST_SCHEMA_SRC" "$INGEST_SCHEMA_DST"; then
    : # identical, skip
  else
    INGEST_SCHEMA_ACTION="refresh"
  fi
else
  echo "[bin] WARN: source $INGEST_SCHEMA_SRC missing, skipping ingest schema"
fi

if [ ${#NEEDS_COPY[@]} -eq 0 ] && [ ${#DIR_ACTIONS[@]} -eq 0 ] && [ -z "$INGEST_SCHEMA_ACTION" ]; then
  echo "[bin] OK (all .bin/ files match source — no copy needed)"
else
  echo "[bin] WOULD COPY (or refresh) ${#BIN_ITEMS[@]} CLIs + subtree(s) from $SRC/bin → $TARGET/.bin"
  for ((i = 0; i < ${#NEEDS_COPY[@]}; i += 2)); do
    echo "    $TARGET/.bin/${NEEDS_COPY[i]}: ${NEEDS_COPY[i+1]}"
  done
  for ((i = 0; i < ${#DIR_ACTIONS[@]}; i += 2)); do
    echo "    $TARGET/.bin/${DIR_ACTIONS[i]}/: ${DIR_ACTIONS[i+1]}"
  done
  if [ -n "$INGEST_SCHEMA_ACTION" ]; then
    echo "    $TARGET/.bin/wiki-ingest.schema.json: $INGEST_SCHEMA_ACTION"
  fi
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
    if [ -n "$INGEST_SCHEMA_ACTION" ]; then
      if [ -L "$INGEST_SCHEMA_DST" ]; then rm -f "$INGEST_SCHEMA_DST"; fi
      cp -p "$INGEST_SCHEMA_SRC" "$INGEST_SCHEMA_DST"
    fi
    echo "  (overwrote in place; recovery via git in the source repo)"
  fi
fi

echo ""
if ! $APPLY; then
  echo "DRY-RUN — no files written. Re-run with --apply to write."
fi
