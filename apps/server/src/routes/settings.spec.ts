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

let root = "";
let cookiePath = "";

async function reload(): Promise<typeof import("./settings.js")> {
  vi.resetModules();
  return import("./settings.js");
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

describe("GET /api/settings", () => {
  it("returns only the cookie existence and timestamp, never the body", async () => {
    const routes = await reload();
    await upload(routes, VALID_BODY);

    const res = await routes.settings.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("youtube.com");
    expect(text).not.toContain("Netscape");
    expect(text).not.toContain("abc123");

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "hasYoutubeCookie",
      "youtubeCookieUpdatedAt",
    ]);
    expect(body.hasYoutubeCookie).toBe(true);
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
