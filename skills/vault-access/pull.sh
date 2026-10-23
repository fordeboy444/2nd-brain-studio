#!/usr/bin/env bash
# pull.sh <vault-id> [directory] — download a vault, recording file hashes so
# push.sh can tell local edits from server-side ones.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || va_die "usage: pull.sh <vault-id> [directory]"

if [ "$#" -eq 2 ]; then
  va_remote pull "$1" "$2"
else
  va_remote pull "$1"
fi
