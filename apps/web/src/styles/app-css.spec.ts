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

function declaredProperties(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    names.add(match[1]);
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
    if (match[2] === ",") {
      withFallback.add(match[1]);
    } else {
      hard.add(match[1]);
    }
  }
  return { hard, withFallback };
}

describe("pruned App.css", () => {
  it("carries no rule from the removed feature families", () => {
    const survivors = REMOVED_FAMILIES.filter(
      (prefix) => countOccurrences(appCss, prefix) > 0,
    );
    expect(survivors).toEqual([]);
  });

  it("still carries every selector the Phase 1 screens use", () => {
    const missing = REQUIRED_SELECTORS.filter((selector) => !appCss.includes(selector));
    expect(missing).toEqual([]);
  });

  it("is meaningfully smaller than the reference stylesheet", () => {
    const prunedLines = appCss.split("\n").length;
    expect(prunedLines / REFERENCE_LINE_COUNT).toBeLessThanOrEqual(MAX_LINE_RATIO);
  });

  it("resolves the selected tree row to an --accent-soft fill with --text-primary text", () => {
    const rule = /\.tree-row\.selected\s*\{([^}]*)\}/.exec(appCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("var(--accent-soft)");
    expect(rule?.[1]).toContain("var(--text-primary)");
  });

  it("references no custom property whose only declaration was pruned", () => {
    const declared = new Set([
      ...declaredProperties(appCss),
      ...declaredProperties(tokensCss),
    ]);
    const { hard } = collectVarRefs(appCss);
    const orphans = [...hard].filter((name) => !declared.has(name));
    expect(orphans).toEqual([]);
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
