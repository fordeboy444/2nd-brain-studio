#!/usr/bin/env bash
# check.sh — PreToolUse hook entry point.
# Reads the hook payload JSON on stdin. Exit 0 allows, exit 2 denies with an
# explanatory message on stderr.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

exec node "$VAULT_ACCESS_DIR/vaults-node.mjs" check
