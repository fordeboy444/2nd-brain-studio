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
export type JobStage = "S0" | "S1" | "S1w" | "S2" | "S3" | "S4" | "S5" | "S6" | "done";

/** Every stage a unit can be skipped at; `done` is not a unit stage. */
export type UnitStage = Exclude<JobStage, "done">;

/** One unit that did not produce a capture, as the server records it. */
export interface SkippedUnit {
  slug: string;
  youtubeId?: string;
  stage: UnitStage;
  reason: string;
  detail?: string;
}

/**
 * A job record as the list and detail routes return it.
 *
 * The list route returns the full record; the fields here are the ones the
 * screen reads. `settings` is a client-side narrowing of the full record: only
 * the sweep flag changes what this screen claims about the pipeline. The rest
 * of the settings block is not read here.
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
  settings?: { sweep?: { enabled: boolean } };
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
 * POST /api/jobs/:id/retry — reset and enqueue the failed units (PIPE-12).
 *
 * `onlyFailed` is sent explicitly so the request states its own mode rather
 * than relying on the route's empty-body default. The answer is the record's
 * new status; the units themselves come back through the list and the stream.
 */
export function retryJob(id: string): Promise<{ id: string; status: JobStatus }> {
  return request<{ id: string; status: JobStatus }>(`/jobs/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: JSON.stringify({ onlyFailed: true }),
  });
}

/**
 * The SSE URL for one job. The ONLY place this path is built, so the screen
 * cannot drift from the route and `EventSource` never sees an encoded twice.
 */
export function jobEventsUrl(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/events`;
}

/* -------------------------------------------------------------------------
   Settings and ingest (Phase 3)
   ------------------------------------------------------------------------- */

/**
 * The non-secret settings surface, exactly as `GET /api/settings` names it
 * (`apps/server/src/settings/store.ts`). There is deliberately no key field:
 * secrets live in the environment and never enter this payload.
 */
export interface AppSettings {
  llm: {
    model: string;
    concurrency: number;
    requestTimeoutMs: number;
    maxRetries: number;
  };
  fetch: {
    delayMs: number;
    /** Stored and rendered in Phase 3; the Phase 4 LLM pool is its consumer. */
    concurrency: number;
    language: string;
  };
  sweep: { enabled: boolean };
  ui: { theme: "system" | "light" | "dark" };
}

/** The redacted status object: settings plus presence flags, never a secret. */
export interface SettingsPayload {
  settings: AppSettings;
  hasYoutubeCookie: boolean;
  youtubeCookieUpdatedAt: string | null;
  hasSupadataKey: boolean;
  llmConfigured: boolean;
}

/** A partial settings write. Every field is optional at both levels. */
export interface SettingsPatch {
  llm?: Partial<AppSettings["llm"]>;
  fetch?: Partial<AppSettings["fetch"]>;
  sweep?: Partial<AppSettings["sweep"]>;
  ui?: Partial<AppSettings["ui"]>;
}

/** GET /api/settings — the merged non-secret settings and presence flags. */
export function getSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>("/settings");
}

/** PUT /api/settings — validate, merge and persist the non-secret patch. */
export function putSettings(patch: SettingsPatch): Promise<SettingsPayload> {
  return request<SettingsPayload>("/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/**
 * POST /api/settings/youtube-cookie — the Netscape text as the raw body.
 *
 * `text/plain` is the contract: the route refuses anything else with 415, and a
 * JSON-encoded body would be the one shape that cannot reach the validator.
 * The response carries presence and mtime only; the body never comes back.
 */
export function uploadYoutubeCookie(
  text: string,
): Promise<{ hasYoutubeCookie: true; youtubeCookieUpdatedAt: string | null }> {
  return request<{ hasYoutubeCookie: true; youtubeCookieUpdatedAt: string | null }>(
    "/settings/youtube-cookie",
    {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: text,
    },
  );
}

/**
 * POST /api/settings/youtube-cookie/header — a browser Cookie header as the raw
 * body.
 *
 * The same contract as the file upload: `text/plain` is what the route accepts,
 * and the header is never JSON-encoded (a JSON envelope cannot reach the
 * converter and would be a 415). The answer is the fixed `{ok:true}`; the
 * pasted credential is in no response field.
 */
export function saveYoutubeCookieHeader(text: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/settings/youtube-cookie/header", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: text,
  });
}

/** DELETE /api/settings/youtube-cookie — idempotent; absence is a success. */
export function deleteYoutubeCookie(): Promise<{ hasYoutubeCookie: false }> {
  return request<{ hasYoutubeCookie: false }>("/settings/youtube-cookie", {
    method: "DELETE",
  });
}

/** The manual Ollama probe's answer. A failure is a 200 with `ok: false`. */
export interface TestLlmResult {
  ok: boolean;
  latencyMs?: number;
  reason?: string;
}

/** POST /api/settings/test-llm — one bounded manual probe, never the pipeline. */
export function testLlm(): Promise<TestLlmResult> {
  return request<TestLlmResult>("/settings/test-llm", { method: "POST" });
}

/** The dry-run form: the create form minus `vaultId` (a preview writes nothing). */
export interface PreviewInput {
  kind: JobKind;
  channelUrl?: string;
  url?: string;
  maxVideos?: number;
  dateFrom?: string;
  dateTo?: string;
  minDurationSec?: number;
  language?: string;
}

/** The dry run's answer: the server's numbers, never a browser-side estimate. */
export interface PreviewResult {
  found: number;
  foundAtLeast?: boolean;
  selected: number;
  skipped: SkippedUnit[];
  estimatedCalls: number;
  estimatedMinutes: number;
}

/** The create form. A web job carries no video-only field (the route is strict). */
export interface StartJobInput {
  vaultId: string;
  kind: JobKind;
  channelUrl?: string;
  url?: string;
  maxVideos?: number;
  dateFrom?: string;
  dateTo?: string;
  minDurationSec?: number;
  language?: string;
}

/**
 * The body each kind may send. Kept as a function so the strict web arm cannot
 * receive a video-only field that would turn a valid click into a 400.
 */
function ingestBody(input: PreviewInput | StartJobInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("vaultId" in input) body.vaultId = input.vaultId;
  body.kind = input.kind;
  if (input.kind === "web") {
    // The web arm is `.strict()`: a video-only field here is a 400, not a value
    // the server drops, so none is ever attached.
    body.url = input.url;
  } else {
    body.channelUrl = input.channelUrl;
    body.maxVideos = input.maxVideos;
    if (input.dateFrom !== undefined && input.dateFrom !== "") body.dateFrom = input.dateFrom;
    if (input.dateTo !== undefined && input.dateTo !== "") body.dateTo = input.dateTo;
    if (input.minDurationSec !== undefined) body.minDurationSec = input.minDurationSec;
  }
  if (input.language !== undefined && input.language !== "") body.language = input.language;
  return body;
}

/** POST /api/jobs/preview — enumerate, filter and estimate, writing nothing. */
export function previewJob(input: PreviewInput): Promise<PreviewResult> {
  return request<PreviewResult>("/jobs/preview", {
    method: "POST",
    body: JSON.stringify(ingestBody(input)),
  });
}

/** POST /api/jobs — validate, persist and enqueue one job. */
export function startJob(input: StartJobInput): Promise<{ id: string; status: JobStatus }> {
  return request<{ id: string; status: JobStatus }>("/jobs", {
    method: "POST",
    body: JSON.stringify(ingestBody(input)),
  });
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
  readOnly?: boolean;
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
/* -------------------------------------------------------------------------
   Graph (Phase 5)
   ------------------------------------------------------------------------- */

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  path: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** GET /api/vaults/:id/graph */
export function getGraph(vaultId: string): Promise<GraphResult> {
  return request<GraphResult>(`/vaults/${encodeURIComponent(vaultId)}/graph`);
}

/* -------------------------------------------------------------------------
   Lint and Reindex (Phase 5)
   ------------------------------------------------------------------------- */

/** One lint finding, mirroring the server's `LintFinding` shape exactly
 *  (`packages/okf/src/lint.ts`). The `message` embeds the file path (e.g.
 *  `E2 broken link \`x.md\` in concepts/alpha.md`); the LintModal extracts it. */
export interface LintFinding {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

/** The lint route's response: a pass/fail flag plus the findings, split by
 *  severity, and the count of files scanned. */
export interface LintReport {
  ok: boolean;
  errors: LintFinding[];
  warnings: LintFinding[];
  scanned: number;
}

/** The reindex route's response: the list of vault-relative paths that were
 *  rewritten. Empty when nothing changed. */
export interface ReindexResult {
  ok: boolean;
  updated: string[];
}

/** GET /api/vaults/:id/lint — the server reads every markdown file in the vault
 *  and returns the structured lint report. GET and POST share the same handler
 *  on the server; GET is used here because the call reads state and writes
 *  nothing. */
export function lintVault(vaultId: string): Promise<LintReport> {
  return request<LintReport>(`/vaults/${encodeURIComponent(vaultId)}/lint`);
}

/** POST /api/vaults/:id/reindex — rebuild every index.md and log.md from the
 *  vault's current pages. The server's read-only middleware rejects this with
 *  403 when the instance is secondary (T-05-13 server-side enforcement); the
 *  Browse toolbar disables the button client-side too. */
export function reindexVault(vaultId: string): Promise<ReindexResult> {
  return request<ReindexResult>(`/vaults/${encodeURIComponent(vaultId)}/reindex`, {
    method: "POST",
  });
}
