#!/usr/bin/env bash
# list.sh [repo-root] — list registered vaults, optionally marking grants.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -le 1 ] || va_die "usage: list.sh [repo-root]"

REPO="${1:-}"
GRANTED=""
if [ -n "$REPO" ]; then
  [ -d "$REPO" ] || va_die "repo root is not a directory: $REPO"
  GRANTED="$(va_node allow-list "$REPO")"
fi

ENTRIES="$(va_node registry-list)"

if [ -z "$ENTRIES" ]; then
  printf '(no vaults registered)\n'
  exit 0
fi

printf '%-24s %-10s %s\n' "VAULT" "GRANTED" "PATH"
while IFS=$'\t' read -r name stored; do
  [ -n "$name" ] || continue
  status="-"
  if [ -n "$REPO" ]; then
    if printf '%s\n' "$GRANTED" | grep -Fxq -- "$name"; then
      status="granted"
    fi
  fi
  printf '%-24s %-10s %s\n' "$name" "$status" "$stored"
done <<< "$ENTRIES"
