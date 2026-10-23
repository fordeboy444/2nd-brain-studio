#!/usr/bin/env bash
# revoke.sh <repo-root> <vault-name> — remove a grant. Absent grants exit 0.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 2 ] || va_die "usage: revoke.sh <repo-root> <vault-name>"

REPO="$1"
NAME="$2"

[ -d "$REPO" ] || va_die "repo root is not a directory: $REPO"

WAS_GRANTED=0
if va_node allow-list "$REPO" | grep -Fxq -- "$NAME"; then
  WAS_GRANTED=1
fi

va_node allow-del "$REPO" "$NAME" >/dev/null

if [ "$WAS_GRANTED" -eq 1 ]; then
  printf 'revoked %s from %s\n' "$NAME" "$(realpath -e -- "$REPO")"
else
  printf 'not granted: %s (nothing to do)\n' "$NAME"
fi
