/**
 * The sidebar width: its stored preference, its bounds, and the clamp that keeps
 * it honest against the window.
 *
 * Kept out of `prefs.ts` (the reference app's grab-bag) because this app has no
 * account, sync or appearance preferences to share a module with — the two
 * functions below are the whole of what the shell stores on the device besides
 * the theme.
 */

export const SIDEBAR_WIDTH_KEY = "2nd-brain-sidebar-width";

export const SIDEBAR_WIDTH_DEFAULT = 264;
/** The default is also the floor: the resizer only ever widens the sidebar.
 *  Narrower than this and the sidebar header's row runs out of room — so there
 *  is nothing to be gained below the width the layout was designed at. */
export const SIDEBAR_WIDTH_MIN = SIDEBAR_WIDTH_DEFAULT;
export const SIDEBAR_WIDTH_MAX = 560;

/** Clamp a width to the selectable range only, ignoring the current window.
 *  This is the value the app persists: a narrow window must never overwrite the
 *  width the user chose on a wide one. NaN (a corrupted stored value) falls
 *  back to the default. */
export function clampSidebarWidthPreference(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

/** Clamp a width to what the current window can show, returning the width to
 *  render. The preference itself is not changed by this clamp. */
export function clampSidebarWidth(px: number, viewport = 1200): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  // Always leave room for the editor, even when the window is narrower than the
  // nominal maximum.
  const mainMinimum = 320;
  const max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, viewport - mainMinimum));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

export function readSidebarWidthPreference(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidthPreference(Number(raw));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* localStorage unavailable — the width stays in-memory only */
  }
}
