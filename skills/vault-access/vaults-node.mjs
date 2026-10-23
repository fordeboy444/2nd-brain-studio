#!/usr/bin/env node
// vaults-node.mjs — dependency-free JSON core for the vault-access skill.
//
// Subcommands:
//   registry-list | registry-get <name> | registry-put <name> <abs-path> | registry-del <name>
//   allow-list <repo> | allow-add <repo> <name> | allow-del <repo> <name> | allow-validate <repo>
//   check                                   (PreToolUse hook; reads JSON on stdin)
//   install-hook <repo> <check-command>     (idempotent settings.json merge)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] || "vaults-node.mjs"));

const ALLOWED_MATCHER = "Read|Write|Edit|Glob|Grep";
const GUARD_FILES = [".claude/vaults.json", ".claude/settings.json"];

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function warn(message) {
  process.stderr.write(`vault-access: warning: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`vault-access: ${message}\n`);
  process.exit(1);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function needArgs(args, count, usage) {
  if (args.length !== count) fail(`usage: ${usage}`);
}

function assertName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    fail(`invalid vault name ${JSON.stringify(name)} (allowed: A-Z a-z 0-9 . _ -)`);
  }
}

function canonicalize(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

// Read JSON, treating a missing file as the empty shape. Invalid JSON is
// reported and treated as empty for management subcommands, so a corrupt file
// never crashes a listing.
function readJson(file, options = {}) {
  const { warnOnInvalid = true } = options;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  if (raw.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (warnOnInvalid) warn(`${file}: invalid JSON (${err.message}); treating as empty`);
    return {};
  }
  if (!isPlainObject(parsed)) {
    if (warnOnInvalid) warn(`${file}: top-level JSON value is not an object; treating as empty`);
    return {};
  }
  return parsed;
}

// Atomic write: temp file in the same directory, then rename. Mode 0644 and a
// trailing newline so the file stays hand-editable.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// registry.json
// ---------------------------------------------------------------------------

function registryFile() {
  return process.env.VAULT_ACCESS_REGISTRY || path.join(SCRIPT_DIR, "registry.json");
}

function readRegistry() {
  const data = readJson(registryFile());
  if (!isPlainObject(data.vaults)) data.vaults = {};
  return data;
}

function readRegistryForWrite() {
  const data = readJson(registryFile());
  if (data.vaults === undefined) {
    data.vaults = {};
  } else if (!isPlainObject(data.vaults)) {
    fail(`registry.json: "vaults" must be an object`);
  }
  return data;
}

function cmdRegistryList() {
  const { vaults } = readRegistry();
  for (const name of Object.keys(vaults).sort()) {
    const stored = vaults[name];
    if (typeof stored === "string") process.stdout.write(`${name}\t${stored}\n`);
  }
}

function cmdRegistryGet(args) {
  needArgs(args, 1, "registry-get <name>");
  const { vaults } = readRegistry();
  const stored = vaults[args[0]];
  if (typeof stored !== "string") fail(`vault not registered: ${args[0]}`);
  process.stdout.write(`${stored}\n`);
}

function cmdRegistryPut(args) {
  needArgs(args, 2, "registry-put <name> <absolute-path>");
  const [name, rawPath] = args;
  assertName(name);
  if (!path.isAbsolute(rawPath)) fail(`path must be absolute: ${rawPath}`);
  const canonical = canonicalize(rawPath);
  const data = readRegistryForWrite();
  data.vaults[name] = canonical;
  writeJson(registryFile(), data);
  process.stdout.write(`${canonical}\n`);
}

function cmdRegistryDel(args) {
  needArgs(args, 1, "registry-del <name>");
  const name = args[0];
  assertName(name);
  const data = readRegistryForWrite();
  if (Object.prototype.hasOwnProperty.call(data.vaults, name)) {
    delete data.vaults[name];
    writeJson(registryFile(), data);
  }
}

// ---------------------------------------------------------------------------
// per-repo allowlist: <repo>/.claude/vaults.json
// ---------------------------------------------------------------------------

function allowFile(repoRoot) {
  return path.join(path.resolve(repoRoot), ".claude", "vaults.json");
}

function readAllow(repoRoot) {
  const data = readJson(allowFile(repoRoot));
  if (!Array.isArray(data.vaults)) data.vaults = [];
  return data;
}

function readAllowForWrite(repoRoot) {
  const data = readJson(allowFile(repoRoot));
  if (data.vaults === undefined) {
    data.vaults = [];
  } else if (!Array.isArray(data.vaults)) {
    fail(`${allowFile(repoRoot)}: "vaults" must be an array`);
  }
  return data;
}

function grantedNames(repoRoot) {
  return readAllow(repoRoot).vaults.filter((name) => typeof name === "string");
}

function cmdAllowList(args) {
  needArgs(args, 1, "allow-list <repo-root>");
  for (const name of grantedNames(args[0])) process.stdout.write(`${name}\n`);
}

function cmdAllowAdd(args) {
  needArgs(args, 2, "allow-add <repo-root> <name>");
  const [repoRoot, name] = args;
  assertName(name);
  const data = readAllowForWrite(repoRoot);
  if (!data.vaults.includes(name)) {
    data.vaults.push(name);
    writeJson(allowFile(repoRoot), data);
  }
}

function cmdAllowDel(args) {
  needArgs(args, 2, "allow-del <repo-root> <name>");
  const [repoRoot, name] = args;
  assertName(name);
  const data = readAllowForWrite(repoRoot);
  const next = data.vaults.filter((entry) => entry !== name);
  if (next.length !== data.vaults.length) {
    data.vaults = next;
    writeJson(allowFile(repoRoot), data);
  }
}

function cmdAllowValidate(args) {
  needArgs(args, 1, "allow-validate <repo-root>");
  const repoRoot = args[0];
  const { vaults } = readRegistry();
  for (const name of grantedNames(repoRoot)) {
    const stored = vaults[name];
    if (typeof stored !== "string") {
      process.stdout.write(`${name}\t\tunregistered\n`);
    } else {
      process.stdout.write(`${name}\t${canonicalize(stored)}\tok\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// path resolution for the hook
// ---------------------------------------------------------------------------

// Resolve a candidate target through the filesystem: walk up to the nearest
// existing ancestor, realpath that ancestor, then rejoin the missing tail.
// This makes a Write to a not-yet-created file inside a vault pass, while a
// symlinked component that points outside still fails.
function resolveTarget(baseDir, target) {
  const absolute = path.isAbsolute(target) ? path.normalize(target) : path.resolve(baseDir, target);
  let current = absolute;
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// Exact match or a separator-delimited prefix. Never a bare startsWith: a
// prefix sibling such as "/vaults/name-extra" must not match "/vaults/name".
function isInside(target, root) {
  if (target === root) return true;
  if (root === path.sep) return target.startsWith(path.sep);
  return target.startsWith(root + path.sep);
}

function projectRootFrom(payload) {
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (typeof envRoot === "string" && envRoot.length > 0) return canonicalize(path.resolve(envRoot));
  if (isPlainObject(payload) && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return canonicalize(path.resolve(payload.cwd));
  }
  return canonicalize(process.cwd());
}

// The repo root is always allowed; each granted name adds its registered path.
// Unknown names add nothing. The registry and allowlist are read on every
// invocation, so revoke takes effect on the next tool call.
function allowedRoots(projectRoot) {
  const roots = [projectRoot];
  const registry = readJson(registryFile(), { warnOnInvalid: false });
  const vaults = isPlainObject(registry.vaults) ? registry.vaults : {};
  const allow = readJson(allowFile(projectRoot), { warnOnInvalid: false });
  const names = Array.isArray(allow.vaults) ? allow.vaults : [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const stored = vaults[name];
    if (typeof stored !== "string" || !path.isAbsolute(stored)) continue;
    roots.push(canonicalize(stored));
  }
  return [...new Set(roots)];
}

function candidateTargets(tool, input) {
  const targets = [];
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    if (typeof input.file_path === "string" && input.file_path.length > 0) targets.push(input.file_path);
  } else if (tool === "Glob" || tool === "Grep") {
    if (typeof input.path === "string" && input.path.length > 0) targets.push(input.path);
    if (tool === "Glob" && typeof input.pattern === "string" && input.pattern.startsWith("/")) {
      targets.push(input.pattern);
    }
  }
  return targets;
}

function deny(tool, target, roots, projectRoot, reason) {
  const grantScript = path.join(SCRIPT_DIR, "grant.sh");
  const lines = [
    `vault-access: denied ${tool || "tool"} on ${target || "(no target)"}`,
  ];
  if (reason) lines.push(`vault-access: ${reason}`);
  lines.push("vault-access: allowed roots:");
  for (const root of roots) lines.push(`vault-access:   - ${root}`);
  lines.push(
    `vault-access: grant a vault to this repo with: ${grantScript} ${projectRoot} <vault-name>`,
  );
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(2);
}

// PreToolUse entry point. Reads the hook payload from stdin, exits 0 to allow
// and 2 to deny. Any internal error exits 2: a crash must never allow.
function cmdCheck() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    let payload = {};
    if (raw.trim().length > 0) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        process.stderr.write("vault-access: check: hook payload is not valid JSON; denying\n");
        process.exit(2);
      }
      if (!isPlainObject(parsed)) {
        process.stderr.write("vault-access: check: hook payload is not a JSON object; denying\n");
        process.exit(2);
      }
      payload = parsed;
    }

    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
    const projectRoot = projectRootFrom(payload);
    const roots = allowedRoots(projectRoot);
    const baseDir =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? canonicalize(path.resolve(payload.cwd))
        : projectRoot;

    const targets = candidateTargets(tool, input);
    if (targets.length === 0) process.exit(0);

    const guardFiles = GUARD_FILES.map((rel) => resolveTarget(projectRoot, path.join(projectRoot, rel)));

    for (const rawTarget of targets) {
      const target = resolveTarget(baseDir, rawTarget);
      if ((tool === "Write" || tool === "Edit") && guardFiles.includes(target)) {
        deny(
          tool,
          target,
          roots,
          projectRoot,
          "this file controls vault grants; use add.sh, grant.sh or revoke.sh instead of editing it",
        );
      }
      if (!roots.some((root) => isInside(target, root))) {
        deny(tool, target, roots, projectRoot, "target is outside the repo and every granted vault");
      }
    }
    process.exit(0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`vault-access: check failed internally; denying to be safe: ${message}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// install-hook: idempotent PreToolUse merge into <repo>/.claude/settings.json
// ---------------------------------------------------------------------------

function cmdInstallHook(args) {
  needArgs(args, 2, "install-hook <repo-root> <check-command>");
  const repoRoot = canonicalize(path.resolve(args[0]));
  const checkCommand = args[1];
  if (!path.isAbsolute(checkCommand)) fail(`check command must be absolute: ${checkCommand}`);

  let stat;
  try {
    stat = fs.statSync(repoRoot);
  } catch {
    fail(`repo root does not exist: ${repoRoot}`);
  }
  if (!stat.isDirectory()) fail(`repo root is not a directory: ${repoRoot}`);

  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  let original = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`${settingsPath} is not valid JSON (${err.message}); refusing to overwrite it`);
    }
    if (!isPlainObject(parsed)) fail(`${settingsPath} is not a JSON object; refusing to overwrite it`);
    original = parsed;
  }

  const data = JSON.parse(JSON.stringify(original));
  if (!isPlainObject(data.hooks)) data.hooks = {};
  if (!Array.isArray(data.hooks.PreToolUse)) data.hooks.PreToolUse = [];

  const isOurHook = (hook) =>
    isPlainObject(hook) && typeof hook.command === "string" && hook.command.includes("vault-access/check.sh");
  const hasStaleHook = data.hooks.PreToolUse.some(
    (entry) => isPlainObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isOurHook),
  );
  const desired = { type: "command", command: JSON.stringify(checkCommand), timeout: 10 };

  const merged = [];
  let hostIndex = -1;
  for (const entry of data.hooks.PreToolUse) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      merged.push(entry);
      continue;
    }
    const others = entry.hooks.filter((hook) => !isOurHook(hook));
    if (others.length === entry.hooks.length) {
      merged.push(entry);
      continue;
    }
    if (hostIndex === -1) {
      hostIndex = merged.length;
      merged.push({ ...entry, matcher: ALLOWED_MATCHER, hooks: [...others, desired] });
    } else if (others.length > 0) {
      // A duplicate vault-access entry: keep its other hooks, drop ours.
      merged.push({ ...entry, hooks: others });
    }
  }
  if (hostIndex === -1) {
    merged.push({ matcher: ALLOWED_MATCHER, hooks: [desired] });
  }
  data.hooks.PreToolUse = merged;

  // Only write when the parsed value actually changed, so a second run leaves
  // the file byte-for-byte untouched.
  if (JSON.stringify(original) !== JSON.stringify(data)) {
    writeJson(settingsPath, data);
  }

  process.stdout.write(`${settingsPath}\n`);
  process.stdout.write(`${hasStaleHook ? "hook updated" : "hook installed"}\n`);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

function main() {
  const [subcommand, ...args] = process.argv.slice(2);
  switch (subcommand) {
    case "registry-list":
      return cmdRegistryList();
    case "registry-get":
      return cmdRegistryGet(args);
    case "registry-put":
      return cmdRegistryPut(args);
    case "registry-del":
      return cmdRegistryDel(args);
    case "allow-list":
      return cmdAllowList(args);
    case "allow-add":
      return cmdAllowAdd(args);
    case "allow-del":
      return cmdAllowDel(args);
    case "allow-validate":
      return cmdAllowValidate(args);
    case "check":
      return cmdCheck();
    case "install-hook":
      return cmdInstallHook(args);
    default:
      return fail(
        "usage: vaults-node.mjs <registry-list|registry-get|registry-put|registry-del|allow-list|allow-add|allow-del|allow-validate|check|install-hook> [args...]",
      );
  }
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
