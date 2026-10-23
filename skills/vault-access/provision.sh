#!/usr/bin/env bash
# provision.sh <name> --vaults <id,id|*> — mint an agent token and print it once.
# Needs the admin profile: run admin-login.sh first, or set BRAIN_ADMIN_TOKEN.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
va_require_node

[ "$#" -eq 3 ] || va_die "usage: provision.sh <name> --vaults <id,id|*>"
[ "$2" = "--vaults" ] || va_die "expected --vaults, got: $2"

va_remote provision "$1" "$3"
