#!/usr/bin/env bash
# Shared helpers for the vault-access skill wrappers.
# This file is sourced, never executed. Resolves its own directory so the
# wrappers work from any working directory.

VAULT_ACCESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Path to the registry. VAULT_ACCESS_REGISTRY lets tests and one-off runs use
# an isolated file without touching the real registry.
va_registry_file() {
  printf '%s\n' "${VAULT_ACCESS_REGISTRY:-$VAULT_ACCESS_DIR/registry.json}"
}

# Print a prefixed message to stderr and exit non-zero.
va_die() {
  printf 'vault-access: %s\n' "$*" >&2
  exit 1
}

# Fail early with a clear message when node is unavailable.
va_require_node() {
  command -v node >/dev/null 2>&1 || va_die "node is required but was not found on PATH"
}

# Run the JSON core. Arguments are passed as an array; no shell re-parsing.
va_node() {
  node "$VAULT_ACCESS_DIR/vaults-node.mjs" "$@"
}

# --- remote (2nd Brain Studio) ---------------------------------------------
# The credential files live outside the skill and outside any repo: one file
# per profile, mode 0600. BRAIN_CONFIG_DIR overrides the directory for tests.
va_brain_config_dir() {
  printf '%s\n' "${BRAIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/brain-vaults}"
}

# Where a pull lands when no directory is given.
va_brain_cache_dir() {
  printf '%s\n' "${BRAIN_CACHE_DIR:-$HOME/.claude/vault-cache}"
}

# Run the remote client. The bearer token travels in a header built inside
# node, never as an argument, so it cannot appear in a process listing.
va_remote() {
  va_require_node
  node "$VAULT_ACCESS_DIR/remote-node.mjs" "$@"
}
