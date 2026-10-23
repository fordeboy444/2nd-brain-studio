#!/usr/bin/env bash
# admin-login.sh <url> <admin-token> — verify the admin token against the token
# list, then store it in a separate profile from the agent credential.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 2 ] || va_die "usage: admin-login.sh <url> <admin-token>"

URL="$1"
TOKEN="$2"

LISTING="$(BRAIN_URL="$URL" BRAIN_ADMIN_TOKEN="$TOKEN" va_remote admin-list)" \
  || va_die "admin login failed: the URL or admin token was not accepted"

va_remote config-set admin "$URL" "$TOKEN" >/dev/null

if [ "$LISTING" = "(no agent tokens)" ]; then
  COUNT=0
else
  COUNT="$(printf '%s\n' "$LISTING" | grep -c . || true)"
fi
printf 'admin login to %s ok (%s agent token(s))\n' "${URL%/}" "$COUNT"
