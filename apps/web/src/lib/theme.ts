/* ============================================================
   Theme preference — light / dark / system.
   Ported from baalda/app/apps/desktop/src/lib/theme.ts and reduced
   to what a single-user web app needs: no appearance-override sync
   layer, no broadcast channel. The stored value is validated against
   the three allowed preferences before use, so a tampered entry
   falls back to `system` rather than becoming an arbitrary attribute
   value (T-01-09: accept). Every localStorage read is guarded so a
   disabled or full storage backend degrades to the default rather
   than throwing.
   ============================================================ */

export type Theme = "light" | "dark" | "system";

/** The resolved paint value actually written to `data-theme`. */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "2nd-brain-theme";

const ALLOWED: readonly Theme[] = ["light", "dark", "system"];

const DARK_MEDIA = "(prefers-color-scheme: dark)";

/**
 * Read the stored preference. Returns `"system"` when nothing valid is
 * stored, when storage is unavailable, or when the stored value is not
 * one of the three allowed preferences — a tampered entry can never
 * become an attribute value.
 */
export function readStoredTheme(): Theme {
  try {
    const v = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return ALLOWED.includes(v as Theme) ? (v as Theme) : "system";
  } catch {
    return "system";
  }
}

/**
 * Resolve a preference to the paint value. Only the `system` case
 * consults `matchMedia`; an explicit light/dark preference is returned
 * as-is so a stored choice survives an OS flip.
 */
export function resolveTheme(pref: Theme): ResolvedTheme {
  if (pref === "system") {
    try {
      return globalThis.matchMedia?.(DARK_MEDIA)?.matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }
  return pref;
}

/** Stamp the resolved value on the root element's `data-theme` attribute. */
export function applyTheme(pref: Theme): void {
  const resolved = resolveTheme(pref);
  try {
    document.documentElement.setAttribute("data-theme", resolved);
  } catch {
    // No DOM (e.g. a node-only import) — nothing to paint.
  }
}

/**
 * Apply then persist, in that order. A crash between the two leaves the
 * UI consistent with what was just painted rather than with a stored
 * value that disagrees with it.
 */
export function setTheme(pref: Theme): void {
  applyTheme(pref);
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage unavailable or full — the in-memory attribute is still correct.
  }
}

/** The currently stored preference (not the resolved paint value). */
export function currentTheme(): Theme {
  return readStoredTheme();
}

/* ---- system-mode live follow ---- */

let systemListener: ((e: MediaQueryListEvent) => void) | null = null;
let systemMql: MediaQueryList | null = null;

function ensureSystemListener(): void {
  if (systemListener) return;
  try {
    const mql = globalThis.matchMedia?.(DARK_MEDIA);
    if (!mql) return;
    systemMql = mql;
    systemListener = () => {
      // Only re-paint when the active preference is `system`; an explicit
      // light/dark choice must survive an OS flip.
      if (readStoredTheme() === "system") applyTheme("system");
    };
    // addEventListener is the modern API; addListener is the Safari < 14 fallback.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", systemListener);
    } else {
      (mql as MediaQueryList).addListener(systemListener);
    }
  } catch {
    // matchMedia unavailable — system mode falls back to light at resolve time.
  }
}

/**
 * Read the stored preference, apply it for first paint, and arm the
 * system-mode listener. Idempotent: calling it twice does not register a
 * second listener and does not change the attribute beyond what the
 * stored preference resolves to.
 */
export function initTheme(): void {
  applyTheme(readStoredTheme());
  ensureSystemListener();
}