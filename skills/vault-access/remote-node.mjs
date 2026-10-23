#!/usr/bin/env node
/**
 * remote-node.mjs — the 2nd Brain Studio client.
 *
 * Dependency-free ESM using Node's built-in `fetch`. The bearer token is put
 * into a header inside this process, never passed on a command line or through
 * a shell, so it cannot show up in a process listing.
 *
 * Profiles live under `va_brain_config_dir()` at mode 0600:
 *   config.json  {url, token}        — an agent machine
 *   admin.json   {url, adminToken}   — the machine that mints tokens
 *
 * Environment overrides win over the files: BRAIN_URL, BRAIN_TOKEN and
 * BRAIN_ADMIN_TOKEN. `BRAIN_CONFIG_DIR` / `BRAIN_CACHE_DIR` relocate the files
 * and the pull cache (tests use temp dirs).
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "1.0.0";

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for offline tests)                                   */
/* -------------------------------------------------------------------------- */

/** SHA-256, lowercase hex, of a string or raw bytes. */
export function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Decide what `push` may do, with no network involved.
 *
 * - a local file that is gone is skipped: v1 does not push deletes
 * - an unchanged local file is skipped
 * - a changed file whose server hash still equals the recorded base is a put
 * - anything else is a conflict and writes nothing
 */
export function planPush(meta, localFiles, serverHashes) {
  const plan = [];
  const files = meta && typeof meta.files === "object" && meta.files !== null ? meta.files : {};
  for (const [path, recorded] of Object.entries(files)) {
    const local = localFiles[path];
    if (local === undefined || local === null) {
      plan.push({ path, action: "skip", reason: "missing locally; deletes are not pushed" });
      continue;
    }
    if (local === recorded) {
      plan.push({ path, action: "skip", reason: "unchanged" });
      continue;
    }
    const server = serverHashes[path];
    plan.push(
      server === recorded
        ? { path, action: "put" }
        : { path, action: "conflict", reason: "the server copy changed since the pull" },
    );
  }
  return plan;
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

function fail(message, code = 1) {
  process.stderr.write(`remote: ${message}\n`);
  process.exit(code);
}

function configDir() {
  if (process.env.BRAIN_CONFIG_DIR) return process.env.BRAIN_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "brain-vaults");
}

function cacheDir() {
  return process.env.BRAIN_CACHE_DIR ?? join(homedir(), ".claude", "vault-cache");
}

function profileName(raw) {
  if (raw === "config" || raw === "agent") return "agent";
  if (raw === "admin") return "admin";
  fail(`unknown profile "${raw}" (use "config" or "admin")`);
}

function profilePath(profile) {
  return join(configDir(), profile === "admin" ? "admin.json" : "config.json");
}

/** Strip trailing slashes and refuse anything that is not http(s). */
function normaliseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`URL must be http or https: ${raw}`);
  }
  return url.href.replace(/\/+$/, "");
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writePrivateJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies at creation; pin it again so an existing file is
  // narrowed rather than left at whatever it had.
  await chmod(file, 0o600);
}

/** The URL plus the credential for one profile, environment first. */
async function connection(profile) {
  const stored = (await readJson(profilePath(profile))) ?? {};
  const url = process.env.BRAIN_URL ?? stored.url;
  const token =
    profile === "admin"
      ? process.env.BRAIN_ADMIN_TOKEN ?? stored.adminToken
      : process.env.BRAIN_TOKEN ?? stored.token;

  if (!url) fail("no URL configured (run login.sh, or set BRAIN_URL)");
  if (!token) {
    fail(
      profile === "admin"
        ? "no admin token configured (run admin-login.sh, or set BRAIN_ADMIN_TOKEN)"
        : "no token configured (run login.sh, or set BRAIN_TOKEN)",
    );
  }
  return { url: normaliseUrl(url), token };
}

/** One JSON request. A 401 is "the token was rejected"; a non-2xx is the server's message. */
async function api(conn, path, init = {}) {
  const headers = { accept: "application/json", ...(init.headers ?? {}) };
  headers.authorization = `Bearer ${conn.token}`;

  let res;
  try {
    res = await fetch(`${conn.url}${path}`, { ...init, headers });
  } catch (error) {
    fail(`cannot reach ${conn.url}: ${error.message}`);
  }

  if (res.status === 401) fail("token rejected", 2);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") {
        detail = typeof body.message === "string" ? `${body.error}: ${body.message}` : body.error;
      }
    } catch {
      // A non-JSON error body is not worth echoing.
    }
    fail(detail || `HTTP ${res.status} for ${path}`);
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* Subcommands                                                                 */
/* -------------------------------------------------------------------------- */

async function configSet([profile, url, token]) {
  const which = profileName(profile);
  if (!url || !token) fail("usage: config-set <config|admin> <url> <token>");
  const normalised = normaliseUrl(url);
  if (which === "admin") {
    await writePrivateJson(profilePath("admin"), { url: normalised, adminToken: token });
  } else {
    await writePrivateJson(profilePath("agent"), { url: normalised, token });
  }
  process.stdout.write(`${which} profile written to ${profilePath(which)} (0600)\n`);
}

async function configGet([profile, field]) {
  const which = profileName(profile);
  if (!field) fail("usage: config-get <config|admin> <url|token|adminToken>");
  const stored = await readJson(profilePath(which));
  if (stored === null) fail(`no ${which} profile at ${profilePath(which)}`);
  const value = stored[field];
  if (typeof value !== "string" || value === "") fail(`no "${field}" in the ${which} profile`);
  process.stdout.write(`${value}\n`);
}

async function configClear([profile]) {
  const which = profileName(profile);
  await rm(profilePath(which), { force: true });
  process.stdout.write(`cleared ${which} profile\n`);
}

async function list() {
  const conn = await connection("agent");
  const res = await api(conn, "/api/vaults");
  const vaults = await res.json();
  if (!Array.isArray(vaults) || vaults.length === 0) {
    process.stdout.write("(no vaults in scope)\n");
    return;
  }
  const rows = [...vaults].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const vault of rows) {
    process.stdout.write(
      `${vault.id} · ${vault.name} · ${vault.sourceKind ?? "manual"} · ${vault.lastOpenedAt ?? ""}\n`,
    );
  }
}

async function pull([id, dir]) {
  if (!id) fail("usage: pull <vault-id> [directory]");
  const conn = await connection("agent");
  const root = dir ? resolve(dir) : join(cacheDir(), id);
  const files = {};

  async function walk(relDir) {
    const res = await api(
      conn,
      `/api/vaults/${encodeURIComponent(id)}/tree?dir=${encodeURIComponent(relDir)}`,
    );
    const listing = await res.json();
    const entries = Array.isArray(listing.entries) ? listing.entries : [];
    for (const entry of entries) {
      if (entry.isDir) {
        await walk(entry.path);
        continue;
      }
      const fileRes = await api(
        conn,
        `/api/file?vault=${encodeURIComponent(id)}&path=${encodeURIComponent(entry.path)}`,
      );
      const body = await fileRes.json();
      const target = join(root, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body.content, "utf8");
      files[entry.path] = hashText(body.content);
      process.stdout.write(`  ${entry.path}\n`);
    }
  }

  await walk(".");
  await mkdir(root, { recursive: true });
  await writePrivateJson(join(root, ".vault-meta.json"), {
    vaultId: id,
    url: conn.url,
    pulledAt: new Date().toISOString(),
    files,
  });
  process.stdout.write(`pulled ${Object.keys(files).length} file(s) into ${root}\n`);
}

async function push([id]) {
  if (!id) fail("usage: push <vault-id>");
  const conn = await connection("agent");
  const root = join(cacheDir(), id);
  const metaPath = join(root, ".vault-meta.json");
  const meta = await readJson(metaPath);
  if (meta === null) fail(`no ${metaPath}; run pull ${id} first`);

  const paths = Object.keys(meta.files ?? {});
  const localFiles = {};
  for (const rel of paths) {
    try {
      localFiles[rel] = hashText(await readFile(join(root, rel)));
    } catch {
      localFiles[rel] = null;
    }
  }

  // Only a changed file needs the server's current hash.
  const serverHashes = {};
  for (const rel of paths) {
    const local = localFiles[rel];
    if (local === undefined || local === null || local === meta.files[rel]) continue;
    try {
      const res = await api(
        conn,
        `/api/file?vault=${encodeURIComponent(id)}&path=${encodeURIComponent(rel)}`,
      );
      const body = await res.json();
      serverHashes[rel] = body.baseHash;
    } catch {
      serverHashes[rel] = null;
    }
  }

  const plan = planPush(meta, localFiles, serverHashes);
  const conflicts = [];
  for (const step of plan) {
    if (step.action === "skip") {
      if (step.reason !== "unchanged") {
        process.stdout.write(`skip ${step.path} (${step.reason})\n`);
      }
      continue;
    }
    if (step.action === "conflict") {
      conflicts.push(step.path);
      process.stdout.write(`conflict ${step.path} (${step.reason})\n`);
      continue;
    }
    const content = await readFile(join(root, step.path), "utf8");
    const res = await api(conn, "/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vault: id,
        path: step.path,
        content,
        baseHash: serverHashes[step.path],
      }),
    });
    const body = await res.json();
    meta.files[step.path] = body.baseHash;
    process.stdout.write(`pushed ${step.path}\n`);
  }

  await writePrivateJson(metaPath, meta);
  if (conflicts.length > 0) {
    process.stderr.write(
      `remote: ${conflicts.length} conflict(s); pull again before pushing: ${conflicts.join(", ")}\n`,
    );
    process.exit(2);
  }
}

async function provision([name, vaults]) {
  if (!name) fail("usage: provision <name> <vaults|\"*\">");
  const conn = await connection("admin");
  const scope = !vaults || vaults === "*" ? "*" : String(vaults).split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(scope) && scope.length === 0) fail("vault list is empty; use \"*\" for every vault");
  if (typeof scope !== "string" && !Array.isArray(scope)) fail("vault list is empty");

  const res = await api(conn, "/api/admin/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, vaults: scope }),
  });
  const body = await res.json();
  process.stdout.write(
    `minted ${body.entry.id} (${name})\n` +
      `token: ${body.token}\n` +
      "store this now; it is not shown again\n",
  );
}

async function adminList() {
  const conn = await connection("admin");
  const res = await api(conn, "/api/admin/tokens");
  const body = await res.json();
  const tokens = Array.isArray(body.tokens) ? body.tokens : [];
  if (tokens.length === 0) {
    process.stdout.write("(no agent tokens)\n");
    return;
  }
  for (const token of tokens) {
    const scope = token.vaults === "*" ? "*" : token.vaults.join(",");
    process.stdout.write(`${token.id} · ${token.name} · ${scope} · ${token.createdAt}\n`);
  }
}

async function hash([path]) {
  if (!path) fail("usage: hash <path>");
  const bytes = await readFile(path);
  process.stdout.write(`${hashText(bytes)}\n`);
}

async function planPushCommand([metaPath, dir, serverHashesPath]) {
  if (!metaPath || !dir) fail("usage: plan-push <meta-json-path> <dir> [server-hashes-json]");
  const meta = await readJson(metaPath);
  if (meta === null) fail(`cannot read ${metaPath}`);
  const serverHashes =
    serverHashesPath !== undefined ? ((await readJson(serverHashesPath)) ?? {}) : { ...meta.files };

  const localFiles = {};
  for (const rel of Object.keys(meta.files ?? {})) {
    try {
      localFiles[rel] = hashText(await readFile(join(resolve(dir), rel)));
    } catch {
      localFiles[rel] = null;
    }
  }
  for (const step of planPush(meta, localFiles, serverHashes)) {
    process.stdout.write(`${step.action} ${step.path}${step.reason ? ` (${step.reason})` : ""}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

const COMMANDS = {
  "config-set": configSet,
  "config-get": configGet,
  "config-clear": configClear,
  list,
  pull,
  push,
  provision,
  "admin-list": adminList,
  hash,
  "plan-push": planPushCommand,
  version: async () => process.stdout.write(`remote-node.mjs ${VERSION}\n`),
};

async function main(argv) {
  const [command, ...rest] = argv;
  const run = COMMANDS[command];
  if (!run) {
    fail(
      `unknown command "${command ?? ""}" (config-set, config-get, config-clear, list, pull, push, provision, admin-list, hash, plan-push, version)`,
    );
  }
  await run(rest);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
