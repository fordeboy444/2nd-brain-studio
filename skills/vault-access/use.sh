#!/usr/bin/env bash
# use.sh <repo-root> <vault-id> — pull a remote vault into a repo, register it,
# grant it to that repo, and install the guard hook.
# Stops at the first failure: a repo is never left half-wired on purpose.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 2 ] || va_die "usage: use.sh <repo-root> <vault-id>"

REPO="$1"
VAULT_ID="$2"

[ -d "$REPO" ] || va_die "repo root is not a directory: $REPO"
REPO="$(realpath -e -- "$REPO")"

TARGET="$REPO/$VAULT_ID"
[ ! -e "$TARGET" ] || va_die "target already exists: $TARGET (move it aside or run pull.sh yourself)"

"$DIR/pull.sh" "$VAULT_ID" "$TARGET"
"$DIR/add.sh" "$VAULT_ID" "$TARGET"
"$DIR/grant.sh" "$REPO" "$VAULT_ID"
"$DIR/install-hook.sh" "$REPO"
"$DIR/status.sh" "$REPO"
