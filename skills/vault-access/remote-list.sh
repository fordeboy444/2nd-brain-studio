#!/usr/bin/env bash
# remote-list.sh — list the vaults this agent token can reach.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

[ "$#" -eq 0 ] || va_die "usage: remote-list.sh"

va_remote list
