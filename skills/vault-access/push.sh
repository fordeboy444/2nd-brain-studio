#!/usr/bin/env bash
# push.sh <vault-id> — upload local edits to a pulled vault.
# Deletes are not pushed; a file the server changed since the pull is a
# conflict and nothing is written for it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

[ "$#" -eq 1 ] || va_die "usage: push.sh <vault-id>"

va_remote push "$1"
