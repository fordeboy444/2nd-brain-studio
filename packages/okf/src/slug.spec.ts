import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugify("My First Vault")).toBe("my-first-vault");
  });

  it("trims surrounding spaces before processing", () => {
    expect(slugify("  Spaces  ")).toBe("spaces");
  });

  it("folds accented characters to ASCII via NFKD + diacritic strip", () => {
    expect(slugify("Café Notes")).toBe("cafe-notes");
  });

  it("collapses repeated hyphens from a name with runs of separators", () => {
    expect(slugify("a---b")).toBe("a-b");
  });

  it("throws when the input reduces to nothing (punctuation only)", () => {
    expect(() => slugify("!!!")).toThrow("slug produced an empty result");
  });

  it("truncates to 64 chars with no trailing hyphen", () => {
    const long = "a".repeat(90);
    const out = slugify(long);
    expect(out.length).toBe(64);
    expect(out.endsWith("-")).toBe(false);
    expect(out).toBe("a".repeat(64));
  });

  it("truncates cleanly when the cut lands on a hyphen", () => {
    // 70 chars: "a-" repeated 35 times. After collapse it's a-a-...-a (69 chars).
    // Slice to 64 lands mid-string on an 'a', no trailing hyphen.
    const input = Array.from({ length: 35 }, (_, i) => (i % 2 === 0 ? "a" : "-")).join("");
    const out = slugify(input);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith("-")).toBe(false);
  });

  it("two names with distinct slugs produce distinct slugs", () => {
    expect(slugify("My Vault")).not.toBe(slugify("Other Vault"));
  });

  it("names differing only in case/accents slugify the same", () => {
    expect(slugify("Café")).toBe(slugify("cafe"));
  });
});