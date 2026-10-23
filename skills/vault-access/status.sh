#!/usr/bin/env bash
# status.sh <repo-root> — show every granted vault for one repo.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 1 ] || va_die "usage: status.sh <repo-root>"

REPO="$1"
[ -d "$REPO" ] || va_die "repo root is not a directory: $REPO"

REPO_CANONICAL="$(realpath -e -- "$REPO")"
ROWS="$(va_node allow-validate "$REPO")"

printf 'repo: %s\n' "$REPO_CANONICAL"

if [ -z "$ROWS" ]; then
  printf 'no vaults are granted to this repo\n'
  printf 'grant one with: %s <repo-root> <vault-name>\n' "$DIR/grant.sh"
  exit 0
fi

COUNT=0
while IFS=$'\t' read -r name vault_path vault_status; do
  [ -n "$name" ] || continue
  COUNT=$((COUNT + 1))
  if [ "$vault_status" = "unregistered" ]; then
    printf '  %-24s unregistered (no longer in registry.json)\n' "$name"
  else
    printf '  %-24s %s\n' "$name" "$vault_path"
  fi
done <<< "$ROWS"

printf 'granted: %d vault(s)\n' "$COUNT"
