import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

/* markdown spec — the sanitisation contract (T-01-11, T-01-12).

   Runs under jsdom (vite.config.ts) because the sanitizer is a real DOM pass:
   the assertions below are about the SHAPE of the returned markup, which is what
   `MarkdownView` hands to `dangerouslySetInnerHTML`. */

/** The rendered body as a document, so assertions can be about elements rather than strings. */
function dom(html: string): HTMLElement {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return parsed.body;
}

describe("renderMarkdown — nothing executes", () => {
  it("does not let a script element survive", () => {
    const body = dom(renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter"));
    expect(body.querySelector("script")).toBeNull();
    expect(body.textContent).toContain("before");
    expect(body.textContent).toContain("after");
  });

  it("does not let a script element survive inside a block element", () => {
    const body = dom(renderMarkdown('<div><p>text</p><script>alert(1)</script></div>'));
    expect(body.querySelector("script")).toBeNull();
    expect(body.textContent).toContain("text");
  });

  it.each(["style", "iframe", "object", "embed"])(
    "does not let a %s element survive",
    (tag) => {
      const body = dom(renderMarkdown(`<${tag}>x</${tag}>`));
      expect(body.querySelector(tag)).toBeNull();
    },
  );

  it("does not let an event-handler attribute survive", () => {
    const body = dom(renderMarkdown('<img src="x.png" onerror="alert(1)" alt="x">'));
    const img = body.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(body.innerHTML).not.toContain("onerror");
  });

  it("does not let a style attribute survive", () => {
    const body = dom(renderMarkdown('<p style="position:fixed;inset:0">x</p>'));
    expect(body.querySelector("p")?.getAttribute("style")).toBeNull();
  });
});

describe("renderMarkdown — a refused URL is a span, not a stripped anchor", () => {
  it.each(["javascript:alert(1)", "vbscript:msgbox(1)"])(
    "renders a link to %j as a span",
    (href) => {
      const body = dom(renderMarkdown(`[click me](${href})`));
      expect(body.querySelector("a")).toBeNull();
      const span = body.querySelector("span.md-link-blocked");
      expect(span).not.toBeNull();
      // The author's text survives...
      expect(span?.textContent).toBe("click me");
      // ...and the URL is nowhere in the markup, not even inert in an attribute.
      expect(body.innerHTML).not.toContain("alert(1)");
      expect(body.innerHTML).not.toContain("javascript:");
    },
  );

  it("never turns the whitespace trick into an anchor, in either route in", () => {
    // marked's own destination tokenizer refuses a destination containing a tab,
    // so this spelling stays literal text rather than becoming a link...
    const fromMarkdown = dom(renderMarkdown("[click me](java\tscript:alert(1))"));
    expect(fromMarkdown.querySelector("a")).toBeNull();
    expect(fromMarkdown.textContent).toContain("java\tscript:alert(1)");

    // ...and the same URL arriving as raw HTML (where the entity is decoded into
    // the href before anything checks it) is stripped and becomes a span. The
    // sanitizer is the layer that catches this one, which is why it is not the
    // renderer alone that runs on the output.
    const fromHtml = dom(renderMarkdown('<a href="java&#9;script:alert(1)">y</a>'));
    expect(fromHtml.querySelector("a")).toBeNull();
    expect(fromHtml.querySelector("span.md-link-broken")?.textContent).toBe("y");
  });

  it("keeps the text of a refused autolink", () => {
    const body = dom(renderMarkdown("<javascript:alert(2)>"));
    expect(body.querySelector("a")).toBeNull();
    expect(body.querySelector("span.md-link-blocked")?.textContent).toBe("javascript:alert(2)");
  });

  it("gives the refused span an accessible indication", () => {
    const body = dom(renderMarkdown("[click me](javascript:alert(1))"));
    const span = body.querySelector("span.md-link-blocked");
    expect(span?.getAttribute("role")).toBe("note");
    expect(span?.getAttribute("aria-label")).toContain("click me");
  });

  it("still renders an ordinary relative link as an anchor", () => {
    const body = dom(renderMarkdown("[other](../notes/other.md)"));
    const a = body.querySelector("a");
    expect(a?.getAttribute("href")).toBe("../notes/other.md");
  });

  it("still renders an http link as an anchor, opened off-site safely", () => {
    const body = dom(renderMarkdown("[site](https://example.com/x)"));
    const a = body.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });
});

describe("renderMarkdown — the broken-link pass", () => {
  it("turns an anchor the caller calls missing into a tolerated span", () => {
    const body = dom(
      renderMarkdown("[gone](notes/gone.md)", { markBroken: (href) => href }),
    );
    expect(body.querySelector("a")).toBeNull();
    const span = body.querySelector("span.md-link-broken");
    expect(span?.textContent).toBe("gone");
    expect(span?.getAttribute("role")).toBe("note");
  });

  it("leaves the anchor alone when the caller does not answer", () => {
    const body = dom(renderMarkdown("[maybe](notes/maybe.md)", { markBroken: () => null }));
    expect(body.querySelector("a")?.getAttribute("href")).toBe("notes/maybe.md");
  });
});

describe("renderMarkdown — document shape", () => {
  it("renders the body and never the frontmatter", () => {
    const body = dom(renderMarkdown("---\ntitle: A note\ntags:\n  - x\n---\n\n# Heading"));
    expect(body.textContent).not.toContain("title:");
    expect(body.querySelector("h1")?.textContent).toBe("Heading");
  });

  it("accepts a bare body too — the split is idempotent", () => {
    const body = dom(renderMarkdown("# Heading\n\npara"));
    expect(body.querySelector("h1")?.textContent).toBe("Heading");
  });

  it("renders a fenced code block as code, escaping its contents", () => {
    const body = dom(renderMarkdown("```html\n<script>alert(1)</script>\n```"));
    expect(body.querySelector("pre code")).not.toBeNull();
    expect(body.querySelector("script")).toBeNull();
    expect(body.textContent).toContain("<script>alert(1)</script>");
  });
});
