import { describe, expect, it } from "vitest";
import { resolveLink, type LinkTarget } from "./linkResolve.js";
import type { TreeEntry } from "./api.js";
import { EMPTY_TREE, markLoaded, ROOT, type TreeState } from "./tree/lazyTree.js";

/* linkResolve spec — the classification every link render depends on.

   Runs under jsdom (vite.config.ts) though nothing here needs the DOM: this is
   pure string work plus a map lookup, which is the point. */

function entry(name: string, dir: string, isDir = false): TreeEntry {
  const path = dir === ROOT ? name : `${dir}/${name}`;
  return { id: path, name, path, isDir, childrenLoaded: false };
}

/** A tree where `dir` has actually been read. */
function loaded(dir: string, names: string[]): TreeState {
  return markLoaded(EMPTY_TREE, dir, names.map((n) => entry(n, dir)));
}

const NOTE = "notes/idea.md";

describe("resolveLink — same-document and external", () => {
  it("reads a bare fragment as an anchor, percent-decoded", () => {
    expect(resolveLink("#my-heading", NOTE, EMPTY_TREE)).toEqual({
      kind: "anchor",
      fragment: "my-heading",
    });
    expect(resolveLink("#a%20b", NOTE, EMPTY_TREE)).toEqual({ kind: "anchor", fragment: "a b" });
  });

  it("reads an empty target as the document itself, not as broken", () => {
    expect(resolveLink("   ", NOTE, EMPTY_TREE)).toEqual({ kind: "anchor", fragment: "" });
  });

  it("sends http(s) and mailto out, keeping the whole href", () => {
    const long = "https://example.com/a?b=c#d";
    expect(resolveLink(long, NOTE, EMPTY_TREE)).toEqual({ kind: "external", href: long });
    expect(resolveLink("mailto:a@b.c", NOTE, EMPTY_TREE)).toEqual({
      kind: "external",
      href: "mailto:a@b.c",
    });
  });

  it("sends other safe schemes out too, rather than reading them as paths", () => {
    expect(resolveLink("tel:+15551234", NOTE, EMPTY_TREE)).toEqual({
      kind: "external",
      href: "tel:+15551234",
    });
  });
});

describe("resolveLink — refusal", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ])("refuses %j outright", (href) => {
    const target = resolveLink(href, NOTE, EMPTY_TREE);
    expect(target.kind).toBe("broken");
    expect(target).toMatchObject({ reason: "unsafe" });
  });

  it("keeps an image data: URL safe — handed to the browser, not refused", () => {
    const target = resolveLink("data:image/png;base64,AAAA", NOTE, EMPTY_TREE);
    expect(target).toEqual({ kind: "external", href: "data:image/png;base64,AAAA" });
  });

  it("refuses a target that climbs above the vault root", () => {
    const target = resolveLink("../../../../etc/passwd", NOTE, EMPTY_TREE);
    expect(target).toEqual({
      kind: "broken",
      href: "../../../../etc/passwd",
      path: "../../../../etc/passwd",
      reason: "escapes-root",
    });
  });

  it("allows a climb that stays inside the vault", () => {
    // The root level has been read, and it does hold this file.
    const state = loaded("", ["notes", "other.md"]);
    expect(resolveLink("../other.md", "notes/idea.md", state)).toEqual({
      kind: "vault",
      path: "other.md",
      fragment: null,
    });
  });
});

describe("resolveLink — the lazy tree is the authority on what exists", () => {
  it("calls it missing when the directory was read and does not hold it", () => {
    const state = loaded("notes", ["idea.md", "other.md"]);
    expect(resolveLink("gone.md", NOTE, state)).toEqual({
      kind: "broken",
      href: "gone.md",
      path: "notes/gone.md",
      reason: "missing",
    });
  });

  it("calls it a vault target when the directory was read and DOES hold it", () => {
    const state = loaded("notes", ["idea.md", "other.md"]);
    expect(resolveLink("other.md", NOTE, state)).toEqual({
      kind: "vault",
      path: "notes/other.md",
      fragment: null,
    });
  });

  it("does NOT call it missing when the directory has never been read", () => {
    // The gate's own fails_when: a link into a not-yet-loaded directory must
    // come back as a normal vault target.
    expect(resolveLink("deep/in/here.md", NOTE, EMPTY_TREE)).toEqual({
      kind: "vault",
      path: "notes/deep/in/here.md",
      fragment: null,
    });
    // ...including a directory we know of but have not expanded.
    const shallow = loaded("", ["notes", "deep"]);
    expect(resolveLink("../deep/x.md", NOTE, shallow)).toEqual({
      kind: "vault",
      path: "deep/x.md",
      fragment: null,
    });
  });
});

describe("resolveLink — path shape", () => {
  it("carries the fragment beside the path", () => {
    const state = loaded("notes", ["other.md"]);
    expect(resolveLink("other.md#section", NOTE, state)).toEqual({
      kind: "vault",
      path: "notes/other.md",
      fragment: "section",
    });
  });

  it("treats a leading slash as vault-absolute, not filesystem-absolute", () => {
    expect(resolveLink("/index.md", "deep/nested/note.md", EMPTY_TREE)).toEqual({
      kind: "vault",
      path: "index.md",
      fragment: null,
    });
  });

  it("collapses . and empty segments", () => {
    expect(resolveLink("./sub/./x.md", NOTE, EMPTY_TREE)).toEqual({
      kind: "vault",
      path: "notes/sub/x.md",
      fragment: null,
    });
  });

  it("classifies a non-md target as an asset", () => {
    expect(resolveLink("img/diagram.png", NOTE, EMPTY_TREE)).toEqual({
      kind: "asset",
      path: "notes/img/diagram.png",
      fragment: null,
    });
  });

  it("classifies a trailing slash as an asset, resolved like any other path", () => {
    expect(resolveLink("../other/", NOTE, EMPTY_TREE)).toEqual({
      kind: "asset",
      path: "other",
      fragment: null,
    });
  });

  it("accepts an upper-case extension", () => {
    expect(resolveLink("Shout.MD", NOTE, EMPTY_TREE)).toEqual({
      kind: "vault",
      path: "notes/Shout.MD",
      fragment: null,
    });
  });

  it("never hands back a leading dot-slash", () => {
    const target: LinkTarget = resolveLink("x.md", NOTE, EMPTY_TREE);
    expect(target).toEqual({ kind: "vault", path: "notes/x.md", fragment: null });
  });
});
