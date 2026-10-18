import { useCallback, useEffect, useState } from "react";
import {
  clampSidebarWidth,
  clampSidebarWidthPreference,
  readSidebarWidthPreference,
  writeSidebarWidth,
} from "./sidebarWidth.js";

/**
 * The user's sidebar width, restored from localStorage and kept honest against
 * the window size.
 *
 * Lives apart from `SidebarResizer` because Fast Refresh gives up on a module
 * that exports both a component and a plain function — mixing them there cost a
 * full page reload on every edit to either.
 *
 * The width is handed to the layout as a CSS variable rather than kept in the
 * store: nothing outside the grid needs it, and routing a drag through global
 * state would re-render the whole tree on every pointer move.
 */
export function useSidebarWidth(): {
  width: number;
  setWidth: (px: number) => void;
} {
  // The stored value is the user's PREFERENCE, clamped only to the selectable
  // range. The width on screen is derived from it against the viewport, so a
  // narrow window cannot overwrite the preference and a later resize restores
  // the width the user chose.
  const [preference, setPreference] = useState(readSidebarWidthPreference);
  const [viewport, setViewport] = useState(() => window.innerWidth);

  const width = clampSidebarWidth(preference, viewport);

  const setWidth = useCallback((px: number) => {
    const next = clampSidebarWidthPreference(px);
    setPreference(next);
    // Persist the preference, not the width the current window happened to
    // show: the next load must restore what the user chose.
    writeSidebarWidth(next);
  }, []);

  // The window size is a dependency of the shown width. Keeping it in state is
  // what makes a resize repaint with a tighter clamp without changing the
  // stored preference.
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, setWidth };
}
