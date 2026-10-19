import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { slugify } from "@2nd-brain/okf";
import { config } from "../config.js";
import { scaffoldVault } from "./scaffold.js";

/**
 * The vault registry: `${config.vaultRoot}/vaults.json`, shaped
 * `{version: 1, vaults: []}` per idea.md L216-226. Each entry has
 * `{id, name, path, sourceKind, sourceUrl, createdAt, lastOpenedAt, stats}` and
 * `id === path === slugify(name)` (D-04). Paths are relative to vaultRoot so
 * the volume is portable.
 */

export interface VaultStats {
  concepts?: number;
  entities?: number;
  sources?: number;
  raw?: number;
  words?: number;
}

export interface VaultEntry {
  id: string;
  name: string;
  path: string;
  sourceKind: "youtube" | "web" | "manual";
  sourceUrl?: string;
  createdAt: string;
  lastOpenedAt: string;
  stats?: VaultStats;
}

export interface Registry {
  version: 1;
  vaults: VaultEntry[];
}

const REGISTRY_PATH = (): string => join(config.vaultRoot, "vaults.json");

/**
 * A fresh empty envelope. Never store a mutable array on a shared constant:
 * `createVault` pushes into whatever `readRegistry` returned, so a shared
 * empty array makes every later invalid-shape read report an entry that was
 * never written to disk.
 */
const emptyRegistry = (): Registry => ({ version: 1, vaults: [] });

const TMP_PREFIX = ".vaults.json.tmp-";

/**
 * Serializes every read-modify-write cycle on the registry.
 *
 * `writeRegistryAtomic` makes each individual write atomic, but atomicity is
 * not isolation: two callers that both read the registry, each mutate their own
 * copy, and then both write produces a lost update — the last writer wins and
 * the other vault disappears from the file while its directory stays on disk.
 * The temp-name collision is a second symptom of the same overlap.
 *
 * The process model is one container with one in-process job runner, so a
 * module-level promise chain is enough. A second instance serves read-only.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive after a rejection so one failure cannot wedge it.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let tmpCounter = 0;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Read the registry. Returns the empty envelope when the file is absent.
 *
 * A file that parses but has an unsupported shape is NOT treated as absent: the
 * next create/delete would write that empty envelope back and silently erase
 * every existing entry. Fail loudly instead, and let the route answer 500.
 */
export async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(REGISTRY_PATH(), "utf8");
    // Malformed JSON is the same failure as a wrong shape: a hand-edited or
    // truncated file. Give it the typed code too, so the routes answer their
    // fixed `registry_invalid` JSON instead of a generic plain-text 500. This
    // catch must stay separate — a `SyntaxError` carries no `code`, so the
    // outer catch would rethrow it untyped.
    let parsed: Registry;
    try {
      parsed = JSON.parse(raw) as Registry;
    } catch {
      const err = new Error("vaults.json is not valid JSON");
      (err as Error & { code?: string }).code = "registry_invalid";
      throw err;
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.vaults)) {
      const err = new Error("vaults.json has an unsupported shape");
      (err as Error & { code?: string }).code = "registry_invalid";
      throw err;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry();
    }
    throw err;
  }
}

/** Write the registry atomically: temp file in the same dir, then rename. */
export async function writeRegistryAtomic(registry: Registry): Promise<void> {
  const target = REGISTRY_PATH();
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  // The counter disambiguates two writes inside the same millisecond; the pid
  // separates two processes. Without both, the second rename finds no source.
  const tmp = join(dir, `${TMP_PREFIX}${process.pid}-${Date.now()}-${tmpCounter++}`);
  await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

/** Resolve the absolute directory path for a vault id. */
export function vaultDirPath(id: string): string {
  return resolve(config.vaultRoot, id);
}

/** List vaults ordered by lastOpenedAt desc, ties broken by name asc. */
export async function listVaults(): Promise<VaultEntry[]> {
  const reg = await readRegistry();
  const sorted = [...reg.vaults].sort((a, b) => {
    const t = b.lastOpenedAt.localeCompare(a.lastOpenedAt);
    if (t !== 0) return t;
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

export interface CreateVaultInput {
  name: string;
  sourceKind?: VaultEntry["sourceKind"];
  sourceUrl?: string;
}

/**
 * Create a vault: slugify the name, refuse a colliding path, scaffold the
 * directory, append the registry entry, and return it. Errors name the vault,
 * never the host path.
 */
export async function createVault(input: CreateVaultInput): Promise<VaultEntry> {
  const name = input.name.trim();
  if (name === "") {
    throw new Error("vault name must not be empty");
  }
  let slug: string;
  try {
    slug = slugify(name);
  } catch {
    // A name made only of non-Latin characters or punctuation reduces to an
    // empty slug. That is a user input error, not a server fault: name the
    // requirement so the user knows what to change, and let the route answer
    // 400 instead of forwarding the empty-slug exception as a 500.
    const err = new Error(
      "A vault name must contain at least one Latin letter or digit.",
    );
    (err as Error & { code?: string }).code = "invalid_name";
    throw err;
  }

  return withRegistryLock(async () => {
    const reg = await readRegistry();
    const existing = reg.vaults.find((v) => v.path === slug);
    if (existing) {
      // Names the vault (by name), never the disk path.
      const err = new Error(
        `A vault named "${existing.name}" already exists with the same slug "${slug}". Choose a different name.`,
      );
      (err as Error & { code?: string }).code = "slug_collision";
      throw err;
    }

    const dir = vaultDirPath(slug);
    // scaffoldVault refuses a non-empty directory (D-03) and names the vault
    // in its own error. We wrap a collision here before touching the disk.
    await scaffoldVault(dir);

    const entry: VaultEntry = {
      id: slug,
      name,
      path: slug,
      sourceKind: input.sourceKind ?? "manual",
      sourceUrl: input.sourceUrl,
      createdAt: nowIso(),
      lastOpenedAt: nowIso(),
      stats: undefined,
    };

    reg.vaults.push(entry);
    await writeRegistryAtomic(reg);
    return entry;
  });
}

/** Hard-delete a vault's directory and remove its registry entry. */
export async function deleteVault(id: string): Promise<void> {
  return withRegistryLock(async () => {
    const reg = await readRegistry();
    const idx = reg.vaults.findIndex((v) => v.id === id);
    if (idx === -1) {
      const err = new Error(`No vault with id "${id}" is registered.`);
      (err as Error & { code?: string }).code = "not_found";
      throw err;
    }
    const dir = vaultDirPath(id);
    // Recursive remove of the vault directory. The vault is gone for real (D-06).
    await rm(dir, { recursive: true, force: true });
    reg.vaults.splice(idx, 1);
    await writeRegistryAtomic(reg);
  });
}

/** Stamp lastOpenedAt on a vault. */
export async function touchVault(id: string): Promise<void> {
  return withRegistryLock(async () => {
    const reg = await readRegistry();
    const entry = reg.vaults.find((v) => v.id === id);
    if (!entry) {
      const err = new Error(`No vault with id "${id}" is registered.`);
      (err as Error & { code?: string }).code = "not_found";
      throw err;
    }
    entry.lastOpenedAt = nowIso();
    await writeRegistryAtomic(reg);
  });
}