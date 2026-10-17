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
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/** GET /api/vaults — resolves to the parsed array (empty array, never null). */
export function listVaults(): Promise<Vault[]> {
  return request<Vault[]>("/vaults");
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