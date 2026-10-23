#!/usr/bin/env bash
# grant.sh <repo-root> <vault-name> — grant a registered vault to one repo.
# This script only writes <repo>/.claude/vaults.json; installing the hook is a
# separate, explicit step (install-hook.sh).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 2 ] || va_die "usage: grant.sh <repo-root> <vault-name>"

REPO="$1"
NAME="$2"

[ -d "$REPO" ] || va_die "repo root is not a directory: $REPO"

VAULT_PATH=""
if VAULT_PATH="$(va_node registry-get "$NAME" 2>/dev/null)"; then :; else
  va_die "vault '$NAME' is not registered; register it first with: $DIR/add.sh $NAME /absolute/path"
fi

mkdir -p "$REPO/.claude"
va_node allow-add "$REPO" "$NAME" >/dev/null

printf 'granted %s -> %s (repo: %s)\n' "$NAME" "$VAULT_PATH" "$(realpath -e -- "$REPO")"
