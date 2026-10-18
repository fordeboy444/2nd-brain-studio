/**
 * The single HTTP boundary for the SPA. Every later screen imports from here
 * and nothing else calls fetch directly. Replaces Baalda's lib/ipc.ts.
 */

export interface VaultStats {
  concepts?: number;
  entities?: number;
  sources?: number;
  raw?: number;
  words?: number;
}

export interface Vault {
  id: string;
  name: string;
  path: string;
  sourceKind: "youtube" | "web" | "manual";
  sourceUrl?: string;
  createdAt: string;
  lastOpenedAt: string;
  stats?: VaultStats;
}

/** Error carrying the HTTP status and the server's `message` field. */
export class ApiError extends Error {
  status: number;
  /** The parsed response body, when it was JSON. Carried so a subclass can
   *  read the fields a specific failure shape adds (see `ConflictError`). */
  body: unknown;
  constructor(status: number, message: string, body: unknown = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A 409 from `PUT /api/file`: the file on disk is not the one the caller read.
 *
 * Distinct type rather than a status check at the call site, because the two
 * things the caller must do with it — keep the user's text and offer them the
 * server's version — depend on fields only this failure carries. It extends
 * `ApiError` so the generic handler (a toast, a message) still works unchanged.
 */
export class ConflictError extends ApiError {
  /** What is on disk now, verbatim. */
  currentContent: string | null;
  /** SHA-256 of what is on disk now; the base hash that would let a write land. */
  currentHash: string | null;
  constructor(message: string, body: unknown = undefined) {
    super(409, message, body);
    this.name = "ConflictError";
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    this.currentContent = typeof b.currentContent === "string" ? b.currentContent : null;
    this.currentHash = typeof b.currentHash === "string" ? b.currentHash : null;
  }
}

/**
 * Internal request helper: prefixes /api, sets content-type on bodies, parses
 * JSON, and on a non-2xx status throws an ApiError carrying the server's
 * `message` field with a generic fallback when the body is not JSON.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  let body: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body && typeof (body as { message: unknown }).message === "string"
        ? (body as { message: string }).message
        : `request failed with status ${res.status}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

/** GET /api/vaults — resolves to the parsed array (empty array, never null). */
export function listVaults(): Promise<Vault[]> {
  return request<Vault[]>("/vaults");
}

/* -------------------------------------------------------------------------
   Jobs (Phase 3)
   ------------------------------------------------------------------------- */

export type JobKind = "youtube" | "web";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
/** `done` is terminal; every other value names the stage to run next. */
export type JobStage = "S0" | "S1" | "S1w" | "done";

/** One unit that did not produce a capture, as the server records it. */
export interface SkippedUnit {
  slug: string;
  youtubeId?: string;
  stage: "S0" | "S1" | "S1w";
  reason: string;
  detail?: string;
}

/**
 * A job record as the list and detail routes return it.
 *
 * The list route returns the full record; the fields here are the ones the
 * screen reads. Settings are deliberately absent: the Jobs screen has no use
 * for them, and the API response is not a place to widen the client's surface.
 */
export interface JobSummary {
  id: string;
  vaultId: string;
  kind: JobKind;
  status: JobStatus;
  stage?: JobStage;
  input: { url: string };
  createdAt: string;
  updatedAt: string;
  progress: { done: number; total: number };
  skipped: SkippedUnit[];
  error: string | null;
  cancelRequested: boolean;
}

export interface JobListQuery {
  vaultId?: string;
  status?: JobStatus;
}

/**
 * GET /api/jobs — every job across every registered vault, newest first.
 * Filters are omitted rather than sent empty, so the route's defaults apply.
 */
export function listJobs(params: JobListQuery = {}): Promise<{ jobs: JobSummary[] }> {
  const q = new URLSearchParams();
  if (params.vaultId !== undefined && params.vaultId !== "") q.set("vaultId", params.vaultId);
  if (params.status !== undefined) q.set("status", params.status);
  const suffix = q.toString();
  return request<{ jobs: JobSummary[] }>(`/jobs${suffix === "" ? "" : `?${suffix}`}`);
}

/** GET /api/jobs/:id — one job record. */
export function getJob(id: string): Promise<JobSummary> {
  return request<JobSummary>(`/jobs/${encodeURIComponent(id)}`);
}

/** DELETE /api/jobs/:id — idempotent cancel; 202 with the current status. */
export function cancelJob(id: string): Promise<{ id: string; status: JobStatus }> {
  return request<{ id: string; status: JobStatus }>(`/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * The SSE URL for one job. The ONLY place this path is built, so the screen
 * cannot drift from the route and `EventSource` never sees an encoded twice.
 */
export function jobEventsUrl(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/events`;
}

/** POST /api/vaults — creates a vault; name is trimmed. Resolves to the record. */
export function createVault(name: string): Promise<Vault> {
  return request<Vault>("/vaults", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });
}

export interface HealthPayload {
  ok: boolean;
  status: "healthy" | "degraded";
  service: string;
  version: string;
  uptimeSec: number;
  time: string;
}

/** GET /api/health — the boot/status probe. Resolves to the parsed payload. */
export function getHealth(): Promise<HealthPayload> {
  return request<HealthPayload>("/health");
}

/** DELETE /api/vaults/:id — the typed-name confirmation. Body key `confirmName`
 *  must match the server's route exactly, or every delete is a 400. */
export function deleteVault(
  vaultId: string,
  confirmName: string,
): Promise<{ deleted: boolean; id: string }> {
  return request<{ deleted: boolean; id: string }>(`/vaults/${encodeURIComponent(vaultId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmName }),
  });
}

/**
 * One entry of one directory level, mirroring the server's shape exactly
 * (`apps/server/src/vaults/fsTree.ts`). `id` and `path` are both the
 * vault-relative path, so nothing here ever holds a host path.
 */
export interface TreeEntry {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  /** Always false from the endpoint — the tree is one level, fetched on expand. */
  childrenLoaded: boolean;
  /** `stat.mtimeMs` for files; absent for directories. Never rendered raw. */
  modified?: number;
}

export interface TreeListing {
  /** The directory the listing is for, vault-relative (`.` for the root). */
  dir: string;
  entries: TreeEntry[];
}

/**
 * GET /api/vaults/:id/tree?dir= — exactly one directory level (VAULT-03).
 *
 * `dir` is omitted for the root: the endpoint's own default is `.`, and sending
 * an empty value would be a jail rejection rather than a root listing.
 */
export function listTree(vaultId: string, dir?: string): Promise<TreeListing> {
  const q = new URLSearchParams({ dir: dir && dir.length > 0 ? dir : "." });
  return request<TreeListing>(`/vaults/${encodeURIComponent(vaultId)}/tree?${q.toString()}`);
}

export interface FileRead {
  path: string;
  content: string;
  /** SHA-256 of the raw bytes the server read — the ONLY hash a save may send. */
  baseHash: string;
}

/** GET /api/file?vault=&path= — the read half of the hash-guarded pair. */
export function readFile(vaultId: string, path: string): Promise<FileRead> {
  const q = new URLSearchParams({ vault: vaultId, path });
  return request<FileRead>(`/file?${q.toString()}`);
}

/**
 * PUT /api/file — the write half of the hash-guarded pair (VAULT-05).
 *
 * `baseHash` is the hash the file was READ with, never one computed in the
 * browser: a client-computed hash would agree with the server always, and the
 * conflict check would be unfalsifiable. `null` is the create form, and only
 * for a path that does not exist yet (the server answers 409 otherwise).
 *
 * A 409 is rethrown as a `ConflictError` carrying both the on-disk content and
 * its hash, so the caller branches on the type without reading a status code.
 */
export async function writeFile(
  vaultId: string,
  path: string,
  content: string,
  baseHash: string | null,
): Promise<{ path: string; baseHash: string }> {
  try {
    return await request<{ path: string; baseHash: string }>("/file", {
      method: "PUT",
      body: JSON.stringify({ vault: vaultId, path, content, baseHash }),
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      throw new ConflictError(e.message, e.body);
    }
    throw e;
  }
}