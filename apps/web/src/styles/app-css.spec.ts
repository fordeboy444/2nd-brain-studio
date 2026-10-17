import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* Stylesheet spec — reads the pruned App.css from disk with node:fs and asserts
   both directions of the prune: the removed families are gone, the rules the
   Phase 1 screens depend on are still here. It also catches the failure mode a
   line-based prune leaves behind — a `var(--x)` whose only declaration lived in
   a deleted region.

   This runs in the node side of vitest (the jsdom environment in vite.config.ts
   is harmless here); nothing in this file touches the DOM. */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS_PATH = resolve(HERE, "App.css");
const TOKENS_CSS_PATH = resolve(HERE, "tokens.css");

const appCss = readFileSync(APP_CSS_PATH, "utf8");
const tokensCss = readFileSync(TOKENS_CSS_PATH, "utf8");

/* The same stylesheet with every comment removed. This is NOT a convenience.
   The comments in this file QUOTE the declarations they explain — the `.toast`
   comment literally contains the string "max-width: 100%" — so a substring test
   over the raw text can pass on the prose alone and report a missing declaration
   as present. That happened: the toast assertion below was green with
   `max-width` deleted from the rule, and only the comment kept it alive. Every
   structural test here reads this version; only the line-count test, which is
   about the file's real size, reads the raw one. */
const appCssRules = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

/* The reference desktop stylesheet this file was copied from and pruned
   (baalda/app/apps/desktop/src/App.css at the time of the copy). Recorded as a
   number, not read from disk: the reference tree is a local read-only copy that
   is not part of this repo, so a version of this spec that opened it would fail
   anywhere the repo is cloned without it. */
const REFERENCE_LINE_COUNT = 10851;
const MAX_LINE_RATIO = 0.7;

/* Feature families the prune removes outright (D-10). Each entry is a selector
   prefix, so it is matched with its leading dot — prose about a removed feature
   in a surviving comment is not a rule and must not fail the prune. */
const REMOVED_FAMILIES = [
  ".account-", // the account family and its popovers
  ".auth-", // the authentication family
  ".oauth-", // its OAuth button
  ".billing", // the billing family
  ".upgrade", // the plan and upgrade surfaces
  ".plan-", // ... same surfaces, plan-shaped names
  ".payment", // ... and the payment step inside them
  ".member-", // the member-access surfaces
  ".share-", // the sharing surfaces (apart from the confirm dialog)
  ".invite", // the invite surfaces
  ".presence", // real-time presence, including the faces painted in the tree
  ".cursor-", // the collaborator cursor indicators
  ".collab", // the collaboration sync families
  ".attachment-sync", // ... the attachment one
  ".note-limit-banner", // ... and local-state sync, which these three belonged to
  ".vault-local-only", // "this vault is local only" banner family
  ".not-syncing", // "not syncing" banner family
  ".reset-unsynced-list", // the unsynced-reset control
  ".celebrate", // the sync celebration animation
  ".profile-hero", // account profile header
  ".connection-", // account connection rows
  ".status-dot", // presence status indicator
  ".status-options", // presence status picker
  ".access-menu", // member access menu
  ".role-field-trigger", // member role field
];

/* Selectors the Phase 1 screens render. Every one of these has a component that
   paints it, so a prune that deletes it breaks a screen silently — which is
   exactly what this list is for. */
const REQUIRED_SELECTORS = [
  // The application shell and its grid.
  ".app-shell",
  // The sidebar family, including the vault-switch header row.
  ".sidebar",
  ".sidebar-tree-wrap",
  ".vault-switch-btn",
  // The editor region: host, wrap and empty state.
  ".editor-host",
  ".editor-empty",
  // The right panel: body and its tabs.
  ".right-panel",
  ".right-panel-body",
  ".right-panel-tab",
  // The file tree (Phase 2 builds on these rules).
  ".tree-row",
  ".tree-label",
  // The confirm dialog — it must survive the rule group it shares with the
  // auth, share and upgrade dialogs.
  ".confirm-dialog",
  ".confirm-body",
  ".confirm-actions",
  // The toast family.
  ".toast-viewport",
  ".toast",
  // Shared primitives used across the shell.
  ".modal-backdrop",
  ".menu-portal",
  ".backlinks-popover",
  ".theme-toggle",
  ".error-boundary",
];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The body of the rule whose selector `pattern` matches, with comments already
 *  gone. Braces cannot nest inside a CSS rule body at this level, so stopping at
 *  the first `}` is correct. */
function ruleBody(css: string, pattern: RegExp): string {
  const match = pattern.exec(css);
  expect(match, `no rule matches ${pattern}`).not.toBeNull();
  return match?.[1] ?? "";
}

/** The value of the LAST declaration of `property` in a rule body — the one the
 *  cascade uses when a property is set twice. `null` when the rule does not
 *  declare it at all, which is a different assertion from "declares it empty".
 *
 *  Split on `;` rather than matched with a regex: `startsWith` on the exact
 *  `property:` form cannot be satisfied by a longer name that merely ends with
 *  it, and it cannot be satisfied by anything but a real declaration. */
function declaration(body: string, property: string): string | null {
  const hit = body
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${property}:`))
    .at(-1);
  return hit === undefined ? null : hit.slice(property.length + 1).trim();
}

function declaredProperties(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    // A capture group is `string | undefined` to the compiler, and this repo
    // runs with noUncheckedIndexedAccess. The first group of this pattern cannot
    // actually be empty — the group IS the match — so the guard is only here to
    // keep the type honest.
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/* `var(--x)` and `var(--x, fallback)` are not the same promise. The first
   breaks when the declaration disappears; the second still paints something.
   Only the first is an orphan when its declaration is gone — `--sidebar-w`,
   `--tile-fill` and `--glyph-fill` are set at runtime from TypeScript, so the
   fallback form is the correct way to reference them and they belong to no CSS
   region at all. */
function collectVarRefs(css: string): { hard: Set<string>; withFallback: Set<string> } {
  const hard = new Set<string>();
  const withFallback = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
    const name = match[1];
    if (name === undefined) continue;
    if (match[2] === ",") {
      withFallback.add(name);
    } else {
      hard.add(name);
    }
  }
  return { hard, withFallback };
}

describe("pruned App.css", () => {
  it("carries no rule from the removed feature families", () => {
    // Read without comments, which is the whole point of the rule above: prose
    // ABOUT a removed family is not a rule from it, and it must not fail the
    // prune. A comment that named one used to fail this test anyway.
    const survivors = REMOVED_FAMILIES.filter(
      (prefix) => countOccurrences(appCssRules, prefix) > 0,
    );
    expect(survivors).toEqual([]);
  });

  it("still carries every selector the Phase 1 screens use", () => {
    // Without comments: a selector named only in a comment must not count as
    // present, or a prune that deleted the rule would pass.
    const missing = REQUIRED_SELECTORS.filter((selector) => !appCssRules.includes(selector));
    expect(missing).toEqual([]);
  });

  it("is meaningfully smaller than the reference stylesheet", () => {
    const prunedLines = appCss.split("\n").length;
    expect(prunedLines / REFERENCE_LINE_COUNT).toBeLessThanOrEqual(MAX_LINE_RATIO);
  });

  it("resolves the selected tree row to an --accent-soft fill with --text-primary text", () => {
    const rule = ruleBody(appCssRules, /\.tree-row\.selected\s*\{([^}]*)\}/);
    expect(declaration(rule, "background")).toContain("var(--accent-soft)");
    expect(declaration(rule, "color")).toContain("var(--text-primary)");
  });

  it("references no custom property whose only declaration was pruned", () => {
    const declared = new Set([
      ...declaredProperties(appCssRules),
      ...declaredProperties(tokensCss),
    ]);
    const { hard } = collectVarRefs(appCssRules);
    const orphans = [...hard].filter((name) => !declared.has(name));
    expect(orphans).toEqual([]);
  });

  it("lets a toast shrink to the viewport and wrap an unbreakable token", () => {
    // Measured live before the fix: a toast carrying a long unbreakable token
    // was 4569.1px wide at x = -3305.1, so most of its message sat outside the
    // window. Both halves matter — the clamp bounds the box, and the wrap is
    // what lets the box actually reach that bound, because a fit-content box
    // never goes below its own min-content width.
    //
    // Asserted on the DECLARATIONS, never on the rule's text. Each of these four
    // strings appears in the comment that explains it, so a substring test is
    // satisfied by the explanation alone.
    const toast = ruleBody(appCssRules, /\.toast\s*\{([^}]*)\}/);
    expect(declaration(toast, "max-width")).toBe("100%");

    const text = ruleBody(appCssRules, /\.toast-text\s*\{([^}]*)\}/);
    expect(declaration(text, "min-width")).toBe("0");
    expect(declaration(text, "overflow-wrap")).toBe("anywhere");
    // `anywhere` and not `break-word`: only `anywhere` lowers min-content, which
    // is the width the fit-content box above resolves against.
    // The message must WRAP, never be cut. An ellipsis here would silently drop
    // the tail of a server error — the one line the user needs in full.
    expect(declaration(text, "text-overflow")).toBeNull();
  });

  it("scrolls a long code block and a wide table inside their own box", () => {
    // The read view's two children that cannot wrap: `pre` keeps the author's
    // line breaks, and a wide table has no soft-wrap point at all. Before this
    // rule, the editor region carried the overflow — measured live at
    // scrollWidth 3794 in a clientWidth of 1016, from a `pre` of 3680 in a 789
    // column. After it, the region is 1016/1016 and each block scrolls alone.
    const pre = ruleBody(appCssRules, /\.md-view pre\s*\{([^}]*)\}/);
    expect(declaration(pre, "overflow-x")).toBe("auto");

    const table = ruleBody(appCssRules, /\.md-view table\s*\{([^}]*)\}/);
    // `display: block` is not decoration here, and its absence is the failure
    // mode worth testing: a table box is sized to its content and IGNORES
    // `overflow`, so an `overflow-x` alone leaves the table 2482px wide with
    // nothing scrolling. Reverting only this line is what the negative control
    // does.
    expect(declaration(table, "display")).toBe("block");
    expect(declaration(table, "overflow-x")).toBe("auto");
  });

  it("keeps the token import ahead of this stylesheet in main.tsx", () => {
    // Read as text and compared by position: the stylesheet consumes the custom
    // properties tokens.css declares, so App.css must be evaluated second.
    const mainTsx = readFileSync(resolve(HERE, "..", "main.tsx"), "utf8");
    const tokensAt = mainTsx.indexOf('"./styles/tokens.css"');
    const appCssAt = mainTsx.indexOf('"./styles/App.css"');
    expect(tokensAt).toBeGreaterThanOrEqual(0);
    expect(appCssAt).toBeGreaterThanOrEqual(0);
    expect(tokensAt).toBeLessThan(appCssAt);
  });
});
