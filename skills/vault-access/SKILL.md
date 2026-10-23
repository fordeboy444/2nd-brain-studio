---
name: vault-access
description: Register named vault directories and grant each agent repo access to a subset, enforced by a PreToolUse hook on Read, Write, Edit, Glob and Grep. Also logs in to a 2nd Brain Studio URL with a per-token vault scope, lists, pulls, pushes and uses remote vaults. Use when the user says "grant vault access", asks "which vaults can this repo access", says "revoke vault", mentions a "vault allowlist", or asks to log in to, pull from, or push to a 2nd Brain.
---

# vault-access

A user-level skill for sharing named directories ("vaults") with individual agent
repos. The registry of vaults is user-wide; the grant lives in each repo, so one
repo's access never implies another's.

Skill directory:

```
~/.claude/skills/vault-access/
```

## 1. Rule for the agent

When the user asks to give an agent repo access to a vault:

1. Run `list.sh` first.
2. **Ask the user which registered vault to grant.** Never infer the vault from
   the repo name, the current directory, the contents of the repo, or the order
   of entries in the registry.
3. If the wanted vault is not registered, ask the user for its absolute path and
   register it with `add.sh <name> <absolute-path>`.
4. Run `grant.sh <repo-root> <vault-name>`.
5. If the repo has no vault-access hook yet, run `install-hook.sh <repo-root>`.
6. Finish with `status.sh <repo-root>` and show the result.

Never grant a vault, register a new one, or edit `.claude/vaults.json` by hand
without an explicit answer from the user about which vault and which repo.

## 2. Commands

All scripts live in the skill directory and work from any working directory.
Only `bash`, `node` and coreutils are required (no `jq`).

| Command | Arguments | What it does | Example |
| --- | --- | --- | --- |
| `add.sh` | `<name> <absolute-path>` | Register a vault directory under a name (re-registering updates the path) | `add.sh my-channel /srv/vaults/my-channel` |
| `list.sh` | `[repo-root]` | List registered vaults; with a repo, mark each `granted` or `-` | `list.sh ~/Projects/agent-a` |
| `grant.sh` | `<repo-root> <vault-name>` | Grant a registered vault to one repo (writes `<repo>/.claude/vaults.json`) | `grant.sh ~/Projects/agent-a my-channel` |
| `revoke.sh` | `<repo-root> <vault-name>` | Remove a grant; exits 0 when it was absent | `revoke.sh ~/Projects/agent-a my-channel` |
| `status.sh` | `<repo-root>` | Show every granted vault, flagging names the registry no longer has | `status.sh ~/Projects/agent-a` |
| `install-hook.sh` | `<repo-root>` | Merge the PreToolUse hook into `<repo>/.claude/settings.json` (idempotent) | `install-hook.sh ~/Projects/agent-a` |
| `check.sh` | stdin JSON | The hook itself: exit 0 allows, exit 2 denies. Not run by hand | — |
| `test.sh` | — | Self-check; exits 0 only when every allow/deny case passes | `test.sh` |

`VAULT_ACCESS_REGISTRY` overrides the registry path; tests and one-off runs use
it so the real registry is never touched.

## 3. File formats

Registry (user-wide), `~/.claude/skills/vault-access/registry.json`. Shipped
empty; names map to absolute paths:

```json
{
  "vaults": {}
}
```

```json
{
  "vaults": {
    "my-channel": "/srv/vaults/my-channel"
  }
}
```

Per-repo allowlist, `<repo>/.claude/vaults.json`. Grants are names only; the
path always comes from the registry, so re-pointing a name re-points every repo
that granted it:

```json
{
  "vaults": ["my-channel"]
}
```

Unknown top-level keys are preserved on every write. An unknown name grants
nothing.

## 4. How the hook decides

- The project repo root (`CLAUDE_PROJECT_DIR`) is **always** allowed.
- Each granted name adds its registry path as an additional allowed root;
  unregistered names are skipped.
- `Write` and `Edit` against `<repo>/.claude/vaults.json` and
  `<repo>/.claude/settings.json` are denied, so the matched tools cannot rewrite
  the grant or the hook config. Use the scripts instead.
- Targets and allowed roots are symlink-resolved before comparison. A candidate
  is resolved by realpathing its nearest existing ancestor and rejoining the
  missing tail, so writing a new file inside a vault works while a symlink that
  points outside does not.
- Boundary matching is exact or `root + "/"` prefix, so a prefix sibling such as
  `/srv/vaults/my-channel-extra` never matches `/srv/vaults/my-channel`.
- Reads of `Read`, `Write`, `Edit` use `file_path`; `Glob`/`Grep` use `path`
  (and an absolute `Glob` pattern). A tool call with no target is allowed.
- The grant file is read on every tool call, so **revocation takes effect on the
  next call** — no reinstall needed.
- Any internal error exits 2. A crash never allows a call.

## 5. Remote vaults (2nd Brain Studio)

A 2nd Brain instance serves its vaults over HTTP. An agent token carries a
scope — either `*` or a list of vault ids — and sees nothing outside it. The
browser session is admin-only; agent machines use the token as a Bearer
credential and never get a cookie.

Logging in takes two values and stores one file:

```bash
login.sh https://brain.example.com brain_agent_xxx
```

That verifies the pair against `GET /api/vaults` first, then writes
`~/.config/brain-vaults/config.json` (`{url, token}`) at mode 0600. The file is
outside every repo, so a token never gets committed. `admin-login.sh` stores
`admin.json` (`{url, adminToken}`) in the same directory, separately.

| Command | Arguments | What it does |
| --- | --- | --- |
| `login.sh` | `<url> <token>` | Verify an agent token by listing, then store it |
| `admin-login.sh` | `<url> <admin-token>` | Verify the admin token against the token list, then store it |
| `remote-list.sh` | — | List reachable vaults as `ID · NAME · SOURCE · UPDATED` |
| `pull.sh` | `<id> [directory]` | Download a vault (default `~/.claude/vault-cache/<id>`) and record hashes in `.vault-meta.json` |
| `push.sh` | `<id>` | Upload local edits from the cache directory |
| `use.sh` | `<repo-root> <id>` | Pull into `<repo>/<id>`, register, grant, install the hook, print status |
| `provision.sh` | `<name> --vaults <id,id\|*>` | Mint an agent token; the plaintext is printed once |

`BRAIN_CONFIG_DIR` and `BRAIN_CACHE_DIR` relocate the two directories.
`BRAIN_URL`, `BRAIN_TOKEN` and `BRAIN_ADMIN_TOKEN` override the stored profiles,
so CI can run without a config file.

Push rules, deliberately conservative:

- A file unchanged since the pull is skipped.
- A file the server changed since the pull is a **conflict**: nothing is written
  for it, the other files still go, and the command exits 2 listing the
  conflicts. Pull again, merge by hand, push again.
- A file deleted locally is **not** deleted remotely; v1 does not push deletes.
- The cache is what push reads. Pull into the default directory before editing
  and pushing.

Admin flow on the server host: the first boot writes `/data/admin-token` at mode
0600 (or set `BRAIN_ADMIN_TOKEN` in the environment, which wins and is not
persisted). On that machine run `admin-login.sh` once, then `provision.sh` per
agent. Revoking a token takes effect on the agent's next request. Rotating the
admin token invalidates existing browser sessions but leaves agent tokens alone.

This is a **2nd Brain token**; it is not a Coolify token. Never paste a token
into a repo, a `.env` inside a repo, or a commit message.

## 6. Limits — this is a guardrail, not a security boundary

The hook only filters the matched tools (`Read|Write|Edit|Glob|Grep`). An agent
that can run `Bash` can still read a vault with `cat`, and can rewrite its own
`.claude/settings.json` or `.claude/vaults.json` through a shell.

For hard isolation, use the operating system, not this hook:

- Make the vault read-only for the agent's user: `chmod -R a-w /srv/vaults/my-channel`.
- Or mount it read-only, e.g. a read-only bind mount in a container:
  `-v /srv/vaults/my-channel:/vault/my-channel:ro`.
- Or run the agent as a separate OS user that has no filesystem access to the
  vault at all, and expose only copies through a directory it owns.

Treat the allowlist as a mistake-preventer for well-behaved tool calls, and the
OS-level control as the actual boundary.

## 7. Notes

- Hook changes apply to **new sessions**; a running session keeps the hooks it
  started with.
- `test.sh` is the self-check. It creates its own temp registry, vault and repo,
  and proves the allow, deny, prefix-sibling, symlink, guard-file and revocation
  cases plus install-hook idempotence.
