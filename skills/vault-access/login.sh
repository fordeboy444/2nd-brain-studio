#!/usr/bin/env bash
# login.sh <url> <token> — verify a 2nd Brain agent token, then store it.
# The token is checked against `list` before it is written, so a rejected value
# never lands in the config file.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 2 ] || va_die "usage: login.sh <url> <token>"

URL="$1"
TOKEN="$2"

# Env overrides keep the credential out of the stored file until it works.
LISTING="$(BRAIN_URL="$URL" BRAIN_TOKEN="$TOKEN" va_remote list)" \
  || va_die "login failed: the URL or token was not accepted"

va_remote config-set config "$URL" "$TOKEN" >/dev/null

if [ "$LISTING" = "(no vaults in scope)" ]; then
  COUNT=0
else
  COUNT="$(printf '%s\n' "$LISTING" | grep -c . || true)"
fi
printf 'logged in to %s (%s vault(s) in scope)\n' "${URL%/}" "$COUNT"
