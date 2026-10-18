import { describe, expect, it } from "vitest";
import {
  extractLinks,
  isExternalTarget,
  linkTarget,
  resolveBundlePath,
  stripCode,
} from "./links.js";

describe("stripCode", () => {
  it("removes a link inside a fenced block", () => {
    const text = "Before\n```\n[hidden](missing.md)\n```\nAfter\n";
    expect(stripCode(text)).toBe("Before\n\nAfter\n");
  });

  it("removes a link inside an inline-code span", () => {
    const text = "Keep [real](real.md) but drop `[hidden](missing.md)`.\n";
    expect(stripCode(text)).toBe("Keep [real](real.md) but drop .\n");
  });

  it("treats a shorter backtick run inside a fence as content, not a closer", () => {
    // The inner run has two backticks, so the three-backtick fence closes only
    // at the final marker and the link inside is removed with the block.
    const text = "```\n``\n[hidden](missing.md)\n```\n";
    const stripped = stripCode(text);
    expect(stripped).not.toContain("hidden");
    expect(stripped).toBe("\n");
  });
});

describe("extractLinks", () => {
  it("returns the target without the surrounding markdown syntax", () => {
    expect(extractLinks("See [Alpha](alpha.md).\n")).toEqual(["alpha.md"]);
  });

  it("returns two entries for two links on one line", () => {
    expect(extractLinks("[A](a.md) then [B](b.md)\n")).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("keeps a title and a fragment in the capture for linkTarget to reduce", () => {
    expect(extractLinks('[A](a.md "Title") [B](b.md#part)\n')).toEqual([
      'a.md "Title"',
      "b.md#part",
    ]);
  });
});

describe("isExternalTarget", () => {
  it("skips the four reference schemes", () => {
    for (const link of [
      "http://example.com",
      "https://example.com",
      "mailto:someone@example.com",
      "#local-anchor",
    ]) {
      expect(isExternalTarget(link), link).toBe(true);
    }
  });

  it("keeps a local path whose stem begins with http", () => {
    expect(isExternalTarget("http-request-extensibility.md")).toBe(false);
  });
});

describe("linkTarget", () => {
  it("drops an optional title after whitespace", () => {
    expect(linkTarget('x.md "A Title"')).toBe("x.md");
  });

  it("drops a fragment", () => {
    expect(linkTarget("x.md#section")).toBe("x.md");
  });

  it("returns empty for every external form", () => {
    for (const link of [
      "https://example.com",
      "http://example.com",
      "mailto:a@example.com",
      "#anchor",
    ]) {
      expect(linkTarget(link), link).toBe("");
    }
  });

  it("keeps a local target whose stem begins with http", () => {
    expect(linkTarget("http-request-extensibility.md#scope")).toBe(
      "http-request-extensibility.md",
    );
  });
});

describe("resolveBundlePath", () => {
  it("resolves a sibling and a parent-directory target", () => {
    expect(resolveBundlePath("concepts/a.md", "./x.md")).toBe("concepts/x.md");
    expect(resolveBundlePath("concepts/a.md", "../sources/x.md")).toBe(
      "sources/x.md",
    );
  });

  it("resolves a two-level climb from a nested page", () => {
    expect(
      resolveBundlePath("entities/tools/tool-a.md", "../../sources/x.md"),
    ).toBe("sources/x.md");
  });

  it("normalizes a nested path with internal parent segments", () => {
    expect(resolveBundlePath("concepts/a.md", "a/b/../../c.md")).toBe(
      "concepts/c.md",
    );
  });

  it("returns null for an absolute target (T-02-03)", () => {
    expect(resolveBundlePath("concepts/a.md", "/etc/passwd")).toBeNull();
  });

  it("returns null for a climb above the bundle root (T-02-03)", () => {
    expect(resolveBundlePath("a.md", "../../../x.md")).toBeNull();
    expect(resolveBundlePath("concepts/a.md", "../../../x.md")).toBeNull();
  });

  it("returns null for a target containing a backslash", () => {
    expect(resolveBundlePath("concepts/a.md", "..\\x.md")).toBeNull();
  });

  it("returns a directory path with no trailing slash", () => {
    expect(resolveBundlePath("docs/x.md", "../tools/")).toBe("tools");
  });

  it("resolves a target that climbs to the bundle root (WR-05)", () => {
    expect(resolveBundlePath("concepts/a.md", "../")).toBe("");
    expect(resolveBundlePath("entities/tools/x.md", "../../")).toBe("");
  });
});

describe("adversarial input (T-02-04)", () => {
  const body = `[link](x.md)\n\`\`\`\n${"a".repeat(1024 * 1024)}`;

  it("completes stripCode over a 1 MiB body with no closing fence", () => {
    expect(typeof stripCode(body)).toBe("string");
  });

  it("completes extractLinks over the same body", () => {
    expect(extractLinks(body)).toEqual(["x.md"]);
  });
});
