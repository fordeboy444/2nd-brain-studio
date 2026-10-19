import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LintModal, type LintReport } from "./LintModal.js";

/**
 * The lint report modal (API-01, API-02, T-05-12).
 *
 * The server's `/api/vaults/:id/lint` route returns `{ ok, errors, warnings,
 * scanned }` where each finding is `{ rule, severity, message }`. The message
 * embeds the file path (e.g. `E2 broken link \`x.md\` in concepts/alpha.md`), so
 * the modal extracts a `.md` path from the message to turn each row into a
 * click-through link to the file the finding is about.
 *
 * T-05-12 (DoS via a huge lint list) is mitigated by a scrollable container with
 * a max-height: the list never grows the modal past the viewport, and the DOM
 * node count is the finding count (not a page per finding).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The shape the server actually returns — `LintFinding` has no `file` field,
 *  so the modal extracts the path from `message`. */
interface LintFinding {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

const PASSED: LintReport = {
  ok: true,
  errors: [],
  warnings: [],
  scanned: 12,
};

const WITH_ISSUES: LintReport = {
  ok: false,
  scanned: 14,
  errors: [
    { rule: "E1", severity: "error", message: "E1 missing/empty `type` frontmatter: concepts/alpha.md" },
    {
      rule: "E2",
      severity: "error",
      message: "E2 broken link `missing.md` in concepts/beta.md",
    },
  ],
  warnings: [
    { rule: "W1", severity: "warning", message: "W1 theme not found: concepts/gamma.md" },
  ],
};

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
  report: LintReport;
  onSelectFile?: (path: string) => void;
  onClose?: () => void;
}) {
  const onSelectFile = props.onSelectFile ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(
      createElement(LintModal, {
        report: props.report,
        onSelectFile,
        onClose,
      }),
    );
  });
  return { host, onSelectFile, onClose };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("LintModal", () => {
  it("renders a passed summary when ok is true and there are no errors", async () => {
    const { host } = await mount({ report: PASSED });

    expect(host.textContent).toContain("Lint Report");
    expect(host.textContent).toContain("Passed");
    expect(host.textContent).toContain("12 files scanned");
    // The error/warning badges are absent (or show zero) — the key is that no
    // error rows render.
    expect(host.querySelectorAll("[data-lint-issue]").length).toBe(0);
  });

  it("renders a failed summary with error and warning count badges", async () => {
    const { host } = await mount({ report: WITH_ISSUES });

    expect(host.textContent).toContain("Failed");
    expect(host.textContent).toContain("2 errors");
    expect(host.textContent).toContain("1 warning");
    // Three issue rows total: two errors and one warning, in append order.
    const rows = host.querySelectorAll("[data-lint-issue]");
    expect(rows.length).toBe(3);
    // The first row is an error (errors come before warnings in the list).
    expect(rows[0]!.getAttribute("data-severity")).toBe("error");
    expect(rows[0]!.getAttribute("data-rule")).toBe("E1");
    expect(rows[2]!.getAttribute("data-severity")).toBe("warning");
    expect(rows[2]!.getAttribute("data-rule")).toBe("W1");
  });

  it("extracts a file path from the message and makes the row a click-through link", async () => {
    const onSelectFile = vi.fn();
    const { host } = await mount({ report: WITH_ISSUES, onSelectFile });

    // The first error's message names `concepts/alpha.md`. The row's file link
    // calls onSelectFile with that path — not the raw message, and not the
    // rule code.
    const firstRow = host.querySelector("[data-lint-issue]");
    expect(firstRow).toBeTruthy();
    const link = firstRow!.querySelector<HTMLButtonElement>("[data-lint-file-link]");
    expect(link).toBeTruthy();
    expect(link!.getAttribute("data-path")).toBe("concepts/alpha.md");
    await click(link!);
    expect(onSelectFile).toHaveBeenCalledWith("concepts/alpha.md");
  });

  it("extracts the file the finding is about, not a path embedded in the message", async () => {
    const onSelectFile = vi.fn();
    const { host } = await mount({ report: WITH_ISSUES, onSelectFile });

    // The E2 message is `E2 broken link \`missing.md\` in concepts/beta.md`.
    // The file WITH the broken link is `concepts/beta.md` (the last path), not
    // `missing.md` (the broken target). The link should open the file that has
    // the issue, so the user can fix it.
    const rows = host.querySelectorAll("[data-lint-issue]");
    const e2Row = Array.from(rows).find((r) => r.getAttribute("data-rule") === "E2")!;
    const link = e2Row.querySelector<HTMLButtonElement>("[data-lint-file-link]");
    expect(link).toBeTruthy();
    expect(link!.getAttribute("data-path")).toBe("concepts/beta.md");
  });

  it("renders a row without a file link when the message has no .md path", async () => {
    const report: LintReport = {
      ok: false,
      scanned: 1,
      errors: [
        { rule: "E4", severity: "error", message: "E4 sources/src.md has no matching raw transcript" },
      ],
      warnings: [],
    };
    // E4 mentions sources/src.md — the link should point there.
    const { host } = await mount({ report });
    const link = host.querySelector("[data-lint-file-link]");
    expect(link).toBeTruthy();
    expect(link!.getAttribute("data-path")).toBe("sources/src.md");

    // A message with no .md path at all renders as text, no link.
    const noPath: LintReport = {
      ok: false,
      scanned: 1,
      errors: [{ rule: "E1", severity: "error", message: "E1 bundle has no index.md" }],
      warnings: [],
    };
    const { host: host2 } = await mount({ report: noPath });
    expect(host2.querySelector("[data-lint-file-link]")).toBeNull();
    expect(host2.querySelector("[data-lint-issue]")?.textContent).toContain("bundle has no index.md");
  });

  it("scrolls inside a bounded container so a large lint list cannot freeze the UI (T-05-12)", async () => {
    // 200 findings — the shape of a bundle with a broken link graph. The list
    // container has a max-height and overflow-y: auto so the modal stays inside
    // the viewport and the DOM holds 200 rows, not 200 pages.
    const many: LintReport = {
      ok: false,
      scanned: 200,
      errors: Array.from({ length: 200 }, (_, i) => ({
        rule: "E2",
        severity: "error" as const,
        message: `E2 broken link \`x${i}.md\` in concepts/file-${i}.md`,
      })),
      warnings: [],
    };
    const { host } = await mount({ report: many });

    const list = host.querySelector("[data-lint-list]");
    expect(list).toBeTruthy();
    expect(list!.scrollHeight).toBeGreaterThan(0);
    // The max-height is set inline; jsdom does not compute layout, so the
    // assertion is on the declaration the browser acts on, not a measured
    // pixel height. `overflowY: "auto"` is what makes the container scroll.
    expect((list as HTMLElement).style.overflowY).toBe("auto");
    const maxHeight = (list as HTMLElement).style.maxHeight;
    expect(maxHeight).not.toBe("");
    expect(parseFloat(maxHeight)).toBeGreaterThan(0);
    expect(list!.querySelectorAll("[data-lint-issue]").length).toBe(200);
  });

  it("closes when the close button is pressed", async () => {
    const onClose = vi.fn();
    const { host } = await mount({ report: PASSED, onClose });

    const closeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(closeBtn).toBeTruthy();
    await click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});