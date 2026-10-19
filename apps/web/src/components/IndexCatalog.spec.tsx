import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexCatalog } from "./IndexCatalog.js";

/**
 * The OKF index.md catalog reader.
 *
 * The root `index.md` and the sub-indexes (`concepts/index.md`,
 * `entities/index.md`, ...) share one shape: a `## Section` heading followed by
 * a list of `- [Title](relative/path.md) - description` bullets. This spec pins
 * the three things that make the catalog a catalog and not a markdown dump:
 *
 * 1. Sections are parsed into named groups, and each group's bullets become
 *    clickable cards with the link's title and the trailing description.
 * 2. A click resolves the link's href against the index file's own path and
 *    calls `onSelectFile` with a vault-relative path — never the raw href, which
 *    would be wrong for every sub-index.
 * 3. A directory link (`./concepts/`) is normalized to `<dir>/index.md`, so a
 *    click on a Catalog row in the root index opens the sub-index as a file.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT_INDEX = `---
okf_version: "0.1"
title: "Knowledge Bundle"
updated: 2026-10-17
---

# Knowledge Bundle

<!-- GENERATED:BANNER -->
**Coverage:** 3 videos, 0 web pages
<!-- GENERATED:BANNER -->

This is the root catalog of an OKF bundle.

## Catalog

- [Concepts](./concepts/) — ideas, techniques, patterns, mental models
- [Entities](./entities/) — tools, people, organizations
- [Sources](./sources/) — one summary page per source (provenance)

## Consume

Read \`README.md\` for the human entry point.
`;

const CONCEPTS_INDEX = `# Concepts

Ideas, techniques, patterns, and mental models mined from the videos. Grouped by theme.

## Theme One
- [Alpha Concept](alpha.md) - First concept.
- [Beta: The (Bracketed) Concept](beta.md) - Second concept, with: a colon.

## Theme Two
- [Gamma](gamma.md) - Third concept.

## Other
- [delta](delta.md)
`;

const roots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

afterEach(async () => {
  await act(async () => {
    for (const { root, host } of roots.splice(0)) {
      root.unmount();
      host.remove();
    }
  });
});

async function mount(props: {
  content: string;
  basePath?: string;
  onSelectFile?: (path: string) => void;
}) {
  const onSelectFile = props.onSelectFile ?? vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(
      createElement(IndexCatalog, {
        content: props.content,
        basePath: props.basePath ?? "index.md",
        onSelectFile,
      }),
    );
  });
  return { host, onSelectFile };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("IndexCatalog", () => {
  it("parses sections and renders cards with titles, descriptions, and section badges", async () => {
    const { host } = await mount({ content: CONCEPTS_INDEX, basePath: "concepts/index.md" });

    // Three named sections from the `## Heading` lines.
    const sections = host.querySelectorAll("[data-section]");
    expect(sections.length).toBe(3);
    expect(sections[0]!.getAttribute("data-section")).toBe("Theme One");
    expect(sections[1]!.getAttribute("data-section")).toBe("Theme Two");
    expect(sections[2]!.getAttribute("data-section")).toBe("Other");

    // The first section has two items; each shows the link title and the
    // trailing description text from after the `- `.
    const items = sections[0]!.querySelectorAll("[data-catalog-item]");
    expect(items.length).toBe(2);
    expect(items[0]!.getAttribute("data-title")).toBe("Alpha Concept");
    expect(items[0]!.textContent).toContain("First concept.");
    // A title with a colon and parentheses is preserved verbatim — the parser
    // must not stop at the first `:` or trim the parenthetical.
    expect(items[1]!.getAttribute("data-title")).toBe("Beta: The (Bracketed) Concept");
    expect(items[1]!.textContent).toContain("Second concept, with: a colon.");

    // An item with no description (just `- [delta](delta.md)`) still renders as
    // a clickable card; the description is empty, not undefined text.
    const otherItems = sections[2]!.querySelectorAll("[data-catalog-item]");
    expect(otherItems.length).toBe(1);
    expect(otherItems[0]!.getAttribute("data-title")).toBe("delta");
  });

  it("resolves a relative .md link against the index file's directory and calls onSelectFile", async () => {
    const onSelectFile = vi.fn();
    const { host } = await mount({
      content: CONCEPTS_INDEX,
      basePath: "concepts/index.md",
      onSelectFile,
    });

    const first = host.querySelector<HTMLButtonElement>("[data-catalog-item]");
    expect(first).toBeTruthy();
    await click(first!);

    // href="alpha.md" against basePath="concepts/index.md" → "concepts/alpha.md".
    // The raw href would be wrong for every sub-index.
    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(onSelectFile).toHaveBeenCalledWith("concepts/alpha.md");
  });

  it("normalizes a directory link to <dir>/index.md for the root catalog", async () => {
    const onSelectFile = vi.fn();
    const { host } = await mount({
      content: ROOT_INDEX,
      basePath: "index.md",
      onSelectFile,
    });

    // The `## Catalog` section holds the three directory links.
    const section = host.querySelector('[data-section="Catalog"]');
    expect(section).toBeTruthy();
    const items = section!.querySelectorAll<HTMLButtonElement>("[data-catalog-item]");
    expect(items.length).toBe(3);

    await click(items[0]!);
    // `./concepts/` against `index.md` → `concepts/index.md`. A trailing slash
    // is the OKF convention for a sub-index; the catalog opens the file.
    expect(onSelectFile).toHaveBeenLastCalledWith("concepts/index.md");

    await click(items[1]!);
    expect(onSelectFile).toHaveBeenLastCalledWith("entities/index.md");

    await click(items[2]!);
    expect(onSelectFile).toHaveBeenLastCalledWith("sources/index.md");
  });

  it("filters items by title or description through the search input", async () => {
    const { host } = await mount({ content: CONCEPTS_INDEX, basePath: "concepts/index.md" });

    // Three items total before filtering.
    expect(host.querySelectorAll("[data-catalog-item]").length).toBe(4);

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Filter catalog"]');
    expect(search).toBeTruthy();
    await typeInto(search!, "beta");

    // Only the Beta card matches (by title). The other section's items are
    // hidden, and the empty section is hidden too — a section with no visible
    // items is not a section worth showing.
    const visible = host.querySelectorAll("[data-catalog-item]:not([hidden])");
    expect(visible.length).toBe(1);
    expect(visible[0]!.getAttribute("data-title")).toBe("Beta: The (Bracketed) Concept");
  });

  it("filters by description text, not only by title", async () => {
    const { host } = await mount({ content: CONCEPTS_INDEX, basePath: "concepts/index.md" });

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Filter catalog"]');
    await typeInto(search!, "third");

    const visible = host.querySelectorAll("[data-catalog-item]:not([hidden])");
    expect(visible.length).toBe(1);
    expect(visible[0]!.getAttribute("data-title")).toBe("Gamma");
  });

  it("strips YAML frontmatter before parsing so the banner block is not a section", async () => {
    const { host } = await mount({ content: ROOT_INDEX, basePath: "index.md" });

    // The frontmatter (`---\nokf_version: ...\n---`) and the GENERATED banner
    // are not `## ` headings; only `## Catalog` and `## Consume` become
    // sections.
    const sections = host.querySelectorAll("[data-section]");
    const names = Array.from(sections).map((s) => s.getAttribute("data-section"));
    expect(names).toEqual(["Catalog", "Consume"]);
  });

  it("renders an empty state when the index has no link items", async () => {
    const empty = `# Empty\n\nThis index has no links yet.\n`;
    const { host } = await mount({ content: empty, basePath: "index.md" });

    expect(host.querySelector("[data-catalog-item]")).toBeNull();
    expect(host.textContent).toContain("No entries");
  });
});