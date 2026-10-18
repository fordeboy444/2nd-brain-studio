import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cookie module reads `config.youtubeCookiePath` at call time, so every case
 * points YOUTUBE_COOKIE_PATH at a temporary directory and reloads the module
 * graph. No test touches the real /data volume.
 */

const ORIGINAL_COOKIE_PATH = process.env.YOUTUBE_COOKIE_PATH;

let root = "";
let cookiePath = "";

async function reload(): Promise<typeof import("./cookie.js")> {
  vi.resetModules();
  return import("./cookie.js");
}

const VALID_BODY = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc123",
  ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\ten-US",
  "",
].join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cookie-spec-"));
  cookiePath = join(root, "youtube-cookie.txt");
  process.env.YOUTUBE_COOKIE_PATH = cookiePath;
});

afterEach(async () => {
  if (ORIGINAL_COOKIE_PATH === undefined) {
    delete process.env.YOUTUBE_COOKIE_PATH;
  } else {
    process.env.YOUTUBE_COOKIE_PATH = ORIGINAL_COOKIE_PATH;
  }
  await rm(root, { recursive: true, force: true });
});

describe("validateNetscapeCookie", () => {
  it("accepts a header, comments and cookie lines including the HttpOnly prefix", async () => {
    const { validateNetscapeCookie } = await reload();
    const body = [
      "# Netscape HTTP Cookie File",
      "# a comment",
      "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tHSID\thidden",
      ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\ten-US",
      "",
    ].join("\n");

    expect(validateNetscapeCookie(body)).toEqual({ ok: true });
  });

  it("rejects an empty or whitespace-only body as empty", async () => {
    const { validateNetscapeCookie } = await reload();
    expect(validateNetscapeCookie("")).toEqual({ ok: false, reason: "empty" });
    expect(validateNetscapeCookie("  \n\t\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a body over 1 MiB as too_large", async () => {
    const { validateNetscapeCookie } = await reload();
    const oversized = `.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\t${"a".repeat(1024 * 1024)}`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(1024 * 1024);
    expect(validateNetscapeCookie(oversized)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects a line that does not have exactly seven tab-separated fields", async () => {
    const { validateNetscapeCookie } = await reload();
    expect(validateNetscapeCookie(".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID")).toEqual({
      ok: false,
      reason: "bad_line",
    });
    expect(validateNetscapeCookie("one\ttwo\tthree")).toEqual({
      ok: false,
      reason: "bad_line",
    });
  });

  it("rejects non-boolean columns and a non-integer expiry", async () => {
    const { validateNetscapeCookie } = await reload();
    expect(validateNetscapeCookie(".youtube.com\tYES\t/\tTRUE\t1893456000\tSID\tv")).toEqual({
      ok: false,
      reason: "bad_line",
    });
    expect(validateNetscapeCookie(".youtube.com\tTRUE\t/\tTRUE\tsoon\tSID\tv")).toEqual({
      ok: false,
      reason: "bad_line",
    });
  });

  it("rejects a body with comments but no cookie line", async () => {
    const { validateNetscapeCookie } = await reload();
    expect(validateNetscapeCookie("# Netscape HTTP Cookie File\n")).toEqual({
      ok: false,
      reason: "bad_line",
    });
  });
});

describe("cookieHeaderToNetscape", () => {
  // yt-dlp refuses a cookie file without this first line.
  const HEADER = "# Netscape HTTP Cookie File";

  it("converts one pair into one fixed seven-field line", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("SID=abc123")).toEqual({
      ok: true,
      text: `${HEADER}\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc123`,
    });
  });

  it("puts the Netscape header on the first line", async () => {
    const { cookieHeaderToNetscape } = await reload();
    const converted = cookieHeaderToNetscape("SID=abc123; PREF=en-US");
    expect(converted.ok).toBe(true);
    expect(converted.text?.split("\n")[0]).toBe(HEADER);
  });

  it("keeps several pairs in input order", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("SID=x; PREF=en-US;")).toEqual({
      ok: true,
      text: [
        HEADER,
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx",
        ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\ten-US",
      ].join("\n"),
    });
  });

  it("splits on the first = only, so a value may contain =", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("SID=a=b=c")).toEqual({
      ok: true,
      text: `${HEADER}\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\ta=b=c`,
    });
  });

  it("trims the space around the pair, the name and the value", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("   SID = abc  ;  PREF = en-US  ")).toEqual({
      ok: true,
      text: [
        HEADER,
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc",
        ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\ten-US",
      ].join("\n"),
    });
  });

  it("skips empty and doubled separators", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("SID=x;;PREF=en;;")).toEqual({
      ok: true,
      text: [
        HEADER,
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx",
        ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\ten",
      ].join("\n"),
    });
  });

  it("allows an empty value", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("SID=")).toEqual({
      ok: true,
      text: `${HEADER}\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t`,
    });
  });

  it("refuses empty and whitespace-only input as empty", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("")).toEqual({ ok: false, reason: "empty" });
    expect(cookieHeaderToNetscape("  \n\t ")).toEqual({ ok: false, reason: "empty" });
    expect(cookieHeaderToNetscape(" ; ;; ")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a segment without = and a segment starting with = as bad_pair", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("not-a-pair")).toEqual({ ok: false, reason: "bad_pair" });
    expect(cookieHeaderToNetscape("SID=x; not-a-pair")).toEqual({
      ok: false,
      reason: "bad_pair",
    });
    expect(cookieHeaderToNetscape("SID=x; =value")).toEqual({ ok: false, reason: "bad_pair" });
  });

  it("refuses an empty name", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("  = value")).toEqual({ ok: false, reason: "bad_pair" });
  });

  it("refuses a tab in a name", async () => {
    const { cookieHeaderToNetscape } = await reload();
    expect(cookieHeaderToNetscape("SID\tX=abc")).toEqual({ ok: false, reason: "bad_pair" });
  });

  it("refuses a tab, CR or LF in a value", async () => {
    const { cookieHeaderToNetscape } = await reload();
    for (const value of ["ab\tc", "ab\rc", "ab\nc"]) {
      expect(cookieHeaderToNetscape(`SID=${value}`)).toEqual({
        ok: false,
        reason: "bad_pair",
      });
    }
  });

  it("produces a body the existing validator accepts", async () => {
    const { cookieHeaderToNetscape, validateNetscapeCookie } = await reload();
    const converted = cookieHeaderToNetscape("SID=abc123; PREF=en-US; HSID=hidden");
    expect(converted.ok).toBe(true);
    expect(converted.text?.split("\n")[0]).toBe(HEADER);
    expect(validateNetscapeCookie(converted.text ?? "")).toEqual({ ok: true });
  });
});

describe("writeYoutubeCookie", () => {
  it("stores a valid body byte-identically at mode 0600", async () => {
    const { writeYoutubeCookie } = await reload();

    await writeYoutubeCookie(VALID_BODY);

    expect(await readFile(cookiePath, "utf8")).toBe(VALID_BODY);
    const info = await stat(cookiePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("adds exactly one trailing newline when the upload lacks one", async () => {
    const { writeYoutubeCookie } = await reload();
    const body = ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc";
    await writeYoutubeCookie(body);
    expect(await readFile(cookiePath, "utf8")).toBe(`${body}\n`);
  });

  it("leaves one complete body at mode 0600 after concurrent uploads", async () => {
    const { writeYoutubeCookie } = await reload();
    const bodyA = ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\talpha";
    const bodyB = ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tbravo";

    await Promise.all([writeYoutubeCookie(bodyA), writeYoutubeCookie(bodyB)]);

    const stored = await readFile(cookiePath, "utf8");
    expect([`${bodyA}\n`, `${bodyB}\n`]).toContain(stored);
    // The rename is the visibility gate: no partial or interleaved content.
    expect(stored.includes("alpha") && stored.includes("bravo")).toBe(false);
    expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
    // No temp sibling survives the pair of renames.
    expect(await readdir(root)).toEqual(["youtube-cookie.txt"]);
  });
});

describe("status and deletion", () => {
  it("reports only existence and mtime, never the body", async () => {
    const { cookieStatus, writeYoutubeCookie } = await reload();

    expect(await cookieStatus()).toEqual({
      hasYoutubeCookie: false,
      youtubeCookieUpdatedAt: null,
    });

    await writeYoutubeCookie(VALID_BODY);
    const status = await cookieStatus();
    expect(status.hasYoutubeCookie).toBe(true);
    expect(Number.isNaN(Date.parse(status.youtubeCookieUpdatedAt ?? ""))).toBe(false);
    expect(Object.keys(status).sort()).toEqual([
      "hasYoutubeCookie",
      "youtubeCookieUpdatedAt",
    ]);
  });

  it("hands yt-dlp the path only while the file exists", async () => {
    const { readYoutubeCookiePath, writeYoutubeCookie } = await reload();

    expect(readYoutubeCookiePath()).toBeUndefined();
    await writeYoutubeCookie(VALID_BODY);
    expect(readYoutubeCookiePath()).toBe(cookiePath);
  });

  it("deletes idempotently: removing an absent file is a success", async () => {
    const { deleteYoutubeCookie, writeYoutubeCookie } = await reload();

    await deleteYoutubeCookie();
    await expect(deleteYoutubeCookie()).resolves.toBeUndefined();

    await writeYoutubeCookie(VALID_BODY);
    await deleteYoutubeCookie();
    await expect(readFile(cookiePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
