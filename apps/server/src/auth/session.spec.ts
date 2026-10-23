import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readSession, SESSION_TTL_MS, signSession } from "./session.js";

/**
 * The signed cookie: a round trip passes, and every way of tampering fails
 * closed. `readSession` never throws, so a malformed client value is a false,
 * not a 500.
 */

const KEY = createHash("sha256").update("test-key", "utf8").digest();

describe("signSession / readSession", () => {
  it("round-trips a fresh value", () => {
    const value = signSession(KEY);
    expect(value).toContain(".");
    expect(readSession(value, KEY)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const value = signSession(KEY);
    const [payload, signature] = value.split(".");
    const flipped = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;
    expect(readSession(`${payload}.${flipped}`, KEY)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const value = signSession(KEY);
    const [, signature] = value.split(".");
    // A distinct expiry, so this cannot accidentally re-encode to the very
    // payload the signature was minted over when both calls land in one ms.
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", exp: Date.now() + SESSION_TTL_MS * 2 }),
      "utf8",
    ).toString("base64url");
    expect(readSession(`${forged}.${signature}`, KEY)).toBe(false);
  });

  it("rejects an expired payload", () => {
    const value = signSession(KEY, Date.now() - SESSION_TTL_MS - 1);
    expect(readSession(value, KEY)).toBe(false);
  });

  it("rejects a value signed with a different key", () => {
    const other = createHash("sha256").update("other-key", "utf8").digest();
    expect(readSession(signSession(other), KEY)).toBe(false);
  });

  it("rejects a null key, a missing value and malformed shapes without throwing", () => {
    expect(readSession(signSession(KEY), null)).toBe(false);
    expect(readSession(undefined, KEY)).toBe(false);
    expect(readSession("", KEY)).toBe(false);
    expect(readSession("no-dot", KEY)).toBe(false);
    expect(readSession("a.b.c", KEY)).toBe(false);
    expect(readSession(".signature", KEY)).toBe(false);
  });
});
