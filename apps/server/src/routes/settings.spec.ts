import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * pino is replaced so the redaction case can inspect every argument the upload
 * route logs. The collector holds the actual arguments, not the formatted line,
 * so a secret cannot hide in a serializer or a string interpolation.
 */
const logHarness = vi.hoisted(() => ({ entries: [] as unknown[][] }));

vi.mock("pino", () => {
  const logger = {
    info: (...args: unknown[]) => {
      logHarness.entries.push(args);
    },
    warn: (...args: unknown[]) => {
      logHarness.entries.push(args);
    },
    error: (...args: unknown[]) => {
      logHarness.entries.push(args);
    },
    debug: () => undefined,
  };
  return { default: () => logger };
});

const ORIGINAL_VAULT_ROOT = process.env.VAULT_ROOT;
const ORIGINAL_COOKIE_PATH = process.env.YOUTUBE_COOKIE_PATH;
const ORIGINAL_OLLAMA_KEY = process.env.OLLAMA_API_KEY;
const ORIGINAL_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const ORIGINAL_SUPADATA_KEY = process.env.SUPADATA_API_KEY;

let root = "";
let cookiePath = "";

interface ReloadOptions {
  ollamaKey?: string;
  ollamaBaseUrl?: string;
  supadataKey?: string;
}

async function reload(
  options: ReloadOptions = {},
): Promise<typeof import("./settings.js") & { config: typeof import("../config.js").config }> {
  if (options.ollamaKey === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = options.ollamaKey;
  process.env.OLLAMA_BASE_URL = options.ollamaBaseUrl ?? "https://ollama.test";
  if (options.supadataKey === undefined) delete process.env.SUPADATA_API_KEY;
  else process.env.SUPADATA_API_KEY = options.supadataKey;

  vi.resetModules();
  const routes = await import("./settings.js");
  const { config } = await import("../config.js");
  return { ...routes, config };
}

type Routes = Awaited<ReturnType<typeof reload>>;

const VALID_BODY = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc123",
  ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\ten-US",
  "",
].join("\n");

function upload(
  routes: Routes,
  body: string,
  contentType = "text/plain;charset=UTF-8",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return routes.settings.request("/youtube-cookie", {
    method: "POST",
    headers: { "content-type": contentType, ...extraHeaders },
    body,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-routes-"));
  cookiePath = join(root, "youtube-cookie.txt");
  process.env.VAULT_ROOT = root;
  process.env.YOUTUBE_COOKIE_PATH = cookiePath;
  logHarness.entries.length = 0;
});

afterEach(async () => {
  if (ORIGINAL_VAULT_ROOT === undefined) delete process.env.VAULT_ROOT;
  else process.env.VAULT_ROOT = ORIGINAL_VAULT_ROOT;
  if (ORIGINAL_COOKIE_PATH === undefined) delete process.env.YOUTUBE_COOKIE_PATH;
  else process.env.YOUTUBE_COOKIE_PATH = ORIGINAL_COOKIE_PATH;
  if (ORIGINAL_OLLAMA_KEY === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = ORIGINAL_OLLAMA_KEY;
  if (ORIGINAL_OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL_OLLAMA_BASE_URL;
  if (ORIGINAL_SUPADATA_KEY === undefined) delete process.env.SUPADATA_API_KEY;
  else process.env.SUPADATA_API_KEY = ORIGINAL_SUPADATA_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("POST /api/settings/youtube-cookie", () => {
  it("stores a valid body byte-identically at mode 0600", async () => {
    const routes = await reload();

    const res = await upload(routes, VALID_BODY);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      hasYoutubeCookie: boolean;
      youtubeCookieUpdatedAt: string | null;
    };
    expect(body.hasYoutubeCookie).toBe(true);
    expect(Number.isNaN(Date.parse(body.youtubeCookieUpdatedAt ?? ""))).toBe(false);

    expect(await readFile(cookiePath, "utf8")).toBe(VALID_BODY);
    expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
  });

  it("maps an invalid Netscape body to 400 and writes nothing", async () => {
    const routes = await reload();

    const res = await upload(routes, ".youtube.com\tTRUE\t/\tSID\tabc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_cookie");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a body over 1 MiB to 413 and writes nothing", async () => {
    const routes = await reload();
    const oversized = `.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\t${"a".repeat(1024 * 1024)}`;

    const res = await upload(routes, oversized);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("cookie_too_large");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a JSON content type to 415 and writes nothing", async () => {
    const routes = await reload();

    const res = await upload(routes, JSON.stringify({ cookie: VALID_BODY }), "application/json");
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_media_type");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a cross-origin upload before reading the body", async () => {
    const routes = await reload();

    const res = await upload(routes, VALID_BODY, "text/plain", {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_mismatch");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves one complete body at mode 0600 after two concurrent uploads", async () => {
    const routes = await reload();
    const bodyA = ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\talpha";
    const bodyB = ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tbravo";

    const [first, second] = await Promise.all([
      upload(routes, bodyA),
      upload(routes, bodyB),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const stored = await readFile(cookiePath, "utf8");
    expect([`${bodyA}\n`, `${bodyB}\n`]).toContain(stored);
    expect(stored.includes("alpha") && stored.includes("bravo")).toBe(false);
    expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["youtube-cookie.txt"]);
  });

  it("never echoes the cookie body in the response or in any log argument", async () => {
    const routes = await reload();
    const marker = "MARKER-9f3c1b-do-not-log";
    const body = `.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\t${marker}\n`;

    const res = await upload(routes, body);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(marker);

    expect(logHarness.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(logHarness.entries)).not.toContain(marker);

    // Only the route name, the byte count and the ok flag are logged.
    const first = logHarness.entries[0] ?? [];
    const fields = first[0] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["bytes", "ok", "route"]);
    expect(fields.route).toBe("settings.youtube-cookie");
    expect(fields.ok).toBe(true);
  });
});

describe("POST /api/settings/youtube-cookie/header", () => {
  function pasteHeader(
    routes: Routes,
    body: string,
    contentType = "text/plain;charset=UTF-8",
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return routes.settings.request("/youtube-cookie/header", {
      method: "POST",
      headers: { "content-type": contentType, ...extraHeaders },
      body,
    });
  }

  const CONVERTED =
    ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc123\n" +
    ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\ten-US\n";

  it("converts, validates and stores a multi-pair header at mode 0600", async () => {
    const routes = await reload();

    const res = await pasteHeader(routes, "SID=abc123; PREF=en-US");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await readFile(cookiePath, "utf8")).toBe(CONVERTED);
    expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
    // The write is the atomic temp+rename pair: no sibling survives it.
    expect(await readdir(root)).toEqual(["youtube-cookie.txt"]);
  });

  it("maps a segment without = to 400 invalid_cookie_header and writes nothing", async () => {
    const routes = await reload();

    const res = await pasteHeader(routes, "not-a-pair");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_cookie_header");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps an empty body to 400 and writes nothing", async () => {
    const routes = await reload();

    const res = await pasteHeader(routes, "");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_cookie_header");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a cross-origin paste before reading the body", async () => {
    const routes = await reload();

    const res = await pasteHeader(routes, "SID=abc123", "text/plain", {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_mismatch");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a JSON content type to 415 and writes nothing", async () => {
    const routes = await reload();

    const res = await pasteHeader(routes, JSON.stringify({ header: "SID=abc123" }), "application/json");
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_media_type");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a body over 1 MiB to 413 and writes nothing", async () => {
    const routes = await reload();
    const oversized = `SID=${"a".repeat(1024 * 1024)}`;

    const res = await pasteHeader(routes, oversized);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("cookie_too_large");
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never echoes the pasted header in the response or in any log argument", async () => {
    const routes = await reload();
    const marker = "MARKER-header-9f3c1b-do-not-log";

    const res = await pasteHeader(routes, `SID=${marker}`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(marker);

    // The marker reached the file — the body was processed, not dropped.
    expect(await readFile(cookiePath, "utf8")).toContain(marker);
    expect(JSON.stringify(logHarness.entries)).not.toContain(marker);

    // Only the route name, the byte count and the ok flag are logged.
    const first = logHarness.entries[0] ?? [];
    const fields = first[0] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["bytes", "ok", "route"]);
    expect(fields.route).toBe("settings.youtube-cookie-header");
    expect(fields.ok).toBe(true);
  });
});

describe("GET /api/settings", () => {
  it("returns the non-secret settings and status flags, never a cookie body or key", async () => {
    const routes = await reload();
    await upload(routes, VALID_BODY);

    const res = await routes.settings.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("youtube.com");
    expect(text).not.toContain("Netscape");
    expect(text).not.toContain("abc123");
    expect(text).not.toMatch(/"(key|apiKey|token|password)"/);

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "hasSupadataKey",
      "hasYoutubeCookie",
      "llmConfigured",
      "settings",
      "youtubeCookieUpdatedAt",
    ]);
    expect(body.hasYoutubeCookie).toBe(true);
    expect(body.hasSupadataKey).toBe(false);
    expect(body.llmConfigured).toBe(false);
    expect(body.settings).toEqual({
      llm: {
        model: routes.config.ollamaModel,
        concurrency: 1,
        requestTimeoutMs: 120_000,
        maxRetries: 3,
      },
      fetch: { delayMs: 1_000, concurrency: 2, language: "en" },
      sweep: { enabled: true },
      ui: { theme: "system" },
    });
  });

  it("reports a configured Supadata key and Ollama key without their values", async () => {
    const routes = await reload({
      ollamaKey: "ollama-secret-value",
      supadataKey: "supadata-secret-value",
    });

    const res = await routes.settings.request("/");
    const text = await res.text();
    expect(text).not.toContain("ollama-secret-value");
    expect(text).not.toContain("supadata-secret-value");

    const body = JSON.parse(text) as { hasSupadataKey: boolean; llmConfigured: boolean };
    expect(body.hasSupadataKey).toBe(true);
    expect(body.llmConfigured).toBe(true);
  });
});

describe("PUT /api/settings", () => {
  function put(
    routes: Routes,
    patch: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return routes.settings.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(patch),
    });
  }

  it("merges a valid patch, writes settings.json and returns the status object", async () => {
    const routes = await reload();

    const res = await put(routes, { ui: { theme: "dark" }, fetch: { delayMs: 250 } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      settings: { ui: { theme: string }; fetch: { delayMs: number; language: string } };
    };
    expect(body.settings.ui.theme).toBe("dark");
    expect(body.settings.fetch.delayMs).toBe(250);
    expect(body.settings.fetch.language).toBe("en");

    const stored = JSON.parse(
      await readFile(join(root, "settings.json"), "utf8"),
    ) as { ui: { theme: string } };
    expect(stored.ui.theme).toBe("dark");
  });

  it("rejects concurrency 5 with 400 invalid_body and writes nothing", async () => {
    const routes = await reload();

    const res = await put(routes, { llm: { concurrency: 5 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    await expect(stat(join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("strips an unknown llm.apiKey instead of persisting it", async () => {
    const routes = await reload();

    const res = await put(routes, { llm: { model: "safe-model", apiKey: "SECRET-VALUE" } });
    expect(res.status).toBe(200);

    const stored = await readFile(join(root, "settings.json"), "utf8");
    expect(stored).not.toContain("SECRET-VALUE");
    expect(stored).not.toMatch(/"(key|apiKey|token|password)"/);
    expect((JSON.parse(stored) as { llm: { model: string } }).llm.model).toBe("safe-model");
  });

  it("refuses a cross-origin PUT and writes nothing", async () => {
    const routes = await reload();

    const res = await put(routes, { ui: { theme: "dark" } }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_mismatch");
    await expect(stat(join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("POST /api/settings/test-llm", () => {
  it("returns 400 llm_not_configured with no key and makes no request", async () => {
    const routes = await reload();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await routes.settings.request("/test-llm", { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("llm_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends exactly one bounded request and never echoes the key or upstream body", async () => {
    const routes = await reload({
      ollamaKey: "test-key",
      ollamaBaseUrl: "https://ollama.example",
    });
    // The probe reads the persisted model at call time.
    await routes.settings.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm: { model: "probe-model" } }),
    });
    const fetchMock = vi.fn(async () => new Response("UPSTREAM-SECRET-BODY", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const res = await routes.settings.request("/test-llm", { method: "POST" });
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).not.toContain("test-key");
    expect(text).not.toContain("UPSTREAM-SECRET-BODY");
    const body = JSON.parse(text) as { ok: boolean; latencyMs: number };
    expect(body.ok).toBe(true);
    expect(typeof body.latencyMs).toBe("number");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ollama.example/api/chat");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);

    const payload = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      options: { num_predict: number };
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.model).toBe("probe-model");
    expect(payload.stream).toBe(false);
    expect(payload.options.num_predict).toBe(1);
    expect(payload.messages).toEqual([{ role: "user", content: "Reply with OK." }]);

    // Nothing logged may carry the key either.
    expect(JSON.stringify(logHarness.entries)).not.toContain("test-key");
  });

  it("maps an HTTP failure to {ok:false, reason:http_<status>} without the body", async () => {
    const routes = await reload({ ollamaKey: "test-key" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("UPSTREAM-SECRET-BODY", { status: 500 })),
    );

    const res = await routes.settings.request("/test-llm", { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, reason: "http_500" });
    expect(text).not.toContain("UPSTREAM-SECRET-BODY");
  });

  it("maps a timeout to {ok:false, reason:timeout}", async () => {
    const routes = await reload({ ollamaKey: "test-key" });
    const error = new Error("timed out");
    error.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(error)));

    const res = await routes.settings.request("/test-llm", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "timeout" });
  });

  it("maps a network failure to {ok:false, reason:network}", async () => {
    const routes = await reload({ ollamaKey: "test-key" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("bad connection"))));

    const res = await routes.settings.request("/test-llm", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "network" });
  });
});

describe("DELETE /api/settings/youtube-cookie", () => {
  it("removes the file and is idempotent when it is already absent", async () => {
    const routes = await reload();
    await upload(routes, VALID_BODY);

    const first = await routes.settings.request("/youtube-cookie", { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ hasYoutubeCookie: false });
    await expect(stat(cookiePath)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await routes.settings.request("/youtube-cookie", { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ hasYoutubeCookie: false });
  });
});
