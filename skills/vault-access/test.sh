#!/usr/bin/env bash
# test.sh — self-check for the vault-access skill.
# Everything happens under mktemp: the real registry and any real repo
# settings.json are never touched.
set -uo pipefail

S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0
PASSED=0

T="$(mktemp -d)" || { printf 'FAIL - could not create a temp dir\n'; exit 1; }
cleanup() { rm -rf "$T"; }
trap cleanup EXIT

export VAULT_ACCESS_REGISTRY="$T/registry.json"

VAULT="$T/vaults/my-channel"
SIBLING="$T/vaults/my-channel-extra"
OUTSIDE="$T/outside"
REPO="$T/repo"
mkdir -p "$VAULT" "$SIBLING" "$OUTSIDE" "$REPO"
printf 'hello vault\n' > "$VAULT/note.md"
printf 'prefix sibling\n' > "$SIBLING/file.txt"
printf 'outside secret\n' > "$OUTSIDE/secret.txt"
ln -s /etc/passwd "$VAULT/passwd-link"

ok() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf 'FAIL - %s\n' "$1"; }

expect() { # expect <case> <expected-exit> <payload>
  local case_name="$1" want="$2" payload="$3" rc
  printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$REPO" "$S/check.sh" >/dev/null 2>"$T/last-err"
  rc=$?
  if [ "$rc" -eq "$want" ]; then
    ok "$case_name"
  else
    bad "$case_name (expected exit $want, got $rc; stderr: $(tr '\n' ' ' < "$T/last-err"))"
  fi
}

json_read() { printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$1"; }
json_write() { printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"; }
json_glob() { printf '{"tool_name":"Glob","tool_input":{"path":"%s","pattern":"%s"}}' "$1" "$2"; }
json_grep_path() { printf '{"tool_name":"Grep","tool_input":{"pattern":"hello","path":"%s"}}' "$1"; }

# --- setup: one registered vault, granted to the temp repo -----------------
if "$S/add.sh" my-channel "$VAULT" >/dev/null; then :; else bad "add.sh registers a vault"; fi
if "$S/grant.sh" "$REPO" my-channel >/dev/null; then :; else bad "grant.sh grants a vault"; fi

# --- allow cases -----------------------------------------------------------
expect "Read inside the vault is allowed" 0 "$(json_read "$VAULT/note.md")"
expect "Read inside the repo is allowed" 0 "$(json_read "$REPO/notes.md")"
expect "Write to a new nested file inside the vault is allowed" 0 "$(json_write "$VAULT/new/deep/file.md")"
expect "Glob with a vault path is allowed" 0 "$(json_glob "$VAULT" "*.md")"
expect "Grep with no path is allowed" 0 '{"tool_name":"Grep","tool_input":{"pattern":"hello"}}'

# --- deny cases ------------------------------------------------------------
expect "Read of /etc/passwd is denied" 2 "$(json_read "/etc/passwd")"
expect "Read of the prefix-sibling directory is denied" 2 "$(json_read "$SIBLING/file.txt")"
expect "Read with a ../ escape from the repo is denied" 2 "$(json_read "../outside/secret.txt")"
expect "Read of an in-vault symlink to /etc/passwd is denied" 2 "$(json_read "$VAULT/passwd-link")"
expect "Write to the repo's .claude/vaults.json is denied" 2 "$(json_write "$REPO/.claude/vaults.json")"
expect "Write to the repo's .claude/settings.json is denied" 2 "$(json_write "$REPO/.claude/settings.json")"
expect "Glob with /etc as its path is denied" 2 "$(json_glob "/etc" "*.conf")"
expect "Glob with an absolute pattern outside is denied" 2 "$(json_glob "$VAULT" "/etc/**/*.conf")"
expect "Grep with an outside path is denied" 2 "$(json_grep_path "/etc")"

# --- revocation takes effect on the next call ------------------------------
"$S/revoke.sh" "$REPO" my-channel >/dev/null
expect "Read inside the vault is denied after revoke" 2 "$(json_read "$VAULT/note.md")"

# --- install-hook merge, preservation and idempotence ----------------------
mkdir -p "$REPO/.claude"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
fs.writeFileSync(file, JSON.stringify({
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }
    ]
  }
}, null, 2) + "\n");
' "$REPO/.claude/settings.json"

if "$S/install-hook.sh" "$REPO" >/dev/null 2>"$T/hook-err"; then :; else bad "install-hook run 1 (stderr: $(tr '\n' ' ' < "$T/hook-err"))"; fi
cp "$REPO/.claude/settings.json" "$T/settings-once.json"
if "$S/install-hook.sh" "$REPO" >/dev/null 2>>"$T/hook-err"; then :; else bad "install-hook run 2 (stderr: $(tr '\n' ' ' < "$T/hook-err"))"; fi

if cmp -s "$T/settings-once.json" "$REPO/.claude/settings.json"; then
  ok "install-hook is idempotent"
else
  bad "install-hook changed the file on a second run"
fi

if node -e '
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[1];
const skill = process.argv[2];
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const pre = j.hooks && Array.isArray(j.hooks.PreToolUse) ? j.hooks.PreToolUse : [];
const all = pre.flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : []));
const ours = all.filter((h) => h && typeof h.command === "string" && h.command.includes("vault-access/check.sh"));
const entry = pre.find((e) => Array.isArray(e.hooks) && e.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("vault-access/check.sh")));
const expected = JSON.stringify(path.join(skill, "check.sh"));
const problems = [];
if (!(j.permissions && Array.isArray(j.permissions.allow) && j.permissions.allow[0] === "Bash(ls:*)")) problems.push("permissions lost");
if (!all.some((h) => h && h.command === "echo unrelated")) problems.push("unrelated hook lost");
if (ours.length !== 1) problems.push("expected exactly one vault hook, got " + ours.length);
if (!entry || entry.matcher !== "Read|Write|Edit|Glob|Grep") problems.push("matcher is wrong");
if (ours.length === 1 && ours[0].command !== expected) problems.push("command path is wrong: " + ours[0].command);
if (ours.length === 1 && ours[0].timeout !== 10) problems.push("timeout is not 10");
if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' "$REPO/.claude/settings.json" "$S"; then
  ok "install-hook preserves unrelated keys and installs exactly one vault hook"
else
  bad "install-hook merge assertions failed"
fi

# --- remote client: offline cases -----------------------------------------
export BRAIN_CONFIG_DIR="$T/brain-config"
export BRAIN_CACHE_DIR="$T/brain-cache"
unset BRAIN_URL BRAIN_TOKEN BRAIN_ADMIN_TOKEN
r() { node "$S/remote-node.mjs" "$@"; }

if r version >/dev/null; then ok "remote-node.mjs runs"; else bad "remote-node.mjs runs"; fi

if r config-set config "https://brain.example.com/" brain_agent_test >/dev/null; then
  MODE="$(node -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$BRAIN_CONFIG_DIR/config.json")"
  if [ "$MODE" = "600" ]; then ok "config.json is mode 0600"; else bad "config.json is mode $MODE, want 600"; fi
  if [ "$(r config-get config url)" = "https://brain.example.com" ]; then
    ok "config-get returns the normalised URL"
  else
    bad "config-get URL (got: $(r config-get config url))"
  fi
  if r config-get config token | grep -Fxq brain_agent_test; then
    ok "config-get returns the stored token"
  else
    bad "config-get token"
  fi
else
  bad "config-set writes the agent profile"
fi

if r config-set config "ftp://brain.example.com" token >/dev/null 2>&1; then
  bad "config-set rejects a non-http URL"
else
  ok "config-set rejects a non-http URL"
fi

# plan-push: unchanged is skipped, an untouched server copy is a put, a moved
# server copy is a conflict, and a local delete is skipped.
P="$T/plan"
mkdir -p "$P"
printf 'same\n' > "$P/same.md"
printf 'edited now\n' > "$P/edited.md"
printf 'conflict now\n' > "$P/conflict.md"
H_SAME="$(r hash "$P/same.md")"
H_OLD="$(r hash "$VAULT/note.md")"
H_CONFLICT_OLD="$(r hash "$SIBLING/file.txt")"
H_CONFLICT_SERVER="$(r hash "$OUTSIDE/secret.txt")"
node -e '
const fs = require("node:fs");
const [file, same, old, conflictOld, gone] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({
  vaultId: "v1",
  url: "https://brain.example.com",
  pulledAt: "2026-01-01T00:00:00.000Z",
  files: { "same.md": same, "edited.md": old, "conflict.md": conflictOld, "gone.md": gone }
}, null, 2) + "\n");
' "$T/meta.json" "$H_SAME" "$H_OLD" "$H_CONFLICT_OLD" "$H_OLD"
node -e '
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], JSON.stringify({ "edited.md": process.argv[2], "conflict.md": process.argv[3] }) + "\n");
' "$T/server-hashes.json" "$H_OLD" "$H_CONFLICT_SERVER"

PLAN="$(r plan-push "$T/meta.json" "$P" "$T/server-hashes.json")"
if printf '%s\n' "$PLAN" | grep -Fxq "skip same.md (unchanged)"; then
  ok "plan-push skips an unchanged file"
else
  bad "plan-push unchanged (got: $PLAN)"
fi
if printf '%s\n' "$PLAN" | grep -Fxq "put edited.md"; then
  ok "plan-push puts a locally edited file whose server copy is the pull base"
else
  bad "plan-push put (got: $PLAN)"
fi
if printf '%s\n' "$PLAN" | grep -Fxq "conflict conflict.md (the server copy changed since the pull)"; then
  ok "plan-push reports a server-side change as a conflict"
else
  bad "plan-push conflict (got: $PLAN)"
fi
if printf '%s\n' "$PLAN" | grep -q "^skip gone.md (missing locally; deletes are not pushed)"; then
  ok "plan-push does not push a local delete"
else
  bad "plan-push delete (got: $PLAN)"
fi

# install.sh: copies the skill, keeps scripts executable, and never overwrites
# an existing registry.
SKILLS="$T/claude-skills"
if CLAUDE_SKILLS_DIR="$SKILLS" "$S/install.sh" >/dev/null 2>"$T/install-err"; then
  DEST="$SKILLS/vault-access"
  if [ -f "$DEST/SKILL.md" ] && [ -f "$DEST/remote-node.mjs" ] && [ -f "$DEST/lib.sh" ]; then
    ok "install.sh copies the skill files"
  else
    bad "install.sh copy (stderr: $(tr '\n' ' ' < "$T/install-err"))"
  fi
  if [ -x "$DEST/check.sh" ] && [ -x "$DEST/login.sh" ]; then
    ok "install.sh keeps scripts executable"
  else
    bad "install.sh left scripts non-executable"
  fi
else
  bad "install.sh run 1 (stderr: $(tr '\n' ' ' < "$T/install-err"))"
fi

printf '{"vaults":{"mine":"/srv/mine"}}\n' > "$SKILLS/vault-access/registry.json"
CLAUDE_SKILLS_DIR="$SKILLS" "$S/install.sh" >/dev/null 2>&1
if grep -Fq '/srv/mine' "$SKILLS/vault-access/registry.json"; then
  ok "install.sh preserves an existing registry.json"
else
  bad "install.sh overwrote registry.json"
fi

# Network cases run only against a real deployment.
if [ -n "${BRAIN_TEST_URL:-}" ] && [ -n "${BRAIN_TEST_TOKEN:-}" ]; then
  if "$S/login.sh" "$BRAIN_TEST_URL" "$BRAIN_TEST_TOKEN" >/dev/null 2>"$T/login-err"; then
    ok "login.sh accepts a live token"
  else
    bad "login.sh live (stderr: $(tr '\n' ' ' < "$T/login-err"))"
  fi
  if "$S/remote-list.sh" >/dev/null 2>&1; then
    ok "remote-list.sh lists live vaults"
  else
    bad "remote-list.sh live"
  fi
fi

# --- summary ---------------------------------------------------------------
if [ "$FAILED" -eq 0 ]; then
  printf 'ALL TESTS PASSED (%d)\n' "$PASSED"
  exit 0
fi
printf 'FAILURES (%d)\n' "$FAILED"
exit 1
