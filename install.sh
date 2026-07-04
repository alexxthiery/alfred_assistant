#!/usr/bin/env bash
# install.sh — symlink alfred_assistant's bin/ into a target vault's .bin/
#
# Usage:
#   ./install.sh /path/to/vault
#
# Idempotent: re-running re-creates symlinks. Refuses if a target file exists
# and is NOT already a symlink (to avoid clobbering hand-written scripts).
#
# Expects the target vault to have an .alfred.yml (see examples/.alfred.yml.example).

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 /path/to/vault" >&2
  exit 2
fi

TARGET=$(cd "$1" && pwd)
SELF=$(cd "$(dirname "$0")" && pwd)
SRC_BIN="$SELF/bin"
DEST_BIN="$TARGET/.bin"

if [ ! -d "$SRC_BIN" ]; then
  echo "install.sh: source bin/ not found at $SRC_BIN" >&2
  exit 1
fi
if [ ! -f "$TARGET/.alfred.yml" ]; then
  echo "install.sh: target vault has no .alfred.yml" >&2
  echo "  cp $SELF/examples/.alfred.yml.example $TARGET/.alfred.yml" >&2
  echo "  then edit user.slug, user.name, email.from." >&2
  exit 1
fi

mkdir -p "$DEST_BIN"

# Symlink each top-level script (not the lib/ subdir — let the CLI find it via require)
linked=0
for f in wiki inbox wiki-test email-digest daily-brief reminder-dispatch telegram-send twitter-read; do
  src="$SRC_BIN/$f"
  dst="$DEST_BIN/$f"
  if [ ! -f "$src" ]; then
    echo "install.sh: missing source $src" >&2
    exit 1
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "install.sh: refusing to overwrite non-symlink $dst" >&2
    exit 1
  fi
  ln -sfn "$src" "$dst"
  linked=$((linked + 1))
done

# Symlink lib/ as a whole (config.js is resolved relative to bin/ via require)
if [ -e "$DEST_BIN/lib" ] && [ ! -L "$DEST_BIN/lib" ]; then
  echo "install.sh: refusing to overwrite non-symlink $DEST_BIN/lib" >&2
  exit 1
fi
ln -sfn "$SRC_BIN/lib" "$DEST_BIN/lib"

# Copy SCHEMA.md into the vault root if missing.
# The CLI reads <vault>/SCHEMA.md on every invocation to load the closed-set
# type/tag/verb registries. Without it, validation silently degrades (no tag
# enforcement, no verb enforcement, no forbidden-slug enforcement). Copy (not
# symlink) so the user can customize their vault's schema independently of
# upstream.
SRC_SCHEMA="$SELF/docs/SCHEMA.md"
DEST_SCHEMA="$TARGET/SCHEMA.md"
if [ ! -f "$DEST_SCHEMA" ]; then
  if [ -f "$SRC_SCHEMA" ]; then
    cp "$SRC_SCHEMA" "$DEST_SCHEMA"
    echo "installed SCHEMA.md → $DEST_SCHEMA"
  else
    echo "install.sh: warning: $SRC_SCHEMA missing; vault will run with empty schema" >&2
  fi
else
  echo "SCHEMA.md already present at $DEST_SCHEMA — keeping yours (no overwrite)"
fi

echo "installed $linked CLIs + lib/ into $DEST_BIN"
echo ""
echo "Next steps:"
echo "  cd $TARGET"
echo "  wiki list                # smoke test"
echo "  $SELF/bin/wiki-test      # run the fixture suite"
