#!/usr/bin/env bash
# install.sh [--link] — install this skill for Claude Code.
#
# Default: copy every file into the skills directory, overwriting the managed
# files but never an existing registry.json.
# --link: symlink each file instead, so edits here are live.
#
# CLAUDE_SKILLS_DIR picks the skills root; CLAUDE_CONFIG_DIR is the fallback
# base, then ~/.claude.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="copy"
case "${1:-}" in
  "") ;;
  --link) MODE="link" ;;
  *)
    printf 'vault-access: usage: install.sh [--link]\n' >&2
    exit 1
    ;;
esac

SKILLS_ROOT="${CLAUDE_SKILLS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"
DEST="$SKILLS_ROOT/vault-access"

mkdir -p "$DEST"
chmod 700 "$DEST"

# A registry holds machine-specific paths and must survive a reinstall: it is
# created only when the destination does not already have one.
install_file() {
  local source="$1" target="$2"
  if [ "$MODE" = "link" ]; then
    rm -f -- "$target"
    ln -s -- "$source" "$target"
  else
    cp -f -- "$source" "$target"
  fi
  # Scripts stay executable; data files stay readable-only.
  if [ "$(head -c 2 -- "$target")" = "#!" ]; then
    chmod 755 "$target"
  else
    chmod 644 "$target"
  fi
}

shopt -s nullglob
for file in "$DIR"/*; do
  base="$(basename "$file")"
  [ "$base" = "registry.json" ] && continue
  install_file "$file" "$DEST/$base"
done
shopt -u nullglob

if [ ! -e "$DEST/registry.json" ] && [ -f "$DIR/registry.json" ]; then
  install_file "$DIR/registry.json" "$DEST/registry.json"
fi

DEST_RESOLVED="$(cd "$DEST" && pwd -P)"
printf 'installed vault-access into %s (%s)\n' "$DEST_RESOLVED" "$MODE"
