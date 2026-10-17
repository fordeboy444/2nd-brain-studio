/* The right panel's tabs and the remembered last tab (per device, per browser). */
export type RightPanelTab = "backlinks" | "outline" | "frontmatter" | "lint";

/** The strip's order, fixed by the UI spec: Backlinks → Outline → Frontmatter → Lint. */
export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  "backlinks",
  "outline",
  "frontmatter",
  "lint",
];

export const RIGHT_PANEL_TAB_LABEL: Record<RightPanelTab, string> = {
  backlinks: "Backlinks",
  outline: "Outline",
  frontmatter: "Frontmatter",
  lint: "Lint",
};

export const RIGHT_PANEL_TAB_KEY = "2nd-brain-right-panel-tab";

export function readLastTab(): RightPanelTab {
  try {
    const v = globalThis.localStorage?.getItem(RIGHT_PANEL_TAB_KEY);
    return (RIGHT_PANEL_TABS as readonly string[]).includes(v ?? "")
      ? (v as RightPanelTab)
      : "backlinks";
  } catch {
    return "backlinks";
  }
}

export function writeLastTab(tab: RightPanelTab): void {
  try {
    globalThis.localStorage?.setItem(RIGHT_PANEL_TAB_KEY, tab);
  } catch {
    // Remembering the tab is a convenience.
  }
}
