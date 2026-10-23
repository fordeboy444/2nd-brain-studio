#!/usr/bin/env bash
# install-hook.sh <repo-root> — install the vault-access PreToolUse hook into
# <repo-root>/.claude/settings.json. Idempotent and non-destructive.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 1 ] || va_die "usage: install-hook.sh <repo-root>"

REPO="$1"
[ -d "$REPO" ] || va_die "repo root is not a directory: $REPO"
REPO="$(realpath -e -- "$REPO")"

CHECK="$DIR/check.sh"
[ -f "$CHECK" ] || va_die "check.sh is missing: $CHECK"
[ -x "$CHECK" ] || va_die "check.sh is not executable: $CHECK"

va_node install-hook "$REPO" "$CHECK"
printf 'note: hook changes apply to new sessions\n'
