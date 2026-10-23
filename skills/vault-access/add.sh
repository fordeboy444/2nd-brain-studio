#!/usr/bin/env bash
# add.sh <name> <absolute-path> — register a vault directory under a name.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 2 ] || va_die "usage: add.sh <name> <absolute-path>"

NAME="$1"
RAW_PATH="$2"

[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || va_die "invalid vault name '$NAME' (allowed: A-Z a-z 0-9 . _ -)"
[[ "$RAW_PATH" == /* ]] || va_die "vault path must be absolute: $RAW_PATH"
[ -e "$RAW_PATH" ] || va_die "vault path does not exist: $RAW_PATH"
[ -d "$RAW_PATH" ] || va_die "vault path is not a directory: $RAW_PATH"

CANONICAL="$(realpath -e -- "$RAW_PATH")" || va_die "cannot resolve vault path: $RAW_PATH"

PREVIOUS=""
if PREVIOUS="$(va_node registry-get "$NAME" 2>/dev/null)"; then :; else PREVIOUS=""; fi

va_node registry-put "$NAME" "$CANONICAL" >/dev/null

if [ -n "$PREVIOUS" ]; then
  printf 'updated %s -> %s\n' "$NAME" "$CANONICAL"
else
  printf 'registered %s -> %s\n' "$NAME" "$CANONICAL"
fi
